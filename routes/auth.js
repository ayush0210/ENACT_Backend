import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';
import express from 'express';
import nodemailer from 'nodemailer';
import sgMail from '@sendgrid/mail';

const router = express.Router();

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Configure nodemailer as fallback (Gmail SMTP)
const gmailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SENDGRID_FROM, // Use same email
        pass: process.env.GMAIL_APP_PASSWORD, // Add this to .env
    },
});

// Rate limiting for password resets (prevent quota exhaustion)
const resetRateLimiter = new Map();
const RESET_COOLDOWN = 60000; // 1 minute between reset requests per email

// Input validation helper
const validateEmail = email => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// Valid caregiver types
const CAREGIVER_TYPES = ['parent', 'grandparent', 'guardian', 'nanny', 'other_family', 'other'];

// Register handler
const register = async (req, res) => {
    const { name, email, password, location, children, caregiverType } = req.body;
    console.log('Registration request:', { name, email, location, children, caregiverType });

    let connection;
    try {
        // Input validation
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
            return res
                .status(400)
                .json({ error: 'Password must be at least 8 characters long' });
        }
        if (caregiverType && !CAREGIVER_TYPES.includes(caregiverType)) {
            return res
                .status(400)
                .json({ error: `Invalid caregiver type. Must be one of: ${CAREGIVER_TYPES.join(', ')}` });
        }

        // Check for existing email
        const [existingUser] = await pool.query(
            'SELECT id FROM users WHERE email = ?',
            [email],
        );
        if (existingUser.length > 0) {
            return res.status(409).json({ error: 'Email already registered' });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const hashedPassword = await bcrypt.hash(password, 12);

        // Extract children data
        const numberOfChildren = children?.numberOfChildren || 0;
        const childrenDetails = children?.childrenDetails || [];

        // Use email username as default name if not provided
        const userName = name || email.split('@')[0];

        // Insert user
        const [userResult] = await connection.query(
            'INSERT INTO users (name, email, password, number_of_children, caregiver_type) VALUES (?, ?, ?, ?, ?)',
            [userName, email, hashedPassword, numberOfChildren, caregiverType || null],
        );

        const userId = userResult.insertId;

        // Insert children if provided
        if (
            numberOfChildren > 0 &&
            Array.isArray(childrenDetails) &&
            childrenDetails.length > 0
        ) {
            // Validate age values
            for (const child of childrenDetails) {
                if (!child.age || child.age < 1 || child.age > 5 || !Number.isInteger(child.age)) {
                    await connection.rollback();
                    return res.status(400).json({ error: 'Child age must be an integer between 1 and 5' });
                }
            }

            const childrenValues = childrenDetails.map(child => {
                // Calculate approximate date of birth from age
                const today = new Date();
                const birthYear = today.getFullYear() - child.age;
                const dateOfBirth = new Date(birthYear, today.getMonth(), today.getDate());
                const formattedDOB = dateOfBirth.toISOString().split('T')[0]; // YYYY-MM-DD

                return [
                    userId,
                    child.nickname,
                    child.age,
                    formattedDOB
                ];
            });

            await connection.query(
                'INSERT INTO children (user_id, nickname, age, date_of_birth) VALUES ?',
                [childrenValues],
            );
        }

        // Insert location if provided
        if (location && location.latitude && location.longitude) {
            await connection.query(
                'INSERT INTO locations (user_id, lat, `long`) VALUES (?, ?, ?)',
                [userId, location.latitude, location.longitude],
            );
        }

        // Generate access token (1 hour expiry)
        const accessToken = jwt.sign(
            { id: userId },
            process.env.JWT_SECRET || 'your_jwt_secret',
            { expiresIn: '7d' },
        );

        // Generate refresh token (30 days expiry)
        const refreshToken = jwt.sign(
            { id: userId },
            process.env.REFRESH_SECRET || 'your_refresh_secret',
            { expiresIn: '30d' },
        );

        // Store refresh token in database
        await connection.query(
            'UPDATE users SET refresh_token = ? WHERE id = ?',
            [refreshToken, userId],
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
                name: userName,
                email,
                number_of_children: numberOfChildren,
            },
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
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
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
        // Get user with isAdmin flag included
        const [rows] = await pool.query(
            'SELECT *, isAdmin FROM users WHERE email = ?',
            [email],
        );

        if (rows.length === 0) {
            return res
                .status(401)
                .json({ message: 'Invalid email or password' });
        }

        const user = rows[0];
        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res
                .status(401)
                .json({ message: 'Invalid email or password' });
        }

        if (user.number_of_children > 0) {
            const [children] = await pool.query(
                'SELECT id, nickname, age FROM children WHERE user_id = ? ORDER BY age DESC',
                [user.id],
            );
            user.children = children;
        } else {
            user.children = [];
        }

        // Generate access token with isAdmin included
        const accessToken = jwt.sign(
            {
                id: user.id,
                isAdmin: user.isAdmin || false, // Include admin status in token
            },
            process.env.JWT_SECRET || 'your_jwt_secret',
            { expiresIn: '7d' },
        );

        // Generate refresh token (longer expiry)
        const refreshToken = jwt.sign(
            {
                id: user.id,
                isAdmin: user.isAdmin || false, // Include admin status in refresh token too
            },
            process.env.REFRESH_SECRET || 'your_refresh_secret',
            { expiresIn: '30d' },
        );

        // Store refresh token in database
        await pool.query('UPDATE users SET refresh_token = ? WHERE id = ?', [
            refreshToken,
            user.id,
        ]);

        delete user.password;
        delete user.refresh_token;

        return res.status(200).json({
            access_token: accessToken,
            refresh_token: refreshToken,
            isAdmin: user.isAdmin || false, // Include in response
            user,
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
            return res
                .status(401)
                .json({ message: 'Authorization header missing' });
        }

        const [bearer, token] = authHeader.split(' ');

        if (bearer !== 'Bearer' || !token) {
            return res
                .status(401)
                .json({ message: 'Invalid authorization format' });
        }

        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET || 'your_jwt_secret',
        );

        // Get user data
        const [rows] = await pool.query(
            'SELECT id, name, email, number_of_children FROM users WHERE id = ?',
            [decoded.id],
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'User not found' });
        }

        return res.status(200).json({
            user: rows[0],
            token: token,
        });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                message: 'Token expired',
                code: 'TOKEN_EXPIRED',
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
        const decoded = jwt.verify(
            refresh_token,
            process.env.REFRESH_SECRET || 'your_refresh_secret',
        );

        // Check if refresh token exists in database
        const [rows] = await pool.query(
            'SELECT id, isAdmin FROM users WHERE id = ? AND refresh_token = ?',
            [decoded.id, refresh_token],
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Invalid refresh token' });
        }

        const user = rows[0];

        // Generate new access token with isAdmin included
        const newAccessToken = jwt.sign(
            {
                id: decoded.id,
                isAdmin: user.isAdmin || false,
            },
            process.env.JWT_SECRET || 'your_jwt_secret',
            { expiresIn: '7d' },
        );

        return res.status(200).json({
            access_token: newAccessToken,
        });
    } catch (error) {
        return res.status(401).json({ message: 'Invalid refresh token' });
    }
};

