const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const authenticateJWT = require('./middleware');
const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Input validation helper
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Register handler
const register = async (req, res) => {
  const { name, email, password, location, children } = req.body;
  console.log('Registration request:', { name, email, location, children });
  
  let connection;
  try {
    // Input validation
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Check for existing email
    const [existingUser] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Extract children data
    const numberOfChildren = children?.numberOfChildren || 0;
    const childrenDetails = children?.childrenDetails || [];

    // Insert user
    const [userResult] = await connection.query(
      'INSERT INTO users (name, email, password, number_of_children) VALUES (?, ?, ?, ?)',
      [name, email, hashedPassword, numberOfChildren]
    );
    
    const userId = userResult.insertId;

    // Insert children if provided
    if (numberOfChildren > 0 && Array.isArray(childrenDetails) && childrenDetails.length > 0) {
      const childrenValues = childrenDetails.map(child => [
        userId,
        child.nickname,
        child.date_of_birth
      ]);
      
      await connection.query(
        'INSERT INTO children (user_id, nickname, date_of_birth) VALUES ?',
        [childrenValues]
      );
    }

    // Insert location if provided
    if (location && location.latitude && location.longitude) {
      await connection.query(
        'INSERT INTO locations (user_id, lat, `long`) VALUES (?, ?, ?)',
        [userId, location.latitude, location.longitude]
      );
    }

    // Generate access token (1 hour expiry)
    const accessToken = jwt.sign(
      { id: userId },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '1h' }
    );

    // Generate refresh token (30 days expiry)
    const refreshToken = jwt.sign(
      { id: userId },
      process.env.REFRESH_SECRET || 'your_refresh_secret',
      { expiresIn: '30d' }
    );

    // Store refresh token in database
    await connection.query(
      'UPDATE users SET refresh_token = ? WHERE id = ?',
      [refreshToken, userId]
    );

    await connection.commit();
    
    console.log('Registration successful for userId:', userId);

    return res.status(201).json({
      message: 'User registered successfully!',
      userId,
      access_token: accessToken,
      refresh_token: refreshToken,
      user: {
        id: userId,
        name,
        email,
        number_of_children: numberOfChildren
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    if (connection) {
      await connection.rollback();
    }

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already registered' });
    }

    return res.status(500).json({
      error: 'Registration failed. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};
// Login handler
const login = async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    
    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password);
    
    if (!isPasswordValid) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.number_of_children > 0) {
      const [children] = await pool.query(
        'SELECT id, nickname, date_of_birth FROM children WHERE user_id = ? ORDER BY date_of_birth',
        [user.id]
      );
      user.children = children;
    } else {
      user.children = [];
    }

    // Generate access token (shorter expiry)
    const accessToken = jwt.sign(
      { id: user.id }, 
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '1h' }  // Shorter expiry for access token
    );

    // Generate refresh token (longer expiry)
    const refreshToken = jwt.sign(
      { id: user.id }, 
      process.env.REFRESH_SECRET || 'your_refresh_secret',
      { expiresIn: '30d' }  // Much longer expiry for refresh token
    );

    // Store refresh token in database
    await pool.query(
      'UPDATE users SET refresh_token = ? WHERE id = ?',
      [refreshToken, user.id]
    );
    
    delete user.password;
    delete user.refresh_token;
    
    return res.status(200).json({ 
      access_token: accessToken,
      refresh_token: refreshToken,
      user
    });
    
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// Fixed JWT verification endpoint
const authenticateJWTReval = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ message: 'Authorization header missing' });
    }

    const [bearer, token] = authHeader.split(' ');

    if (bearer !== 'Bearer' || !token) {
      return res.status(401).json({ message: 'Invalid authorization format' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
    
    // Get user data
    const [rows] = await pool.query('SELECT id, name, email, number_of_children FROM users WHERE id = ?', [decoded.id]);
    
    if (rows.length === 0) {
      return res.status(401).json({ message: 'User not found' });
    }

    return res.status(200).json({ 
      user: rows[0],
      token: token
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        message: 'Token expired',
        code: 'TOKEN_EXPIRED'
      });
    }
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// New refresh token endpoint
const refreshAccessToken = async (req, res) => {
  const { refresh_token } = req.body;
  
  if (!refresh_token) {
    return res.status(400).json({ message: 'Refresh token is required' });
  }

  try {
    // Verify refresh token
    const decoded = jwt.verify(refresh_token, process.env.REFRESH_SECRET || 'your_refresh_secret');
    
    // Check if refresh token exists in database
    const [rows] = await pool.query(
      'SELECT id FROM users WHERE id = ? AND refresh_token = ?',
      [decoded.id, refresh_token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'Invalid refresh token' });
    }

    // Generate new access token
    const newAccessToken = jwt.sign(
      { id: decoded.id },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '1h' }
    );

    return res.status(200).json({
      access_token: newAccessToken
    });

  } catch (error) {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }
};

