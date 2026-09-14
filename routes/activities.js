import express from 'express';
import { OpenAI } from 'openai';
import pool from '../config/db.js';
import { authenticateJWT } from './middleware.js';
import { SUPPORTED_ACTIVITIES } from '../utils/supportedActivities.js';
import { getApprovedActivities } from '../utils/activityCache.js';
import { resolveActivity, resolveActivities } from '../utils/activityNormalization.js';
import personalizationService from '../services/personalizationService.js';

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

pool.query(`
  CREATE TABLE IF NOT EXISTS pending_activities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    submitted_by INT NOT NULL,
    domains JSON,
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    reviewed_by INT NULL
  )
`).catch(err => console.error('pending_activities table init error:', err));

router.get('/supported', async (req, res) => {
  try {
    const activities = await getApprovedActivities();
    res.json({ activities });
  } catch {
    res.json({ activities: SUPPORTED_ACTIVITIES });
  }
});

router.post('/suggest', authenticateJWT, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Activity name is required' });
  }

  const normalized = name.trim();

  // Resolve against the full approved list (built-ins + admin-approved custom
  // activities), using the same alias-aware normalization used at location
  // save time, so e.g. "Bed-Time" is recognized as already-supported "Bed time".
  const approvedActivities = await getApprovedActivities();
  const alreadySupported = Boolean(resolveActivity(normalized, approvedActivities));
  if (alreadySupported) {
    return res.status(409).json({ error: 'already_supported', message: 'This activity is already on the supported list.' });
  }

  const [existing] = await pool.query(
    'SELECT id, status FROM pending_activities WHERE LOWER(name) = LOWER(?)',
    [normalized],
  );
  if (existing.length > 0) {
    const { status } = existing[0];
    if (status === 'pending') {
      return res.status(409).json({ error: 'already_pending', message: 'This activity has already been submitted and is awaiting review.' });
    }
    if (status === 'rejected') {
      return res.status(400).json({ error: 'previously_rejected', message: 'This activity was reviewed and is not supported.' });
    }
  }

  let domains = [];
  let isValid = false;

  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_TIPS_MODEL || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `You are a validator for a child development app for children ages 0–5.
Determine if a submitted activity is a legitimate child development activity that fits into one or more of these categories:
- Play time (puzzles, pretend play, games, sensory, sports, screen time)
- Personal care (bath, potty, dressing, sleep, brushing teeth)
- Outdoor play (swinging, sliding, playing ball, water play)
- Eating & drinking (meals, snacks, bottle)
- Outings (car rides, shopping, walks, visiting people)
- Household chores (laundry, cleaning, picking up toys)
- Books & literacy (reading, stories, looking at pictures)
- Structured activities (circle time, music, art, school work, therapy)

Respond ONLY with valid JSON: { "valid": true/false, "domains": ["category1", ...], "reason": "brief reason" }`,
        },
        {
          role: 'user',
          content: `Is "${normalized}" a valid child development activity for ages 0–5?`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const parsed = JSON.parse(raw);
    isValid = parsed.valid === true;
    domains = parsed.domains ?? [];
  } catch (err) {
    console.error('Activity validation error:', err);
    return res.status(500).json({ error: 'validation_failed', message: 'Could not validate activity. Please try again.' });
  }

  if (!isValid) {
    return res.status(422).json({
      error: 'not_valid',
      message: `"${normalized}" doesn't appear to be a recognized child development activity for ages 0–5. Supported types include play, personal care, outdoor play, eating, outings, household chores, books, and structured activities.`,
      supported_activities: SUPPORTED_ACTIVITIES,
    });
  }

  await pool.query(
    'INSERT INTO pending_activities (name, submitted_by, domains) VALUES (?, ?, ?)',
    [normalized, req.user.id, JSON.stringify(domains)],
  );

  res.status(201).json({
    message: 'Activity submitted for review. An admin will review it shortly.',
    activity: normalized,
    domains,
  });
});

// POST /api/activities/tips
//
// Generates parenting tips grounded in a set of selected activities, with no
// location involved. Used by the reminder feature: when a user schedules a
// day/time reminder with activities attached, the app calls this once (at save
// time) and bakes the resulting title/body into the locally-scheduled repeating
// notification — so the reminder always shows a real, activity-grounded tip
// instead of generic "open the app" text, without needing a server-side
// scheduler. Activities are validated against the same approved list used
// everywhere else, so this never sends unvetted free text into the AI prompt.
router.post('/tips', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const rawActivities = req.body.activities;

  if (!Array.isArray(rawActivities) || rawActivities.length === 0) {
    return res.status(400).json({ error: 'activities must be a non-empty array of strings' });
  }

  const approvedActivities = await getApprovedActivities();
  const { resolved, unresolved } = resolveActivities(rawActivities, approvedActivities);
  if (unresolved.length > 0) {
    return res.status(400).json({
      error: 'unapproved_activities',
      message: 'One or more activities are not on the approved list.',
      unresolved,
    });
  }

  const contentPreferences = Array.isArray(req.body.contentPreferences)
    ? req.body.contentPreferences
    : [];

  let childContext = '';
  try {
    const [kids] = await pool.query('SELECT nickname, age FROM children WHERE user_id = ?', [userId]);
    childContext = kids
      .map(c => {
        const a = c.age === 0 ? 'under 1 year' : `${c.age} year${c.age === 1 ? '' : 's'}`;
        return c.nickname ? `${c.nickname}: ${a} old` : `${a} old`;
      })
      .join(', ');
  } catch (_) {}

  const domainDesc = contentPreferences.length
    ? contentPreferences.join(' and ')
    : 'language development, literacy, science exploration, and social-emotional learning';
  const query = childContext
    ? `${domainDesc} ideas for ${resolved.join(', ')} for children (${childContext})`
    : `${domainDesc} ideas for ${resolved.join(', ')}`;

  let tips = [];
  try {
    const result = await personalizationService.generatePersonalizedTipsForQuery(
      userId,
      query,
      3,
      contentPreferences,
    );
    tips = Array.isArray(result) ? result : (result.tips || []);
    if (!tips.length) throw new Error('empty result');
  } catch (err) {
    console.log('Reminder tip generation failed, falling back to popular tips:', err.message);
    try {
      tips = await personalizationService.getPopularTips(3);
    } catch (fallbackErr) {
      console.error('Popular-tips fallback also failed:', fallbackErr.message);
      tips = [];
    }
  }

  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const normalized = tips.slice(0, 3).map(t => ({
    title: clean(t.title || 'Parenting tip'),
    body: clean(t.body || t.description || ''),
  }));

  const title = 'Time for your ENACT activities!';
  const bodyLines = normalized
    .map((t, i) => (t.body ? `${i + 1}. ${t.title}: ${t.body}` : `${i + 1}. ${t.title}`))
    .filter(Boolean);
  const body = bodyLines.length ? bodyLines.join('\n') : `Tips for ${resolved.join(', ')}`;

  return res.status(200).json({ tips: normalized, title, body });
});

export default router;
export { SUPPORTED_ACTIVITIES };
