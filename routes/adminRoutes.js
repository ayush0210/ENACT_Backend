import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT, authorizeAdmin } from './middleware.js';

const router = express.Router();

// Get all users (admin only)
router.get('/users', authenticateJWT, authorizeAdmin, async (req, res) => {
    try {
        const [users] = await pool.query(`
            SELECT id, name, email, created_at, isAdmin, number_of_children
            FROM users
            ORDER BY created_at DESC
        `);
        
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user details (admin only)
router.get('/users/:userId', authenticateJWT, authorizeAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Get user data
        const [users] = await pool.query(
            'SELECT id, name, email, created_at, isAdmin, number_of_children FROM users WHERE id = ?',
            [userId]
        );
        
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get user's children
        const [children] = await pool.query(
            'SELECT id, nickname, age FROM children WHERE user_id = ?',
            [userId]
        );
        
        // Get user's activity
        const [activity] = await pool.query(
            'SELECT * FROM app_sessions WHERE user_id = ? ORDER BY start_time DESC LIMIT 10',
            [userId]
        );
        
        // Get user's locations
        const [locations] = await pool.query(
            'SELECT * FROM locations WHERE user_id = ?',
            [userId]
        );
        
        res.status(200).json({
            user: users[0],
            children,
            activity,
            locations
        });
        
    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Toggle admin status (admin only)
router.patch('/users/:userId/toggle-admin', authenticateJWT, authorizeAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Check if user exists
        const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
        
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const user = users[0];
        const newAdminStatus = !user.isAdmin;
        
        // Prevent removing admin status from the last admin
        if (!newAdminStatus) {
            const [adminCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE isAdmin = true');
            if (adminCount[0].count <= 1) {
                return res.status(400).json({ error: 'Cannot remove admin status from the last admin user' });
            }
        }
        
        // Update user's admin status
        await pool.query('UPDATE users SET isAdmin = ? WHERE id = ?', [newAdminStatus, userId]);
        
        res.status(200).json({ 
            id: user.id,
            name: user.name,
            email: user.email,
            isAdmin: newAdminStatus,
            message: `Admin status ${newAdminStatus ? 'granted to' : 'revoked from'} user`
        });
        
    } catch (error) {
        console.error('Error toggling admin status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get dashboard summary (admin only)
router.get('/dashboard/summary', authenticateJWT, authorizeAdmin, async (req, res) => {
    try {
        // Get user count
        const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
        
        // Get children count
        const [childrenCount] = await pool.query('SELECT COUNT(*) as count FROM children');
        
        // Get locations count
        const [locationsCount] = await pool.query('SELECT COUNT(*) as count FROM locations');
        
        // Get notifications count
        const [notificationsCount] = await pool.query('SELECT COUNT(*) as count FROM notifications');
        
        // Get sessions count
        const [sessionsCount] = await pool.query('SELECT COUNT(*) as count FROM app_sessions');
        
        // Get recent users
        const [recentUsers] = await pool.query(`
            SELECT id, name, email, created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 5
        `);
        
        // Get recent notifications
        const [recentNotifications] = await pool.query(`
            SELECT n.*, u.name as user_name, l.name as location_name
            FROM notifications n
            JOIN users u ON n.user_id = u.id
            JOIN locations l ON n.loc_id = l.id
            ORDER BY n.timestamp DESC
            LIMIT 5
        `);
        
        res.status(200).json({
            counts: {
                users: userCount[0].count,
                children: childrenCount[0].count,
                locations: locationsCount[0].count,
                notifications: notificationsCount[0].count,
                sessions: sessionsCount[0].count
            },
            recent: {
                users: recentUsers,
                notifications: recentNotifications
            }
        });
        
    } catch (error) {
        console.error('Error fetching dashboard summary:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user registration timeline (admin only)
router.get('/dashboard/users-timeline', authenticateJWT, authorizeAdmin, async (req, res) => {
    try {
        const [timeline] = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as count
            FROM users
            GROUP BY DATE(created_at)
            ORDER BY date ASC
        `);
        
        res.status(200).json(timeline);
    } catch (error) {
        console.error('Error fetching user timeline:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;