const requestPasswordReset = async (req, res) => {
  const { email } = req.body;
  
  try {
    // Check if user exists
    const [users] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    
    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedResetToken = await bcrypt.hash(resetToken, 12);
    
    // Set token expiration (1 hour from now)
    const expiryDate = new Date(Date.now() + 3600000);

    // Save reset token and expiry in database
    await pool.query(
      'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE email = ?',
      [hashedResetToken, expiryDate, email]
    );

    // Create email transporter
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Reset link (update with your frontend URL)
    // In requestPasswordReset function
const androidDeepLink = `intent://reset-password/${resetToken}#Intent;scheme=talkaroundtown;package=com.talk_around_town_trail;end`;
const iosDeepLink = `talkaroundtown://reset-password/${resetToken}`;
const webFallbackLink = `http://68.183.102.75:1337/reset-password/${resetToken}`;

await transporter.sendMail({
  from: process.env.EMAIL_USER,
  to: email,
  subject: 'Password Reset Request',
  html: `
    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #4A90E2; text-align: center;">Password Reset Request</h1>
      <p style="color: #666; font-size: 16px;">You requested a password reset for your Talk Around Town account.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${androidDeepLink}" 
           style="background-color: #4A90E2; 
                  color: white; 
                  padding: 12px 30px; 
                  text-decoration: none; 
                  border-radius: 5px; 
                  display: inline-block;
                  font-size: 16px;
                  margin-bottom: 15px;">
          Reset Password (Android)
        </a>
        <br/>
        <a href="${iosDeepLink}" 
           style="background-color: #4A90E2; 
                  color: white; 
                  padding: 12px 30px; 
                  text-decoration: none; 
                  border-radius: 5px; 
                  display: inline-block;
                  font-size: 16px;">
          Reset Password (iOS)
        </a>
        <p style="margin-top: 20px; color: #666;">Or copy and paste this code in the app:</p>
        <p style="color: #4A90E2; font-size: 18px; font-family: monospace; background: #f5f5f5; padding: 10px; border-radius: 5px;">${resetToken}</p>
      </div>
      <p style="color: #666; font-size: 14px;">This code will expire in 1 hour.</p>
      <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
      <p style="color: #999; font-size: 12px;">For security, this code will only work once.</p>
    </div>
  `
});

    res.status(200).json({ 
      message: 'Password reset instructions sent to email',
      success: true 
    });

  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ 
      message: 'Error processing password reset request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const resetPassword = async (req, res) => {
  const { token, newPassword } = req.body;
  
  try {
    // Find user with valid reset token
    const [users] = await pool.query(
      'SELECT id, email, reset_token, reset_token_expires FROM users WHERE reset_token_expires > NOW()'
    );

    const user = users.find(async (user) => {
      if (!user.reset_token) return false;
      return await bcrypt.compare(token, user.reset_token);
    });
    
    // To this:
    let foundUser = null;
    for (const user of users) {
      if (!user.reset_token) continue;
      const isMatch = await bcrypt.compare(token, user.reset_token);
      if (isMatch) {
        foundUser = user;
        break;
      }
    }
    
    if (!foundUser) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }
    
    // Use foundUser instead of user for the rest of the function
    const hashedPassword = await bcrypt.hash(newPassword, 12);
    
    await pool.query(
      'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
      [hashedPassword, foundUser.id]
    );

    res.status(200).json({ 
      message: 'Password reset successful',
      success: true 
    });

  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ 
      message: 'Error resetting password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Modified logout to handle refresh tokens
const logout = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const [bearer, token] = authHeader.split(' ');
      if (bearer === 'Bearer' && token) {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
          // Clear refresh token in database
          await pool.query(
            'UPDATE users SET refresh_token = NULL WHERE id = ?',
            [decoded.id]
          );
        } catch (error) {
          // Token verification failed, but we'll still send success response
          console.error('Logout token verification failed:', error);
        }
      }
    }
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
};


// Token management
const token = async (req, res) => {
  const user_id = req.user.id;
  const { token, platform } = req.body;
  
  try {
    let query;
    let params;

    if (platform.toLowerCase() === 'ios') {
      query = 'UPDATE users SET ios_token = ?, android_token = NULL WHERE id = ?';
      params = [token, user_id];
    } else if (platform.toLowerCase() === 'android') {
      query = 'UPDATE users SET android_token = ?, ios_token = NULL WHERE id = ?';
      params = [token, user_id];
    } else {
      return res.status(400).json({ 
        error: `Invalid platform: ${platform}. Must be "ios" or "android"` 
      });
    }

    const [result] = await pool.query(query, params);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [verification] = await pool.query(
      'SELECT android_token, ios_token FROM users WHERE id = ?',
      [user_id]
    );
    
    return res.status(200).json({ 
      message: `${platform} token updated successfully!`,
      platform: platform,
      currentTokens: verification[0]
    });
  } catch (error) {
    console.error('Error updating token:', error);
    return res.status(500).json({ error: error.message });
  }
};
// Add this to your auth.js or create a new route file

const testEmail = async (req, res) => {
  try {
    // Create email transporter
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    // Test email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Sending to self for testing
      subject: 'Test Email from TAT App',
      html: `
        <h1>Test Email</h1>
        <p>This is a test email to verify the email configuration is working.</p>
        <p>Time sent: ${new Date().toLocaleString()}</p>
      `
    });

    res.status(200).json({ 
      message: 'Test email sent successfully',
      success: true 
    });

  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ 
      message: 'Error sending test email',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};
// Get device tokens
const getDeviceTokens = async (req, res) => {
  const user_id = req.user.id;
  
  try {
    const [rows] = await pool.query(
      'SELECT android_token, ios_token FROM users WHERE id = ?', 
      [user_id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    return res.status(200).json({ 
      android_token: rows[0].android_token,
      ios_token: rows[0].ios_token
    });
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Routes
router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.post('/verify', authenticateJWTReval);
router.post('/refresh', refreshAccessToken);
router.post('/token', authenticateJWT, token);
router.get('/device-tokens', authenticateJWT, getDeviceTokens);
router.post('/request-reset', requestPasswordReset);
router.post('/reset-password', resetPassword);
router.post('/test-email', testEmail);

module.exports = router;