const requestPasswordReset = async (req, res) => {
    const { email } = req.body;

    try {
        // Rate limiting check
        const lastRequest = resetRateLimiter.get(email);
        if (lastRequest && Date.now() - lastRequest < RESET_COOLDOWN) {
            const waitTime = Math.ceil((RESET_COOLDOWN - (Date.now() - lastRequest)) / 1000);
            return res.status(429).json({
                message: `Please wait ${waitTime} seconds before requesting another reset`,
                cooldown: true
            });
        }

        // Check if user exists
        const [users] = await pool.query(
            'SELECT id FROM users WHERE email = ?',
            [email],
        );
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
            [hashedResetToken, expiryDate, email],
        );

        const html = `
      <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #4A90E2; text-align: center;">Password Reset Request</h1>
        <p style="color: #666; font-size: 16px;">You requested a password reset for your Talk Around Town account.</p>

        <div style="text-align: center; margin: 40px 0;">
          <p style="color: #333; font-size: 16px; margin-bottom: 10px;">Copy and paste this code in the app:</p>
          <div style="background: #f5f5f5; border: 2px solid #4A90E2; border-radius: 8px; padding: 20px; margin: 20px 0;">
            <p style="color: #4A90E2; font-size: 24px; font-weight: bold; font-family: monospace; margin: 0; letter-spacing: 2px;">${resetToken}</p>
          </div>
        </div>

        <div style="background: #f9f9f9; border-left: 4px solid #4A90E2; padding: 15px; margin: 20px 0;">
          <p style="color: #666; font-size: 14px; margin: 0;"><strong>How to reset your password:</strong></p>
          <ol style="color: #666; font-size: 14px; margin: 10px 0 0 0; padding-left: 20px;">
            <li>Open the Talk Around Town app</li>
            <li>Go to the password reset screen</li>
            <li>Paste the code above</li>
            <li>Enter your new password</li>
          </ol>
        </div>

        <p style="color: #666; font-size: 14px; margin-top: 30px;">⏱️ This code will expire in <strong>1 hour</strong>.</p>
        <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
        <p style="color: #999; font-size: 12px;">For security, this code will only work once.</p>
      </div>
    `;

        let emailSent = false;
        let provider = 'unknown';

        // Try SendGrid first
        try {
            console.log('📧 Attempting to send via SendGrid...');
            await sgMail.send({
                to: email,
                from: process.env.SENDGRID_FROM,
                subject: 'Password Reset Request',
                html,
            });
            emailSent = true;
            provider = 'SendGrid';
            console.log('✅ Email sent via SendGrid');
        } catch (sgError) {
            const sgErr = sgError?.response?.body?.errors?.map(e => e.message).join('; ');
            console.warn('⚠️  SendGrid failed:', sgErr || sgError.message);

            // Fallback to nodemailer with Gmail
            try {
                console.log('📧 Attempting fallback via Gmail SMTP...');
                await gmailTransporter.sendMail({
                    from: process.env.SENDGRID_FROM,
                    to: email,
                    subject: 'Password Reset Request',
                    html,
                });
                emailSent = true;
                provider = 'Gmail SMTP';
                console.log('✅ Email sent via Gmail SMTP (fallback)');
            } catch (gmailError) {
                console.error('❌ Gmail SMTP also failed:', gmailError.message);
                throw new Error('All email providers failed');
            }
        }

        if (emailSent) {
            // Update rate limiter
            resetRateLimiter.set(email, Date.now());

            // Clean up old rate limit entries (older than 2 minutes)
            for (const [key, timestamp] of resetRateLimiter.entries()) {
                if (Date.now() - timestamp > 120000) {
                    resetRateLimiter.delete(key);
                }
            }

            return res.status(200).json({
                message: 'Password reset instructions sent to email',
                success: true,
                provider, // Include which provider worked
            });
        }

        throw new Error('Failed to send email');

    } catch (error) {
        console.error('Password reset request error:', error.message);
        return res.status(500).json({
            message: 'Error sending password reset email. Please try again later.',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        });
    }
};

