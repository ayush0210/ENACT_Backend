import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';

const router = express.Router();

// Get children information for a user
router.get('/children', authenticateJWT, async (req, res) => {
    try {
        const user_id = req.user.id;

        const [rows] = await pool.query(
            `SELECT id, nickname, age, date_of_birth
       FROM children
       WHERE user_id = ?`,
            [user_id],
        );

        return res.status(200).json({
            success: true,
            children: rows,
        });
    } catch (error) {
        console.error('Error fetching children:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch children information',
        });
    }
});

// Add new child
router.post('/children', authenticateJWT, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const { nickname, age, date_of_birth } = req.body;
        const user_id = req.user.id;

        // Validate age (must be integer 0-5; 0 = under 1 year)
        if (!Number.isInteger(age) || age < 0 || age > 5) {
            connection.release();
            return res.status(400).json({
                success: false,
                message: 'Child age must be an integer between 0 and 5',
            });
        }

        // Calculate date_of_birth from age if not provided
        const dob = date_of_birth || `${new Date().getFullYear() - age}-01-01`;

        // Start transaction
        await connection.beginTransaction();

        // Insert new child
        const [result] = await connection.query(
            `INSERT INTO children (user_id, nickname, age, date_of_birth)
       VALUES (?, ?, ?, ?)`,
            [user_id, nickname, age, dob],
        );

        // Update user's number_of_children
        await connection.query(
            `UPDATE users 
       SET number_of_children = number_of_children + 1 
       WHERE id = ?`,
            [user_id],
        );

        // Commit transaction
        await connection.commit();

        return res.status(201).json({
            success: true,
            message: 'Child added successfully',
            childId: result.insertId,
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error adding child:', error.message, error.code, error.sqlMessage);
        return res.status(500).json({
            success: false,
            message: 'Failed to add child',
            error: error.sqlMessage || error.message,
        });
    } finally {
        connection.release();
    }
});

// Update children information
router.post('/updateChildren', authenticateJWT, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const { children } = req.body;
        const user_id = req.user.id;

        // Validate all age values first (must be integer 0-5; 0 = under 1 year)
        for (const child of children) {
            if (!Number.isInteger(child.age) || child.age < 0 || child.age > 5) {
                connection.release();
                return res.status(400).json({
                    success: false,
                    message: 'Child age must be an integer between 0 and 5',
                });
            }
        }

        // Start transaction
        await connection.beginTransaction();

        for (const child of children) {
            // Verify child belongs to user
            const [childRows] = await connection.query(
                'SELECT id FROM children WHERE id = ? AND user_id = ?',
                [child.id, user_id],
            );

            if (childRows.length === 0) {
                await connection.rollback();
                return res.status(403).json({
                    success: false,
                    message: 'Unauthorized access to child record',
                });
            }

            // Update child information
            const updatedDob = `${new Date().getFullYear() - child.age}-01-01`;
            await connection.query(
                `UPDATE children
         SET nickname = ?,
             age = ?,
             date_of_birth = ?
         WHERE id = ? AND user_id = ?`,
                [child.nickname, child.age, updatedDob, child.id, user_id],
            );
        }

        // Commit transaction
        await connection.commit();

        return res.status(200).json({
            success: true,
            message: 'Children information updated successfully',
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error updating children:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update children information',
        });
    } finally {
        connection.release();
    }
});

// Delete a child
router.delete('/children/:id', authenticateJWT, async (req, res) => {
    const connection = await pool.getConnection();

    try {
        const childId = req.params.id;
        const user_id = req.user.id;

        console.table([childId, user_id]);

        // Start transaction
        await connection.beginTransaction();

        // Verify the child belongs to this user
        const [childRows] = await connection.query(
            'SELECT id FROM children WHERE id = ? AND user_id = ?',
            [childId, user_id],
        );

        if (childRows.length === 0) {
            await connection.rollback();
            return res.status(403).json({
                success: false,
                message: 'Unauthorized access or child not found',
            });
        }

        // Delete the child record
        await connection.query(
            'DELETE FROM children WHERE id = ? AND user_id = ?',
            [childId, user_id],
        );

        // Commit transaction
        await connection.commit();

        return res.status(200).json({
            success: true,
            message: 'Child deleted successfully',
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error deleting child:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete child',
        });
    } finally {
        connection.release();
    }
});

export default router;
