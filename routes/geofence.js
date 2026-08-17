import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';
import personalizationService from '../services/personalizationService.js';
import { buildLocationNotificationPayload } from '../utils/locationNotificationPayload.js';

const router = express.Router();

// In-memory idempotency store: key → epoch-ms. Prevents double-processing when the
// OS delivers the same geofence transition event more than once (common on Android).
const processedKeys = new Map();
setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000; // 30-minute TTL
    for (const [k, ts] of processedKeys) { if (ts < cutoff) processedKeys.delete(k); }
}, 5 * 60 * 1000);

/**
 * POST /endpoint/geofence-enter
 *
 * Called by native background handlers (Android WorkManager, iOS CLLocationManager).
 * Unlike POST /endpoint (which takes raw GPS coordinates), this takes a locationId
 * that the native layer already knows from the registered geofence.
 *
 * Does NOT send FCM — the caller (WorkManager / iOS) shows the notification locally
 * using the tip content returned in the response body. This eliminates the dependency
 * on the React Native JS runtime being alive.
 *
 * Body: { locationId: number, idempotencyKey?: string, platform?: "android"|"ios" }
 * Response 200: { status: "success"|"cooldown"|"duplicate", title?, body?, tips?, ... }
 */
router.post('/geofence-enter', authenticateJWT, async (req, res) => {
    const { locationId, idempotencyKey, platform = 'unknown' } = req.body;
    const userId = req.user.id;

    if (!locationId) {
        return res.status(400).json({ error: 'locationId is required' });
    }

    // Idempotency: same OS transition delivered twice after successful processing
    // within 30 minutes → skip silently. Mark only after a cooldown/success outcome
    // so transient backend failures do not poison retries that reuse the same key.
    if (idempotencyKey) {
        if (processedKeys.has(idempotencyKey)) {
            console.log(`[geofence-enter] Duplicate idempotency key: ${idempotencyKey}`);
            return res.status(200).json({ status: 'duplicate' });
        }
    }

    let lockName = null;
    let lockAcquired = false;

    try {
        // Verify the location belongs to this user
        const [[location]] = await pool.query(
            'SELECT id, name, type FROM locations WHERE id = ? AND user_id = ?',
            [locationId, userId]
        );
        if (!location) {
            return res.status(404).json({ error: 'Location not found or does not belong to user' });
        }

        lockName = `location-notification:${userId}:${location.id}`;
        const [[lockRow]] = await pool.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
        lockAcquired = lockRow?.acquired === 1;
        if (!lockAcquired) {
            return res.status(200).json({ status: 'duplicate', message: 'Notification processing already in progress' });
        }

        // 6-hour per-(user, location) cooldown — same window as the existing /endpoint route
        const [[{ cnt }]] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM notifications
             WHERE user_id = ? AND loc_id = ? AND timestamp >= NOW() - INTERVAL 6 HOUR`,
            [userId, location.id]
        );
        if (cnt > 0) {
            console.log(`[geofence-enter] Cooldown active for user=${userId} loc=${location.id}`);
            if (idempotencyKey) processedKeys.set(idempotencyKey, Date.now());
            return res.status(200).json({ status: 'cooldown', message: 'Cooldown active' });
        }

        // Fetch content preferences (from survey — no client-side prefs available in native context)
        let contentPreferences = [];
        try {
            const [[row]] = await pool.query(
                'SELECT content_preferences FROM user_survey_responses WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1',
                [userId]
            );
            if (row?.content_preferences) {
                const parsed = JSON.parse(row.content_preferences);
                if (Array.isArray(parsed)) contentPreferences = parsed;
            }
        } catch (_) {}

        // Fetch children for personalised prompt context
        let childContext = '';
        try {
            const [kids] = await pool.query('SELECT nickname, age FROM children WHERE user_id = ?', [userId]);
            childContext = kids.map(c => {
                const a = c.age === 0 ? 'under 1 year' : `${c.age} year${c.age === 1 ? '' : 's'}`;
                return c.nickname ? `${c.nickname}: ${a} old` : `${a} old`;
            }).join(', ');
        } catch (_) {}

        const domainDesc = contentPreferences.length
            ? contentPreferences.join(' and ')
            : 'language development, literacy, science, and social-emotional learning';
        const prompt = childContext
            ? `${domainDesc} activities at ${location.name} for children (${childContext})`
            : `${domainDesc} activities at ${location.name}`;

        // Generate personalised tips — same service as the rest of the app
        let tips = [];
        try {
            const result = await personalizationService.generatePersonalizedTipsForQuery(
                userId, prompt, 3, contentPreferences
            );
            tips = Array.isArray(result) ? result : (result.tips || []);
            if (!tips.length) throw new Error('empty result');
        } catch (_) {
            // Fallback: type-specific tips from DB
            const [fb] = await pool.query(
                'SELECT id, title, description FROM tips WHERE type = ? ORDER BY RAND() LIMIT 3',
                [location.type]
            );
            tips = fb.length ? fb : (await pool.query(
                'SELECT id, title, description FROM tips ORDER BY RAND() LIMIT 3'
            ))[0];
        }

        const notificationId = `${userId}-${location.id}-${Date.now()}`;
        const payload = buildLocationNotificationPayload({
            location,
            tips,
            notificationId,
        });

        // Record so the 6-hour cooldown applies to subsequent triggers
        await pool.query(
            'INSERT INTO notifications (user_id, loc_id, device_id) VALUES (?, ?, ?)',
            [userId, location.id, `geofence-${platform}`]
        );
        if (idempotencyKey) processedKeys.set(idempotencyKey, Date.now());

        console.log(`[geofence-enter] Success: user=${userId} loc=${location.id} tips=${payload.tips.length}`);
        return res.status(200).json({
            status: 'success',
            ...payload,
        });
    } catch (err) {
        console.error('[geofence-enter] Error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    } finally {
        if (lockAcquired && lockName) {
            try {
                await pool.query('DO RELEASE_LOCK(?)', [lockName]);
            } catch (releaseErr) {
                console.error('[geofence-enter] Failed to release lock:', releaseErr.message);
            }
        }
    }
});

/**
 * GET /endpoint/geofence-sync
 *
 * Returns the canonical list of saved locations for the authenticated user.
 * Called by the RN app on startup / login to seed the native geofence registration.
 */
router.get('/geofence-sync', authenticateJWT, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT id, name, type, lat, `long` AS lng FROM locations WHERE user_id = ?',
            [req.user.id]
        );
        return res.status(200).json({ locations: rows });
    } catch (err) {
        console.error('[geofence-sync]', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