const resetPassword = async (req, res) => {
    const { token, newPassword } = req.body;

    try {
        // Find user with valid reset token
        const [users] = await pool.query(
            'SELECT id, email, reset_token, reset_token_expires FROM users WHERE reset_token_expires > NOW()',
        );

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
            return res
                .status(400)
                .json({ message: 'Invalid or expired reset token' });
        }

        // Use foundUser instead of user for the rest of the function
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        await pool.query(
            'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
            [hashedPassword, foundUser.id],
        );

        res.status(200).json({
            message: 'Password reset successful',
            success: true,
        });
    } catch (error) {
        console.error('Password reset error:', error);
        res.status(500).json({
            message: 'Error resetting password',
            error:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
};

const deleteAccount = async (req, res) => {
    const userId = req.user.id; // User ID from JWT token

    let connection;
    try {
        console.log(`Processing account deletion for user ID: ${userId}`);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Delete children records
        const [childrenResult] = await connection.query(
            'DELETE FROM children WHERE user_id = ?',
            [userId],
        );
        console.log(`Deleted ${childrenResult.affectedRows} children records`);

        // Delete location records
        const [locationResult] = await connection.query(
            'DELETE FROM locations WHERE user_id = ?',
            [userId],
        );
        console.log(`Deleted ${locationResult.affectedRows} location records`);

        // Delete user's app sessions
        const [sessionsResult] = await connection.query(
            'DELETE FROM app_sessions WHERE user_id = ?',
            [userId],
        );
        console.log(`Deleted ${sessionsResult.affectedRows} session records`);

        // Delete any notifications
        const [notificationsResult] = await connection.query(
            'DELETE FROM notifications WHERE user_id = ?',
            [userId],
        );
        console.log(
            `Deleted ${notificationsResult.affectedRows} notification records`,
        );

        // Delete tips related to this user (if applicable)
        try {
            const [tipsResult] = await connection.query(
                'DELETE FROM tips WHERE user_id = ?',
                [userId],
            );
            console.log(`Deleted ${tipsResult.affectedRows} tip records`);
        } catch (error) {
            console.log(
                'No tips records deleted - table might not have user_id column',
            );
        }

        // Finally delete the user
        const [userResult] = await connection.query(
            'DELETE FROM users WHERE id = ?',
            [userId],
        );

        if (userResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'User not found' });
        }

        await connection.commit();
        console.log(`Successfully deleted user account with ID: ${userId}`);

        return res.status(200).json({
            message: 'Account deleted successfully',
            success: true,
        });
    } catch (error) {
        console.error('Error deleting account:', error);

        if (connection) {
            await connection.rollback();
        }

        return res.status(500).json({
            error: 'Failed to delete account. Please try again.',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

const changePassword = async (req, res) => {
    const userId = req.user.id; // From JWT authentication
    const { currentPassword, newPassword } = req.body;

    // Validate inputs
    if (!currentPassword || !newPassword) {
        return res
            .status(400)
            .json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 8) {
        return res
            .status(400)
            .json({ error: 'New password must be at least 8 characters long' });
    }

    let connection;
    try {
        // Get user's current password hash from database
        const [users] = await pool.query(
            'SELECT password FROM users WHERE id = ?',
            [userId],
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = users[0];

        // Verify current password
        const isPasswordValid = await bcrypt.compare(
            currentPassword,
            user.password,
        );

        if (!isPasswordValid) {
            return res
                .status(401)
                .json({ error: 'Current password is incorrect' });
        }

        // Hash new password
        const hashedNewPassword = await bcrypt.hash(newPassword, 12);

        // Begin transaction to update password
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Update password in database
        await connection.query('UPDATE users SET password = ? WHERE id = ?', [
            hashedNewPassword,
            userId,
        ]);

        await connection.commit();

        return res.status(200).json({
            message: 'Password changed successfully',
            success: true,
        });
    } catch (error) {
        console.error('Change password error:', error);

        if (connection) {
            await connection.rollback();
        }

        return res.status(500).json({
            error: 'Failed to change password. Please try again.',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    } finally {
        if (connection) {
            connection.release();
        }
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
                    const decoded = jwt.verify(
                        token,
                        process.env.JWT_SECRET || 'your_jwt_secret',
                    );
                    // Clear refresh token in database
                    await pool.query(
                        'UPDATE users SET refresh_token = NULL WHERE id = ?',
                        [decoded.id],
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
            query =
                'UPDATE users SET ios_token = ?, android_token = NULL WHERE id = ?';
            params = [token, user_id];
        } else if (platform.toLowerCase() === 'android') {
            query =
                'UPDATE users SET android_token = ?, ios_token = NULL WHERE id = ?';
            params = [token, user_id];
        } else {
            return res.status(400).json({
                error: `Invalid platform: ${platform}. Must be "ios" or "android"`,
            });
        }

        const [result] = await pool.query(query, params);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const [verification] = await pool.query(
            'SELECT android_token, ios_token FROM users WHERE id = ?',
            [user_id],
        );

        return res.status(200).json({
            message: `${platform} token updated successfully!`,
            platform: platform,
            currentTokens: verification[0],
        });
    } catch (error) {
        console.error('Error updating token:', error);
        return res.status(500).json({ error: error.message });
    }
};

const testEmail = async (req, res) => {
    try {
        // Create email transporter
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
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
      `,
        });

        res.status(200).json({
            message: 'Test email sent successfully',
            success: true,
        });
    } catch (error) {
        console.error('Test email error:', error);
        res.status(500).json({
            message: 'Error sending test email',
            error:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
};

// Get device tokens
const getDeviceTokens = async (req, res) => {
    const user_id = req.user.id;

    try {
        const [rows] = await pool.query(
            'SELECT android_token, ios_token FROM users WHERE id = ?',
            [user_id],
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.status(200).json({
            android_token: rows[0].android_token,
            ios_token: rows[0].ios_token,
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
router.delete('/delete-account', authenticateJWT, deleteAccount);
router.post('/change-password', authenticateJWT, changePassword);

export default router;