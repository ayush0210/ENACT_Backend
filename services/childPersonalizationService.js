// Child personalization: ownership-checked CRUD + validation/moderation +
// embedding bookkeeping for child_personalization_profiles.
//
// TRUST BOUNDARY: canonical option IDs are re-validated against
// utils/personalizationOptions.js on every write (never trust the client's
// own idea of category/age-fit/active-ness). Custom free text is re-run
// through utils/personalizationSafety.js on every write (never trust
// anything the frontend already "approved" — a client can call this API
// directly). Only normalized/approved values are ever passed to `embedFn`,
// written to the database, or returned to the caller.
//
// This module is written as a factory (`createChildPersonalizationService`)
// so tests can inject an in-memory fake pool and a fake embedding function
// instead of hitting MySQL/OpenAI — see tests/childPersonalizationService.test.js.
//
// Deliberately does NOT import config/db.js or services/personalizationService.js
// here: both have import-time side effects (config/db.js opens a real MySQL
// pool and probes it immediately; personalizationService.js constructs a real
// OpenAI client and imports config/db.js itself). Keeping this module free of
// those imports means requiring it — as the test file does — can never touch
// a live database or API, regardless of whether the test uses the default
// export. Production wiring (the real pool + the real embedding call) lives
// in routes/childPersonalization.js, which every other route in this project
// already imports pool/services the same eager way.
import {
    validateOptionIdsForCategory,
    optionsToPromptValues,
    PREFER_NOT_TO_ANSWER_ID,
} from '../utils/personalizationOptions.js';
import {
    validateAndNormalizePersonalizationInput,
    getNeutralRejectionMessage,
} from '../utils/personalizationSafety.js';

const CUSTOM_FIELD_TO_CATEGORY = {
    customFavorites: 'favorite',
    customSkills: 'skill',
    customSupportNeeds: 'support',
};

function isBlank(value) {
    return typeof value !== 'string' || value.replace(/\s+/g, '').length === 0;
}

