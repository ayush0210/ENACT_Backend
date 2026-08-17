import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';
import { createRequire } from 'module';
import { GoogleAuth } from 'google-auth-library';
import personalizationService from '../services/personalizationService.js';
import {
    buildLocationNotificationPayload,
    notificationDataForPush,
} from '../utils/locationNotificationPayload.js';

const require = createRequire(import.meta.url);
const serviceAccount = require('../key.json');
const router = express.Router();
// import serviceAccount from '../key.json';
// import authenticateJWT from './middleware';
// const pool = require('../config/db');
const auth = new GoogleAuth({
    // keyFile: '../key.json',
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
});
const fcmSendEndpoint =
    'https://fcm.googleapis.com/v1/projects/talk-around-town-423916-ec889/messages:send';
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
    var R = 6371; // Radius of the Earth in km
    var dLat = deg2rad(lat2 - lat1); // deg2rad below
    var dLon = deg2rad(lon2 - lon1);
    var a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) *
            Math.cos(deg2rad(lat2)) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var d = R * c; // Distance in km
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

async function validateFCMToken(token) {
    try {
        // Attempt to send a test message with dry run option
        await admin.messaging().send(
            {
                token: token,
                data: {},
            },
            true,
        ); // true enables dry run mode - no actual message is sent
        return true;
    } catch (error) {
        if (
            error.errorInfo?.code === 'messaging/invalid-argument' ||
            error.errorInfo?.code ===
                'messaging/registration-token-not-registered'
        ) {
            return false;
        }
        throw error; // Rethrow other errors
    }
}

