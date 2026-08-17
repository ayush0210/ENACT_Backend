import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';

const router = express.Router();

// Ensure the issue_reports table exists on first use
async function ensureTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS issue_reports (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            description TEXT NOT NULL,
            device_model VARCHAR(255),
            os_name VARCHAR(50),
            os_version VARCHAR(50),
            app_version VARCHAR(50),
            location_permission VARCHAR(50),
            notification_permission VARCHAR(50),
            logs TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_id (user_id),
            INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

// POST /api/issue-reports — authenticated users submit a bug/issue report
router.post('/', authenticateJWT, async (req, res) => {
    try {
        await ensureTable();

        const user_id = req.user.id;
        const {
            description,
            device_model,
            os_name,
            os_version,
            app_version,
            location_permission,
            notification_permission,
            logs,
        } = req.body;

        if (!description || !description.trim()) {
            return res.status(400).json({ error: 'Description is required' });
        }

        if (description.trim().length > 2000) {
            return res.status(400).json({ error: 'Description must be under 2000 characters' });
        }

        const [result] = await pool.query(
            `INSERT INTO issue_reports
             (user_id, description, device_model, os_name, os_version, app_version,
              location_permission, notification_permission, logs)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                user_id,
                description.trim(),
                device_model || null,
                os_name || null,
                os_version || null,
                app_version || null,
                location_permission || null,
                notification_permission || null,
                logs ? JSON.stringify(logs) : null,
            ],
        );

        console.log(`[IssueReport] New report #${result.insertId} from user ${user_id}`);

        return res.status(201).json({
            message: 'Report submitted successfully. Thank you for your feedback!',
            reportId: result.insertId,
        });
    } catch (error) {
        console.error('[IssueReport] Error saving report:', error);
        return res.status(500).json({ error: 'Failed to submit report. Please try again.' });
    }
});

export default router;
