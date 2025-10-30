import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT, authorizeAdmin } from './middleware.js';

const router = express.Router();

// Get dashboard summary data
router.get('/summary', authenticateJWT, async (req, res) => {
    try {
        // Get counts of main entities
        const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
        const [childrenCount] = await pool.query('SELECT COUNT(*) as count FROM children');
        const [locationsCount] = await pool.query('SELECT COUNT(*) as count FROM locations');
        const [notificationsCount] = await pool.query('SELECT COUNT(*) as count FROM notifications');
        const [sessionsCount] = await pool.query('SELECT COUNT(*) as count FROM app_sessions');
        const [tipsCount] = await pool.query('SELECT COUNT(*) as count FROM tips');
        
        return res.status(200).json({
            users: userCount[0].count,
            children: childrenCount[0].count,
            locations: locationsCount[0].count,
            notifications: notificationsCount[0].count,
            sessions: sessionsCount[0].count,
            tips: tipsCount[0].count
        });
    } catch (error) {
        console.error('Error fetching dashboard summary:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user registration stats
router.get('/users/timeline', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as count
            FROM users
            GROUP BY DATE(created_at)
            ORDER BY date ASC
            LIMIT 30
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching user timeline:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get children age distribution
router.get('/children/ages', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE()) as age,
                COUNT(*) as count
            FROM children
            GROUP BY age
            ORDER BY age ASC
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching children ages:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get location types
router.get('/locations/types', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                type,
                COUNT(*) as count
            FROM locations
            WHERE type IS NOT NULL
            GROUP BY type
            ORDER BY count DESC
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching location types:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get notification trends by time of day
router.get('/notifications/time', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                HOUR(timestamp) as hour,
                COUNT(*) as count
            FROM notifications
            GROUP BY HOUR(timestamp)
            ORDER BY hour ASC
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching notification time trends:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get top location usage
router.get('/locations/usage', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                l.name,
                COUNT(*) as notification_count
            FROM locations l
            LEFT JOIN notifications n ON l.id = n.loc_id
            GROUP BY l.id, l.name
            ORDER BY notification_count DESC
            LIMIT 10
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching location usage:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get users with the most children
router.get('/users/children', authenticateJWT, async (req, res) => {
    try {
        const [results] = await pool.query(`
            SELECT 
                u.id,
                u.name,
                u.email,
                COUNT(c.id) as child_count
            FROM users u
            LEFT JOIN children c ON u.id = c.user_id
            GROUP BY u.id
            ORDER BY child_count DESC
            LIMIT 10
        `);
        return res.status(200).json(results);
    } catch (error) {
        console.error('Error fetching users with most children:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

// Get recent user activity
router.get('/recent-activity', authenticateJWT, async (req, res) => {
    try {
        const [recentUsers] = await pool.query(`
            SELECT 
                id, 
                name, 
                email, 
                created_at
            FROM users
            ORDER BY created_at DESC
            LIMIT 5
        `);
        
        const [recentNotifications] = await pool.query(`
            SELECT 
                CONCAT(n.user_id, '-', n.loc_id) as id,
                n.timestamp,
                u.name as user_name,
                l.name as location_name
            FROM notifications n
            JOIN users u ON n.user_id = u.id
            JOIN locations l ON n.loc_id = l.id
            ORDER BY n.timestamp DESC
            LIMIT 5
        `);
        
        return res.status(200).json({
            recentUsers,
            recentNotifications
        });
    } catch (error) {
        console.error('Error fetching recent activity:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;