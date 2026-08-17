import pool from '../config/db.js';
import { SUPPORTED_ACTIVITIES } from './supportedActivities.js';

let cache = [];
let cachedAt = 0;
const TTL = 5 * 60 * 1000; // 5 minutes

export async function getApprovedActivities() {
    if (Date.now() - cachedAt < TTL) return cache;
    const [rows] = await pool.query('SELECT name FROM pending_activities WHERE status = ?', ['approved']);
    const dbApproved = rows.map(r => r.name);
    // Merge built-in supported activities with admin-approved custom ones
    cache = [...new Set([...SUPPORTED_ACTIVITIES, ...dbApproved])];
    cachedAt = Date.now();
    return cache;
}

export function bustApprovedActivitiesCache() {
    cachedAt = 0;
}
