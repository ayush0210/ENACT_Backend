import express from 'express';
import { authenticateJWT } from './middleware.js';

const router = express.Router();
const MAX_BUFFER = 500;

// In-memory ring buffer per server session
const eventBuffer = [];

router.post('/log', authenticateJWT, (req, res) => {
  const event = {
    ...req.body,
    _receivedAt: new Date().toISOString(),
    _serverUserId: req.user.id,
  };

  // Structured console output for easy grep
  console.log(
    `[DIAG][${event._receivedAt}] user=${event._serverUserId} platform=${event.platform} appState=${event.appState} event=${event.eventName}`,
    JSON.stringify(event.metadata ?? {}),
  );

  eventBuffer.push(event);
  if (eventBuffer.length > MAX_BUFFER) {
    eventBuffer.shift();
  }

  return res.json({ok: true, buffered: eventBuffer.length});
});

router.get('/events', authenticateJWT, (req, res) => {
  const userEvents = eventBuffer.filter(
    e => String(e._serverUserId) === String(req.user.id),
  );
  return res.json(userEvents);
});

router.delete('/events', authenticateJWT, (req, res) => {
  const before = eventBuffer.length;
  const kept = eventBuffer.filter(
    e => String(e._serverUserId) !== String(req.user.id),
  );
  eventBuffer.length = 0;
  kept.forEach(e => eventBuffer.push(e));
  return res.json({deleted: before - eventBuffer.length});
});

export default router;
