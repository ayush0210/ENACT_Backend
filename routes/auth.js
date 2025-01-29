const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const authenticateJWT = require('./middleware');
const express = require('express');
const router = express.Router();

// Input validation helper
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Register handler
const register = async (req, res) => {
  const { name, email, password, location, children } = req.body;
  console.log('Registration request:', { name, email, location, children }); // Debug log
  
  let connection;
  try {
    // Input validation with specific error messages
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

    // Check if email already exists
    const [existingUser] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Extract children data if provided
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

    await connection.commit();
    
    const token = jwt.sign(
      { id: userId }, 
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '12h' }
    );
    
    console.log('Registration successful for userId:', userId); // Debug log

    return res.status(201).json({ 
      message: 'User registered successfully!',
      userId,
      access_token: token
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    if (connection) {
      await connection.rollback();
    }

    // More specific error messages based on the error type
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

    // Updated this section to include more child information
    if (user.number_of_children > 0) {
      const [children] = await pool.query(
        'SELECT id, nickname, date_of_birth FROM children WHERE user_id = ? ORDER BY date_of_birth',
        [user.id]
      );
      user.children = children;
    } else {
      user.children = [];
    }

    const token = jwt.sign(
      { id: user.id }, 
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '12h' }
    );
    
    delete user.password;
    
    return res.status(200).json({ 
      access_token: token, 
      user
    });
    
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// JWT revalidation
const authenticateJWTReval = async (req, res) => {
  const authHeader = req.body.headers?.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ message: 'Authorization header missing' });
  }

  const [bearer, jwtToken] = authHeader.split(' ');

  if (bearer !== 'Bearer' || !jwtToken) {
    return res.status(401).json({ message: 'Invalid authorization token' });
  }

  try {
    const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET || 'your_jwt_secret');
    return res.status(200).json({ user: decoded });
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' });
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
router.post('/logout', (req, res) => res.send('Logged out'));
router.post('/verify', authenticateJWTReval);
router.post('/token', authenticateJWT, token);
router.get('/device-tokens', authenticateJWT, getDeviceTokens);

module.exports = router;