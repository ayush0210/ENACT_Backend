// sessions.js
const express = require('express');
const pool = require('../config/db');
const authenticateJWT = require('./middleware');
const router = express.Router();

// Start a new session
router.post('/start', authenticateJWT, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { device_info } = req.body;
    
    const [result] = await pool.query(
      'INSERT INTO app_sessions (user_id, device_info) VALUES (?, ?)',
      [user_id, device_info]
    );
    
    return res.status(201).json({ 
      session_id: result.insertId,
      message: 'Session start recorded successfully' 
    });
  } catch (error) {
    console.error('Error recording session start:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// End an existing session
router.post('/end', authenticateJWT, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { session_id } = req.body;
    
    const [result] = await pool.query(
      'UPDATE app_sessions SET end_time = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
      [session_id, user_id]
    );
    
    if (result.affectedRows > 0) {
      return res.status(200).json({ message: 'Session end recorded successfully' });
    } else {
      return res.status(404).json({ message: 'Session not found' });
    }
  } catch (error) {
    console.error('Error recording session end:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get session analytics
router.get('/analytics', authenticateJWT, async (req, res) => {
  try {
    const user_id = req.user.id;
    const { startDate, endDate } = req.query;
    
    let query = `
      SELECT 
        DATE(start_time) as date,
        COUNT(*) as session_count,
        SUM(TIMESTAMPDIFF(MINUTE, start_time, COALESCE(end_time, CURRENT_TIMESTAMP))) as total_minutes
      FROM app_sessions
      WHERE user_id = ?
    `;
    
    const params = [user_id];
    
    if (startDate) {
      query += ' AND start_time >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND start_time <= ?';
      params.push(endDate);
    }
    
    query += ' GROUP BY DATE(start_time) ORDER BY date DESC';
    
    const [rows] = await pool.query(query, params);
    
    return res.status(200).json(rows);
  } catch (error) {
    console.error('Error getting session analytics:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;