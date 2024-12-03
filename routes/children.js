const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const authenticateJWT = require('./middleware');

// Get children information for a user
router.get('/children', authenticateJWT, async (req, res) => {
  try {
    const user_id = req.user.id;
    
    const [rows] = await pool.query(
      `SELECT id, nickname, date_of_birth
       FROM children
       WHERE user_id = ?`,
      [user_id]
    );

    return res.status(200).json({
      success: true,
      children: rows
    });
  } catch (error) {
    console.error('Error fetching children:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch children information'
    });
  }
});

// Add new child
router.post('/children', authenticateJWT, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { nickname, date_of_birth } = req.body;
    const user_id = req.user.id;

    // Start transaction
    await connection.beginTransaction();

    // Insert new child
    const [result] = await connection.query(
      `INSERT INTO children (user_id, nickname, date_of_birth)
       VALUES (?, ?, ?)`,
      [user_id, nickname, date_of_birth]
    );

    // Update user's number_of_children
    await connection.query(
      `UPDATE users 
       SET number_of_children = number_of_children + 1 
       WHERE id = ?`,
      [user_id]
    );

    // Commit transaction
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Child added successfully',
      childId: result.insertId
    });
  } catch (error) {
    await connection.rollback();
    console.error('Error adding child:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to add child'
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

    // Start transaction
    await connection.beginTransaction();

    for (const child of children) {
      // Verify child belongs to user
      const [childRows] = await connection.query(
        'SELECT id FROM children WHERE id = ? AND user_id = ?',
        [child.id, user_id]
      );

      if (childRows.length === 0) {
        await connection.rollback();
        return res.status(403).json({
          success: false,
          message: 'Unauthorized access to child record'
        });
      }

      // Update child information
      await connection.query(
        `UPDATE children 
         SET nickname = ?, 
             date_of_birth = ? 
         WHERE id = ? AND user_id = ?`,
        [child.nickname, child.date_of_birth, child.id, user_id]
      );
    }

    // Commit transaction
    await connection.commit();

    return res.status(200).json({
      success: true,
      message: 'Children information updated successfully'
    });

  } catch (error) {
    await connection.rollback();
    console.error('Error updating children:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update children information'
    });
  } finally {
    connection.release();
  }
});

module.exports = router;