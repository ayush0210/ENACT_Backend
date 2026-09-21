import express from 'express';
import { authenticateJWT } from './middleware.js';
import pool from '../config/db.js';
import personalizationService from '../services/personalizationService.js';
import { createChildPersonalizationService } from '../services/childPersonalizationService.js';

const router = express.Router();

// Production wiring: the real MySQL pool and the real embedding call (same
// OpenAI wrapper/cache the rest of personalization uses). See
// services/childPersonalizationService.js for why this lives here rather
// than as a default export of that module.
const childPersonalizationService = createChildPersonalizationService(pool, text =>
    personalizationService.generateQueryEmbedding(text),
);

function parseChildId(req, res) {
    const childId = Number(req.params.childId);
    if (!Number.isInteger(childId) || childId <= 0) {
        res.status(400).json({ success: false, error: 'invalid_child_id', message: 'Invalid child id' });
        return null;
    }
    return childId;
}

// Maps a service-layer result onto the HTTP response. Service results never
// carry raw rejected text, stack traces, or internal moderation detail — see
// services/childPersonalizationService.js and utils/personalizationSafety.js.
function respond(res, result) {
    if (result.ok) {
        return res.status(result.status).json({ success: true, profile: result.profile });
    }

    const body = { success: false, error: result.error, message: result.message };
    if (result.field) body.field = result.field;
    if (result.details) body.details = result.details;
    return res.status(result.status).json(body);
}

router.get('/:childId/personalization', authenticateJWT, async (req, res) => {
    const childId = parseChildId(req, res);
    if (childId === null) return;

    try {
        const result = await childPersonalizationService.getProfile({
            userId: req.user.id,
            childId,
        });
        return respond(res, result);
    } catch (error) {
        console.error('Error fetching child personalization profile:', error.message);
        return res.status(500).json({
            success: false,
            error: 'internal_error',
            message: 'Failed to fetch personalization profile',
        });
    }
});

router.put('/:childId/personalization', authenticateJWT, async (req, res) => {
    const childId = parseChildId(req, res);
    if (childId === null) return;

    const payload = req.body || {};
    const arrayFields = [
        'favorites',
        'skillsInProgress',
        'supportNeeds',
        'customFavorites',
        'customSkills',
        'customSupportNeeds',
    ];
    for (const field of arrayFields) {
        if (payload[field] !== undefined && !Array.isArray(payload[field])) {
            return res.status(400).json({
                success: false,
                error: 'invalid_payload',
                message: `${field} must be an array`,
            });
        }
    }

    try {
        const result = await childPersonalizationService.saveProfile({
            userId: req.user.id,
            childId,
            payload,
        });
        return respond(res, result);
    } catch (error) {
        console.error('Error saving child personalization profile:', error.message);
        return res.status(500).json({
            success: false,
            error: 'internal_error',
            message: 'Failed to save personalization profile',
        });
    }
});

router.post('/:childId/personalization/confirm-current', authenticateJWT, async (req, res) => {
    const childId = parseChildId(req, res);
    if (childId === null) return;

    try {
        const result = await childPersonalizationService.confirmCurrent({
            userId: req.user.id,
            childId,
        });
        return respond(res, result);
    } catch (error) {
        console.error('Error confirming child personalization profile:', error.message);
        return res.status(500).json({
            success: false,
            error: 'internal_error',
            message: 'Failed to confirm personalization profile',
        });
    }
});

export default router;
