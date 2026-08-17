import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

router.get('/users', async (req, res) => {
    try {
        const [err, result] = await (pool.query('SELECT * FROM users;'));
        console.log(result);
        return res.json('Success');
    } catch (err) {
        console.log(err);
    }
});

router.get('/status', (req, res) => {
    res.send('Active here');
});

export default router;
