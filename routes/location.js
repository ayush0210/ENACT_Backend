const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const pool = require('../config/db');
const authenticateJWT = require('./middleware');
const serviceAccount = require('../key.json');
const router = express.Router();
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
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
      await admin.messaging().send({
        token: token,
        data: {},
      }, true); // true enables dry run mode - no actual message is sent
      return true;
    } catch (error) {
      if (error.errorInfo?.code === 'messaging/invalid-argument' ||
          error.errorInfo?.code === 'messaging/registration-token-not-registered') {
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

        // Insert the new location into the database
        const [result] = await pool.query(
            'INSERT INTO locations (user_id, lat, `long`, type, name, `desc`) VALUES (?, ?, ?, ?, ?, ?)',
            [user_id, latitude, longitude, type, name, description],
        );

        // Check if the insertion was successful
        if (result.affectedRows === 1) {
            return res
                .status(201)
                .json({ message: 'Location added successfully' });
        } else {
            return res.status(500).json({ error: 'Failed to add location' });
        }
    } catch (error) {
        console.error('Error adding location:', error);
        res.status(500).json({ error: 'Internal Server Error' });
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
            projectId: admin.app().options.projectId
        });

        const isValid = await validateFCMToken(deviceToken);
        if (!isValid) {
            const query = isIOS 
                ? 'UPDATE users SET ios_token = NULL WHERE ios_token = ?'
                : 'UPDATE users SET android_token = NULL WHERE android_token = ?';
            
            await pool.query(query, [deviceToken]);
            throw new Error('Invalid FCM token - removed from database');
        }

        const message = {
            token: deviceToken,
            notification: {
                title,
                body,
            },
            data: data || {},
            android: {
                priority: 'high',
                notification: {
                    channelId: 'location-tips',
                    priority: 'high',
                    defaultSound: true,
                }
            },
            apns: isIOS ? {
                payload: {
                    aps: {
                        alert: { title, body },
                        sound: 'default',
                        badge: 1,
                        'content-available': 1,
                        'mutable-content': 1,
                    },
                },
                headers: {
                    'apns-priority': '10',
                }
            } : undefined
        };

        console.log('Sending message:', JSON.stringify(message, null, 2));
        
        const response = await admin.messaging().send(message);
        console.log('Notification sent successfully:', response);
        return response;
    } catch (error) {
        console.error('Notification error:', {
            code: error.errorInfo?.code,
            message: error.errorInfo?.message,
            stack: error.stack
        });
        throw error;
    }
};
const notificationCache = new Map();

router.post('/', authenticateJWT, async (req, res) => {
    const requestId = `${req.user.id}-${Date.now()}`;
    
    try {
        let user_id = req.user.id;
        const { latitude, longitude } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({ error: 'Latitude and longitude are required' });
        }

        // Check if there's a pending request for this user
        if (notificationCache.has(user_id)) {
            const lastRequest = notificationCache.get(user_id);
            if (Date.now() - lastRequest < 5000) { // 5 second cooldown
                return res.status(200).json({ 
                    message: 'Request throttled',
                    status: 'throttled'
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
                status: 'out_of_range'
            });
        }

        // Check for recent notifications
        const [notifs] = await pool.query(
            `SELECT COUNT(*) AS notification_count
             FROM notifications
             WHERE user_id = ? AND loc_id = ?
             AND timestamp >= CURRENT_TIMESTAMP - INTERVAL 5 MINUTE;`,
            [user_id, nearbyLocation.id],
        );

        if (notifs[0].notification_count > 0) {
            return res.status(200).json({ 
                message: 'Notification cooldown active',
                status: 'cooldown'
            });
        }

        // Get user's device token
        const [result] = await pool.query(
            'SELECT android_token, ios_token FROM users WHERE id = ?',
            [user_id],
        );

        const deviceToken = result[0].ios_token || result[0].android_token;
        const isIOS = !!result[0].ios_token;

        if (!deviceToken) {
            return res.status(400).json({ 
                message: 'No device token found',
                status: 'no_token'
            });
        }

        // Get tips
        const [tips] = await pool.query(
            'SELECT title, description FROM tips WHERE type = ? ORDER BY RAND() LIMIT 3',
            [nearbyLocation.type]
        );

        const tipsText = tips.map(tip => 
            `${tip.title}\n${tip.description}`
        ).join('\n\n');

        // Send notification with unique identifier
        const notificationId = `${user_id}-${nearbyLocation.id}-${Date.now()}`;
        await sendNotification(
            deviceToken,
            `You have arrived at ${nearbyLocation.name}`,
            `${nearbyLocation.type} Tips:\n\n${tipsText}`,
            {
                notificationId,
                locationType: nearbyLocation.type,
                locationId: nearbyLocation.id.toString(),
                locationName: nearbyLocation.name
            },
            isIOS
        );

        // Record notification
        await pool.query(
            `INSERT INTO notifications (user_id, loc_id, device_id)
             VALUES (?, ?, ?);`,
            [user_id, nearbyLocation.id, deviceToken],
        );

        return res.status(200).json({
            message: "Notification sent successfully",
            status: 'success',
            location: nearbyLocation.name,
            type: nearbyLocation.type,
            notificationId
        });

    } catch (error) {
        console.error('Error in location check:', error);
        return res.status(500).json({ 
            error: 'Internal Server Error',
            details: error.message 
        });
    } finally {
        // Clean up old cache entries
        const now = Date.now();
        for (const [key, timestamp] of notificationCache.entries()) {
            if (now - timestamp > 60000) { // Remove entries older than 1 minute
                notificationCache.delete(key);
            }
        }
    }
});
module.exports = router;
