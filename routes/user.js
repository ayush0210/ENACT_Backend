import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

router.get('/users', async (req, res) => {
    try {
        const [result] = await pool.query('SELECT * FROM users;');
        console.log(result);
        return res.json({ message: 'Success', data: result });
    } catch (err) {
        console.log(err);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/status', (req, res) => {
    res.send('Active here');
});

export default router;