function parseJsonArrayColumn(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function emptyProfile(childId) {
    return {
        childId,
        favorites: [],
        skillsInProgress: [],
        supportNeeds: [],
        customFavorites: [],
        customSkills: [],
        customSupportNeeds: [],
        lastReviewedAt: null,
        createdAt: null,
        updatedAt: null,
    };
}

function mapRowToProfile(childId, row) {
    if (!row) return emptyProfile(childId);
    return {
        childId,
        favorites: parseJsonArrayColumn(row.favorite_ids),
        skillsInProgress: parseJsonArrayColumn(row.skill_ids),
        supportNeeds: parseJsonArrayColumn(row.support_need_ids),
        customFavorites: parseJsonArrayColumn(row.custom_favorites),
        customSkills: parseJsonArrayColumn(row.custom_skills),
        customSupportNeeds: parseJsonArrayColumn(row.custom_support_needs),
        lastReviewedAt: row.last_reviewed_at
            ? new Date(row.last_reviewed_at).toISOString()
            : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
}

export function createChildPersonalizationService(dbPool, embedFn) {
    async function findOwnedChild(userId, childId) {
        const [rows] = await dbPool.query(
            'SELECT id, nickname, age, date_of_birth FROM children WHERE id = ? AND user_id = ?',
            [childId, userId],
        );
        return rows[0] || null;
    }

    async function findProfileRow(childId) {
        const [rows] = await dbPool.query(
            'SELECT * FROM child_personalization_profiles WHERE child_id = ?',
            [childId],
        );
        return rows[0] || null;
    }

    async function getProfile({ userId, childId }) {
        const child = await findOwnedChild(userId, childId);
        if (!child) {
            return {
                ok: false,
                status: 403,
                error: 'forbidden',
                message: 'Unauthorized access to child record',
            };
        }

        const row = await findProfileRow(childId);
        return { ok: true, status: 200, profile: mapRowToProfile(childId, row) };
    }

    // Validates every submitted option-ID array against the canonical
    // registry for the child's *current* age (age is a hard constraint here,
    // not a similarity boost — a stale selection from before a birthday
    // simply fails validation rather than being silently kept).
    function validateCanonicalSelections(payload, childAge) {
        const favorites = validateOptionIdsForCategory(payload.favorites, 'favorite', childAge);
        const skills = validateOptionIdsForCategory(payload.skillsInProgress, 'skill', childAge);
        const support = validateOptionIdsForCategory(payload.supportNeeds, 'support', childAge);

        const allErrors = [
            ...favorites.errors.map(e => ({ ...e, field: 'favorites' })),
            ...skills.errors.map(e => ({ ...e, field: 'skillsInProgress' })),
            ...support.errors.map(e => ({ ...e, field: 'supportNeeds' })),
        ];

        // "Prefer not to answer" clears conflicting support-need selections —
        // enforced server-side too, not just in the UI (defense in depth).
        let supportIds = support.validIds;
        if (supportIds.includes(PREFER_NOT_TO_ANSWER_ID)) {
            supportIds = [PREFER_NOT_TO_ANSWER_ID];
        }

        return {
            favoriteIds: favorites.validIds,
            skillIds: skills.validIds,
            supportNeedIds: supportIds,
            errors: allErrors,
        };
    }

    // Runs every non-blank custom text field through the safety pipeline.
    // Returns the first rejection found (each UI field maps to at most one
    // rejection at a time in practice), plus the approved arrays.
    function validateCustomText(payload, childAge) {
        const approved = { customFavorites: [], customSkills: [], customSupportNeeds: [] };

        for (const [field, category] of Object.entries(CUSTOM_FIELD_TO_CATEGORY)) {
            const values = Array.isArray(payload[field]) ? payload[field] : [];
            for (const raw of values) {
                if (isBlank(raw)) continue; // "no answer" — not a rejection
                const result = validateAndNormalizePersonalizationInput({
                    category,
                    value: raw,
                    childAge,
                });
                if (result.status !== 'approved') {
                    return {
                        rejection: { field, reasonCode: result.reasonCode || 'needs_review' },
                    };
                }
                approved[field].push(result.normalizedValue);
            }
        }

        return { approved };
    }

    async function computeCategoryEmbedding(canonicalIds, customTexts) {
        const text = [...optionsToPromptValues(canonicalIds), ...customTexts].join(', ');
        if (!text) return null;
        try {
            return await embedFn(text);
        } catch (err) {
            // Non-critical: personalization scoring simply falls back to
            // "no survey signal" for this category if embedding fails.
            console.warn('[childPersonalizationService] embedding failed (non-fatal):', err.message);
            return null;
        }
    }

    async function saveProfile({ userId, childId, payload }) {
        const child = await findOwnedChild(userId, childId);
        if (!child) {
            return {
                ok: false,
                status: 403,
                error: 'forbidden',
                message: 'Unauthorized access to child record',
            };
        }

        const childAge = Number.isInteger(child.age) ? child.age : 0;

        const { favoriteIds, skillIds, supportNeedIds, errors } = validateCanonicalSelections(
            payload || {},
            childAge,
        );
        if (errors.length > 0) {
            return {
                ok: false,
                status: 400,
                error: 'invalid_option',
                message: 'One or more selected options are invalid for this child.',
                details: errors,
            };
        }

        const customResult = validateCustomText(payload || {}, childAge);
        if (customResult.rejection) {
            return {
                ok: false,
                status: 422,
                error: 'personalization_rejected',
                field: customResult.rejection.field,
                message: getNeutralRejectionMessage(),
            };
        }

        const { customFavorites, customSkills, customSupportNeeds } = customResult.approved;

        const [favoritesEmbedding, skillsEmbedding, supportNeedsEmbedding] = await Promise.all([
            computeCategoryEmbedding(favoriteIds, customFavorites),
            computeCategoryEmbedding(skillIds, customSkills),
            computeCategoryEmbedding(supportNeedIds, customSupportNeeds),
        ]);

        const connection = await dbPool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.query(
                `INSERT INTO child_personalization_profiles
                    (child_id, favorite_ids, skill_ids, support_need_ids,
                     custom_favorites, custom_skills, custom_support_needs,
                     favorites_embedding, skills_embedding, support_needs_embedding,
                     last_reviewed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    favorite_ids = VALUES(favorite_ids),
                    skill_ids = VALUES(skill_ids),
                    support_need_ids = VALUES(support_need_ids),
                    custom_favorites = VALUES(custom_favorites),
                    custom_skills = VALUES(custom_skills),
                    custom_support_needs = VALUES(custom_support_needs),
                    favorites_embedding = VALUES(favorites_embedding),
                    skills_embedding = VALUES(skills_embedding),
                    support_needs_embedding = VALUES(support_needs_embedding),
                    last_reviewed_at = NOW()`,
                [
                    childId,
                    JSON.stringify(favoriteIds),
                    JSON.stringify(skillIds),
                    JSON.stringify(supportNeedIds),
                    JSON.stringify(customFavorites),
                    JSON.stringify(customSkills),
                    JSON.stringify(customSupportNeeds),
                    favoritesEmbedding ? JSON.stringify(favoritesEmbedding) : null,
                    skillsEmbedding ? JSON.stringify(skillsEmbedding) : null,
                    supportNeedsEmbedding ? JSON.stringify(supportNeedsEmbedding) : null,
                ],
            );
            await connection.commit();
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }

        const row = await findProfileRow(childId);
        return { ok: true, status: 200, profile: mapRowToProfile(childId, row) };
    }

    async function confirmCurrent({ userId, childId }) {
        const child = await findOwnedChild(userId, childId);
        if (!child) {
            return {
                ok: false,
                status: 403,
                error: 'forbidden',
                message: 'Unauthorized access to child record',
            };
        }

        const existing = await findProfileRow(childId);
        if (!existing) {
            return {
                ok: false,
                status: 404,
                error: 'not_found',
                message: 'No personalization profile to confirm yet.',
            };
        }

        await dbPool.query(
            'UPDATE child_personalization_profiles SET last_reviewed_at = NOW() WHERE child_id = ?',
            [childId],
        );

        const row = await findProfileRow(childId);
        return { ok: true, status: 200, profile: mapRowToProfile(childId, row) };
    }

    return { getProfile, saveProfile, confirmCurrent, mapRowToProfile, emptyProfile };
}