router.post('/addLocation', authenticateJWT, async (req, res) => {
    try {
        // Get user_id from req.user
        const user_id = req.user.id;

        // Extract location data from the request body
        const { latitude, longitude, type, name, description } = req.body;

        // Validate the input data
        if (!latitude || !longitude || !name) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        // Check for duplicate locations within 100m
        const [existing] = await pool.query(
            'SELECT lat, `long` FROM locations WHERE user_id = ?',
            [user_id],
        );
        for (const loc of existing) {
            const dist = getDistanceFromLatLonInKm(latitude, longitude, loc.lat, loc.long);
            if (dist < 0.1) {
                return res.status(400).json({ error: 'A location already exists within 100 metres of this point.' });
            }
        }

        // Insert the new location into the database
        const [result] = await pool.query(
            'INSERT INTO locations (user_id, lat, `long`, type, name, `desc`) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, latitude, longitude, type, name, description],
        );
        // Check if the insertion was successful
        if (result.affectedRows === 1) {
            return res
                .status(201)
                .json({ message: 'Location added successfully'});
        } else {
            return res.status(500).json({ error: 'Failed to add location' });
        }
    } catch (error) {
        console.error('Error adding location:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
router.delete('/deleteLocation', authenticateJWT, async (req, res) => {
    try {
        // Get user_id from req.user
        const user_id = req.user.id;

        // Extract location ID from the request body and ensure it's a number
        let { id } = req.body;
        id = parseInt(id, 10); // Convert to number

        // Log for debugging
        console.log('Delete request received:', { user_id, id, body: req.body });

        // Validate the input data
        if (!id || isNaN(id)) {
            return res.status(400).json({ error: 'Valid location ID is required' });
        }

        try {
            // Delete the location from the database using ID
            const [result] = await pool.query(
                'DELETE FROM locations WHERE user_id = ? AND id = ?',
                [user_id, id]
            );

            // Check if the deletion was successful
            if (result.affectedRows > 0) {
                return res.status(200).json({ message: 'Location deleted successfully' });
            } else {
                return res.status(404).json({ error: 'Location not found or you do not have permission to delete it' });
            }
        } catch (dbError) {
            console.error('Database error during location deletion:', dbError);
            return res.status(500).json({ 
                error: 'Database Error', 
                details: dbError.message,
                code: dbError.code
            });
        }
    } catch (error) {
        console.error('Error in deleteLocation endpoint:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});
router.post('/tips', authenticateJWT, async (req, res) => {
    // get tips from db
    // first get userid from req.user
    // get type from req.body
    // then get tips from db
    // return tips
    // const user_id = req.user.id;
    try {
        const { type } = req.body;
        // const db = await pool.getConnection();
        const [rows] = await pool.query('SELECT * FROM tips WHERE type = ?', [
            type,
        ]);
        // db.release();
        // select 3 random tips
        const tips = [];
        const randomIndices = [];
        while (randomIndices.length < 3) {
            const randomIndex = Math.floor(Math.random() * rows.length);
            if (!randomIndices.includes(randomIndex)) {
                randomIndices.push(randomIndex);
                tips.push(rows[randomIndex]);
            }
        }
        return res.status(200).json(tips);
    } catch (e) {
        console.log('error in fetcing tips', e);
        return res.status(500).json({ message: 'No tips found' });
    }
});

router.post('/locations', authenticateJWT, async (req, res) => {
    // get location from db
    // first get userid from req.user
    // then get location from db
    // return location
    const user_id = req.user.id;
    // const db = await pool.getConnection();
    const [rows] = await pool.query(
        'SELECT * FROM locations WHERE user_id = ?',
        [user_id],
    );
    // db.release();
    const locations = rows.map(row => ({
        latitude: parseFloat(row.lat),
        longitude: parseFloat(row.long),
        latitudeDelta: 0.015, // Assuming a default value
        longitudeDelta: 0.0121, // Assuming a default value
    }));

    const colors = ['red', 'green', 'blue'];

    const getRandomColor = () => {
        const randomIndex = Math.floor(Math.random() * colors.length);
        return colors[randomIndex];
    };

const details = rows.map(row => ({
        id: row.id,
        title: row.name,
        description: row.desc,
        pinColor: getRandomColor(),
    }));
    // Send the transformed data as a JSON response
    return res.status(200).json({ locations, details });
    // return res.json(rows);
});

const sendNotification = async (deviceToken, title, body, data, isIOS) => {
  try {
    console.log('Preparing to send notification:', {
      platform: isIOS ? 'iOS' : 'Android',
      tokenPrefix: deviceToken.substring(0, 10),
      projectId: 'talk-around-town-423916-ec889',
    });

    const isValid = await validateFCMToken(deviceToken);
    if (!isValid) {
      const query = isIOS
        ? 'UPDATE users SET ios_token = NULL WHERE ios_token = ?'
        : 'UPDATE users SET android_token = NULL WHERE android_token = ?';
      await pool.query(query, [deviceToken]);
      throw new Error('Invalid FCM token - removed from database');
    }

    // Android: data-only message — notifee's setBackgroundMessageHandler displays it
    // reliably in every app state (foreground / background / killed).
    //
    // iOS: notification message — iOS throttles data-only background wake-ups, so the
    // OS must auto-display it via the `notification` field. The frontend background
    // handler is skipped for iOS to avoid duplicates.
    const message = isIOS
      ? {
          token: deviceToken,
          notification: { title, body },
          data: { ...(data || {}), title, body },
          apns: {
            payload: {
              aps: {
                alert: { title, body },
                sound: 'default',
                badge: 1,
                'content-available': 1,
                'mutable-content': 1,
              },
            },
            headers: { 'apns-priority': '10' },
          },
        }
      : {
          token: deviceToken,
          data: { ...(data || {}), title, body },
          android: {
            priority: 'high',
          },
        };

    console.log('Sending message:', JSON.stringify(message, null, 2));
    
    // Send using Firebase Admin SDK - this is cleaner than using axios
    const response = await admin.messaging().send(message);
    console.log('Notification sent successfully:', response);
    return response;
  } catch (error) {
    console.error('Notification error:', {
      code: error.errorInfo?.code,
      message: error.errorInfo?.message,
      stack: error.stack,
    });
    throw error;
  }
};
const notificationCache = new Map();


router.post('/', authenticateJWT, async (req, res) => {
    const requestId = `${req.user.id}-${Date.now()}`;

    try {
        let user_id = req.user.id;
        const { latitude, longitude, contentPreferences: clientPrefs } = req.body;

        if (!latitude || !longitude) {
            return res
                .status(400)
                .json({ error: 'Latitude and longitude are required' });
        }

        // Check if there's a pending request for this user
        if (notificationCache.has(user_id)) {
            const lastRequest = notificationCache.get(user_id);
            if (Date.now() - lastRequest < 60000) {
                return res.status(200).json({
                    message: 'Request throttled',
                    status: 'throttled',
                });
            }
        }
        notificationCache.set(user_id, Date.now());

        // Get user's locations
        const [rows] = await pool.query(
            'SELECT * FROM locations WHERE user_id = ?;',
            [user_id],
        );

        const locations = rows.map(row => ({
            id: row.id,
            latitude: parseFloat(row.lat),
            longitude: parseFloat(row.long),
            name: row.name,
            type: row.type,
        }));

        // Find nearby location
        let nearbyLocation = null;
        for (const location of locations) {
            const distance = getDistanceFromLatLonInKm(
                latitude,
                longitude,
                location.latitude,
                location.longitude,
            );
            if (distance < 0.1) {
                nearbyLocation = location;
                break;
            }
        }

        if (!nearbyLocation) {
            return res.status(200).json({
                message: 'Not in range of any point',
                status: 'out_of_range',
            });
        }

        const lockName = `location-notification:${user_id}:${nearbyLocation.id}`;
        let lockAcquired = false;
        try {
            const [[lockRow]] = await pool.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
            lockAcquired = lockRow?.acquired === 1;
            if (!lockAcquired) {
                return res.status(200).json({
                    message: 'Notification processing already in progress',
                    status: 'duplicate',
                });
            }

        // Check for recent notifications
        const [notifs] = await pool.query(
            `SELECT COUNT(*) AS notification_count
             FROM notifications
             WHERE user_id = ? AND loc_id = ?
             AND timestamp >= CURRENT_TIMESTAMP - INTERVAL 6 HOUR;`,
            [user_id, nearbyLocation.id],
        );
        if (notifs[0].notification_count > 0) {
            return res.status(200).json({
                message: 'Notification cooldown active',
                status: 'cooldown',
            });
        }

        // Get user's device token
        const [result] = await pool.query(
            'SELECT android_token, ios_token FROM users WHERE id = ?',
            [user_id],
        );

        const androidToken = result[0].android_token;
        const iosToken = result[0].ios_token;

        // Determine which token to use and the correct platform
        // Prefer the most recently set token (non-null one)
        // The token registration clears the other platform's token, so only one should exist
        const deviceToken = androidToken || iosToken;
        const isIOS = !androidToken && !!iosToken;

        console.log('Device tokens:', { androidToken: !!androidToken, iosToken: !!iosToken });
        console.log('Selected token platform:', isIOS ? 'iOS' : 'Android');
        console.log('Device token prefix:', deviceToken ? deviceToken.substring(0, 20) + '...' : 'none');

        if (!deviceToken) {
            return res.status(400).json({
                message: 'No device token found',
                status: 'no_token',
            });
        }

        // Prefer content preferences sent by the client (from AsyncStorage).
        // Fall back to survey DB preferences if the client sent none.
        let contentPreferences = Array.isArray(clientPrefs) && clientPrefs.length
            ? clientPrefs
            : [];
        if (!contentPreferences.length) {
            try {
                const [surveyRows] = await pool.query(
                    'SELECT content_preferences FROM user_survey_responses WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
                    [user_id]
                );
                if (surveyRows.length > 0 && surveyRows[0].content_preferences) {
                    const parsed = JSON.parse(surveyRows[0].content_preferences);
                    if (Array.isArray(parsed) && parsed.length) {
                        contentPreferences = parsed;
                    }
                }
            } catch (e) {
                console.log('Could not fetch user preferences, using defaults:', e.message);
            }
        }

        // Fetch user's children for child context in prompt
        let childContext = '';
        try {
            const [childRows] = await pool.query(
                'SELECT nickname, age FROM children WHERE user_id = ?',
                [user_id],
            );
            if (childRows.length > 0) {
                childContext = childRows
                    .map(c => {
                        const ageStr = c.age === 0
                            ? 'under 1 year'
                            : `${c.age} year${c.age === 1 ? '' : 's'}`;
                        return c.nickname ? `${c.nickname}: ${ageStr} old` : `${ageStr} old`;
                    })
                    .join(', ');
            }
        } catch (e) {
            console.log('Could not fetch children for prompt:', e.message);
        }

        // Build prompt using selected content preferences (or all domains if none selected)
        const domainDesc = contentPreferences.length
            ? contentPreferences.join(' and ')
            : 'language development, literacy, science exploration, and social-emotional learning';
        const prompt = childContext
            ? `${domainDesc} activities at ${nearbyLocation.name} for children (${childContext})`
            : `${domainDesc} activities at ${nearbyLocation.name}`;

        // Get personalized tips using the same service as the parenting assistant
        let tips = [];
        let tipsText = '';
        try {
            const result = await personalizationService.generatePersonalizedTipsForQuery(
                user_id,
                prompt,
                3,
                contentPreferences
            );
            tips = Array.isArray(result) ? result : (result.tips || []);
            // If personalization returned nothing, fall through to the DB fallback
            if (tips.length === 0) throw new Error('Personalization returned empty tips');
            tipsText = tips
                .map(tip => `${tip.title}\n${tip.body || tip.description}`)
                .join('\n\n');
        } catch (e) {
            console.log('Personalization failed, falling back to generic tips:', e.message);
            // Fallback to type-specific tips
            const [fallbackTips] = await pool.query(
                'SELECT title, description FROM tips WHERE type = ? ORDER BY RAND() LIMIT 3',
                [nearbyLocation.type],
            );
            tips = fallbackTips;
            // If no tips exist for this location type, pull from any type
            if (tips.length === 0) {
                console.log(`No tips found for type '${nearbyLocation.type}', using general tips`);
                const [generalTips] = await pool.query(
                    'SELECT title, description FROM tips ORDER BY RAND() LIMIT 3',
                );
                tips = generalTips;
            }
            tipsText = tips
                .map(tip => `${tip.title}\n${tip.description}`)
                .join('\n\n');
        }

        // Send notification with unique identifier
        const notificationId = `${user_id}-${nearbyLocation.id}-${Date.now()}`;
        const payload = buildLocationNotificationPayload({
            location: nearbyLocation,
            tips,
            notificationId,
        });
        await sendNotification(
            deviceToken,
            payload.title,
            payload.body,
            notificationDataForPush(payload),
            isIOS,
        );

        // Record notification
        await pool.query(
            `INSERT INTO notifications (user_id, loc_id, device_id)
             VALUES (?, ?, ?);`,
            [user_id, nearbyLocation.id, deviceToken],
        );

        return res.status(200).json({
            message: 'Notification sent successfully',
            status: 'success',
            location: nearbyLocation.name,
            type: nearbyLocation.type,
            notificationId,
            notification: payload,
        });
        } finally {
            if (lockAcquired) {
                try {
                    await pool.query('DO RELEASE_LOCK(?)', [lockName]);
                } catch (releaseErr) {
                    console.error('Failed to release notification lock:', releaseErr.message);
                }
            }
        }
    } catch (error) {
        console.error('Error in location check:', error);
        return res.status(500).json({
            error: 'Internal Server Error',
            details: error.message,
        });
    } finally {
        // Clean up old cache entries
        const now = Date.now();
        for (const [key, timestamp] of notificationCache.entries()) {
            if (now - timestamp > 60000) {
                // Remove entries older than 1 minute
                notificationCache.delete(key);
            }
        }
    }
});

// Debug endpoint to test notifications
router.post('/test-notification', authenticateJWT, async (req, res) => {
    try {
        const user_id = req.user.id;

        // Get user's device token
        const [result] = await pool.query(
            'SELECT android_token, ios_token FROM users WHERE id = ?',
            [user_id],
        );

        const androidToken = result[0].android_token;
        const iosToken = result[0].ios_token;
        const deviceToken = androidToken || iosToken;
        const isIOS = !androidToken && !!iosToken;

        console.log('=== TEST NOTIFICATION DEBUG ===');
        console.log('User ID:', user_id);
        console.log('Android token exists:', !!androidToken);
        console.log('iOS token exists:', !!iosToken);
        console.log('Selected platform:', isIOS ? 'iOS' : 'Android');
        console.log('Token prefix:', deviceToken ? deviceToken.substring(0, 30) : 'NO TOKEN');

        if (!deviceToken) {
            return res.status(400).json({
                success: false,
                message: 'No device token found for user',
                debug: {
                    androidToken: !!androidToken,
                    iosToken: !!iosToken,
                },
            });
        }

        // Validate token first
        const isValid = await validateFCMToken(deviceToken);
        console.log('Token valid:', isValid);

        if (!isValid) {
            return res.status(400).json({
                success: false,
                message: 'Device token is invalid or expired',
                debug: {
                    platform: isIOS ? 'iOS' : 'Android',
                    tokenPrefix: deviceToken.substring(0, 30),
                },
            });
        }

        // Send test notification
        const response = await sendNotification(
            deviceToken,
            'Test Notification',
            'This is a test notification from ENACT backend.',
            { test: 'true', timestamp: Date.now().toString() },
            isIOS,
        );

        return res.status(200).json({
            success: true,
            message: 'Test notification sent successfully',
            debug: {
                platform: isIOS ? 'iOS' : 'Android',
                fcmResponse: response,
            },
        });
    } catch (error) {
        console.error('Test notification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to send test notification',
            error: error.message,
            errorCode: error.errorInfo?.code,
        });
    }
});

export default router;
