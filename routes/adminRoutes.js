// adminRoutes.js
import express from 'express';
import pool from '../config/db.js';
import { authenticateJWT, authorizeAdmin } from './middleware.js';
import XLSX from 'xlsx';
import admin from 'firebase-admin';
import { bustApprovedActivitiesCache } from '../utils/activityCache.js';

const router = express.Router();

// Get all users (admin only)
router.get('/users', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT id, name, email, created_at, isAdmin, number_of_children
      FROM users
      ORDER BY created_at DESC
    `);
    
    res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user details (admin only)
router.get('/users/:userId', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Get user data
    const [users] = await pool.query(
      'SELECT id, name, email, created_at, isAdmin, number_of_children FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's children
    const [children] = await pool.query(
      'SELECT id, nickname, age FROM children WHERE user_id = ?',
      [userId]
    );
    
    // Get user's activity
    const [activity] = await pool.query(
      'SELECT * FROM app_sessions WHERE user_id = ? ORDER BY start_time DESC LIMIT 10',
      [userId]
    );
    
    // Get user's locations
    const [locations] = await pool.query(
      'SELECT * FROM locations WHERE user_id = ?',
      [userId]
    );
    
    res.status(200).json({
      user: users[0],
      children,
      activity,
      locations
    });
    
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle recording status (admin only) - used by dashboard when a user signs up there
// Body: { baniumChildId: string } — MongoDB ObjectId of the child in the Banium system
router.patch('/users/:userId/toggle-recording', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { baniumChildId } = req.body;

    const [users] = await pool.query('SELECT id, name, email, recording FROM users WHERE id = ?', [userId]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    const newRecordingStatus = !user.recording;

    await pool.query(
      'UPDATE users SET recording = ?, banium_child_id = ? WHERE id = ?',
      [newRecordingStatus, baniumChildId || null, userId]
    );

    res.status(200).json({
      id: user.id,
      name: user.name,
      email: user.email,
      recording: newRecordingStatus,
      banium_child_id: baniumChildId || null,
      message: `Recording ${newRecordingStatus ? 'enabled for' : 'disabled for'} user`,
    });
  } catch (error) {
    console.error('Error toggling recording status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle admin status (admin only)
router.patch('/users/:userId/toggle-admin', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user exists
    const [users] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = users[0];
    const newAdminStatus = !user.isAdmin;
    
    // Prevent removing admin status from the last admin
    if (!newAdminStatus) {
      const [adminCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE isAdmin = true');
      if (adminCount[0].count <= 1) {
        return res.status(400).json({ error: 'Cannot remove admin status from the last admin user' });
      }
    }
    
    // Update user's admin status
    await pool.query('UPDATE users SET isAdmin = ? WHERE id = ?', [newAdminStatus, userId]);
    
    res.status(200).json({ 
      id: user.id,
      name: user.name,
      email: user.email,
      isAdmin: newAdminStatus,
      message: `Admin status ${newAdminStatus ? 'granted to' : 'revoked from'} user`
    });
    
  } catch (error) {
    console.error('Error toggling admin status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get dashboard summary (admin only)
router.get('/dashboard/summary', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    // Get user count
    const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users');
    
    // Get children count
    const [childrenCount] = await pool.query('SELECT COUNT(*) as count FROM children');
    
    // Get locations count
    const [locationsCount] = await pool.query('SELECT COUNT(*) as count FROM locations');
    
    // Get notifications count
    const [notificationsCount] = await pool.query('SELECT COUNT(*) as count FROM notifications');
    
    // Get sessions count
    const [sessionsCount] = await pool.query('SELECT COUNT(*) as count FROM app_sessions');
    
    // Get recent users
    const [recentUsers] = await pool.query(`
      SELECT id, name, email, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 5
    `);
    
    // Get recent notifications
    const [recentNotifications] = await pool.query(`
      SELECT n.*, u.name as user_name, l.name as location_name
      FROM notifications n
      JOIN users u ON n.user_id = u.id
      JOIN locations l ON n.loc_id = l.id
      ORDER BY n.timestamp DESC
      LIMIT 5
    `);
    
    res.status(200).json({
      counts: {
        users: userCount[0].count,
        children: childrenCount[0].count,
        locations: locationsCount[0].count,
        notifications: notificationsCount[0].count,
        sessions: sessionsCount[0].count
      },
      recent: {
        users: recentUsers,
        notifications: recentNotifications
      }
    });
    
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user registration timeline (admin only)
router.get('/dashboard/users-timeline', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const [timeline] = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM users
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);
    
    res.status(200).json(timeline);
  } catch (error) {
    console.error('Error fetching user timeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Export filtered dashboard data as Excel (admin only)
router.get('/export/excel', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;

    const userParams = [];
    let userWhere = '';
    if (dateFrom) { userWhere += ' WHERE created_at >= ?'; userParams.push(dateFrom); }
    if (dateTo)   { userWhere += (userWhere ? ' AND' : ' WHERE') + ' created_at <= ?'; userParams.push(dateTo); }
    const [users] = await pool.query(
      `SELECT id, name, created_at, isAdmin, number_of_children FROM users${userWhere} ORDER BY created_at DESC`,
      userParams
    );

    const [children] = await pool.query(`
      SELECT c.id, c.nickname, c.age, c.user_id, u.name AS parent_name
      FROM children c JOIN users u ON c.user_id = u.id ORDER BY u.name ASC
    `);

    const [locations] = await pool.query(`
      SELECT l.id, l.name, l.type, l.user_id, u.name AS owner_name
      FROM locations l JOIN users u ON l.user_id = u.id ORDER BY u.name ASC
    `);

    const notifParams = [];
    let notifWhere = '';
    if (dateFrom) { notifWhere += ' AND n.timestamp >= ?'; notifParams.push(dateFrom); }
    if (dateTo)   { notifWhere += ' AND n.timestamp <= ?'; notifParams.push(dateTo); }
    const [notifications] = await pool.query(
      `SELECT n.user_id, n.timestamp, u.name AS user_name, l.name AS location_name
       FROM notifications n
       JOIN users u ON n.user_id = u.id
       JOIN locations l ON n.loc_id = l.id
       WHERE 1=1${notifWhere}
       ORDER BY n.timestamp DESC LIMIT 5000`,
      notifParams
    );

    const aoa = [];

    aoa.push(['USERS']);
    aoa.push(['User ID', 'Name', 'Registered On', 'Is Admin', 'Number of Children']);
    users.forEach(u => aoa.push([u.id, u.name, new Date(u.created_at).toLocaleDateString(), u.isAdmin ? 'Yes' : 'No', u.number_of_children]));
    aoa.push([]);

    aoa.push(['CHILDREN']);
    aoa.push(['Child ID', 'Nickname', 'Age', 'Parent ID', 'Parent Name']);
    children.forEach(c => aoa.push([c.id, c.nickname, c.age, c.user_id, c.parent_name]));
    aoa.push([]);

    aoa.push(['LOCATIONS']);
    aoa.push(['Location ID', 'Name', 'Type', 'Owner ID', 'Owner Name']);
    locations.forEach(l => aoa.push([l.id, l.name, l.type, l.user_id, l.owner_name]));
    aoa.push([]);

    aoa.push(['NOTIFICATIONS']);
    aoa.push(['Timestamp', 'User ID', 'User Name', 'Location Name']);
    notifications.forEach(n => aoa.push([new Date(n.timestamp).toLocaleString(), n.user_id, n.user_name, n.location_name]));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Dashboard Export');

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `enact_dashboard_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.json({ data: buffer.toString('base64'), filename });
  } catch (error) {
    console.error('Error exporting Excel:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pending activity submissions (admin only)
router.get('/activities/pending', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT pa.id, pa.name, pa.domains, pa.status, pa.created_at,
             u.name AS submitted_by_name, u.email AS submitted_by_email
      FROM pending_activities pa
      JOIN users u ON pa.submitted_by = u.id
      WHERE pa.status = 'pending'
      ORDER BY pa.created_at DESC
    `);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching pending activities:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Approve a pending activity (admin only)
router.patch('/activities/:id/approve', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const [activities] = await pool.query(
      'SELECT pa.id, pa.name, pa.submitted_by FROM pending_activities pa WHERE pa.id = ? AND pa.status = ?',
      [id, 'pending'],
    );
    if (activities.length === 0) {
      return res.status(404).json({ error: 'Activity not found or already reviewed' });
    }

    const activity = activities[0];

    await pool.query(
      'UPDATE pending_activities SET status = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ?',
      ['approved', req.user.id, id],
    );
    bustApprovedActivitiesCache();

    // Send push notification to the user who submitted the activity
    const [users] = await pool.query(
      'SELECT ios_token, android_token FROM users WHERE id = ?',
      [activity.submitted_by],
    );
    if (users.length > 0) {
      const { ios_token, android_token } = users[0];
      const token = ios_token || android_token;
      const isIOS = !!ios_token;
      if (token) {
        const title = 'Activity Approved!';
        const body = `"${activity.name}" has been approved and is now available for tip requests.`;
        const message = isIOS
          ? {
              token,
              notification: { title, body },
              data: { type: 'activity_approved', activityName: activity.name },
              apns: {
                payload: { aps: { alert: { title, body }, sound: 'default', badge: 1 } },
                headers: { 'apns-priority': '10' },
              },
            }
          : {
              token,
              data: { type: 'activity_approved', activityName: activity.name, title, body },
              android: { priority: 'high' },
            };

        admin.messaging().send(message).catch(err =>
          console.error('Activity approval notification error:', err),
        );
      }
    }

    res.status(200).json({ message: 'Activity approved' });
  } catch (error) {
    console.error('Error approving activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reject a pending activity (admin only)
router.patch('/activities/:id/reject', authenticateJWT, authorizeAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      'UPDATE pending_activities SET status = ?, reviewed_at = NOW(), reviewed_by = ? WHERE id = ? AND status = ?',
      ['rejected', req.user.id, id, 'pending'],
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Activity not found or already reviewed' });
    }
    res.status(200).json({ message: 'Activity rejected' });
  } catch (error) {
    console.error('Error rejecting activity:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

