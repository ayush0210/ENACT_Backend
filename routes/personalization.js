import express from 'express';
import { authenticateJWT } from './middleware.js';
import personalizationService from '../services/personalizationService.js';
import {
    isStrictlyInScope,
    REJECTION_MESSAGE,
} from '../utils/strictDomains.js';
import pool from '../config/db.js';
import {
    validateParentingQuery,
    CATEGORY_RESPONSES,
} from '../utils/parentingGuardrails.js';

// --- Soft parenting detectors (very permissive, no safety bypass) ---
const CHILD_TERMS = [
    'child',
    'kid',
    'toddler',
    'baby',
    'infant',
    'newborn',
    'teen',
    'teenager',
    'preteen',
    'preschooler',
    'pre-schooler',
    'son',
    'daughter',
    'my kid',
    'my child',
    'my toddler',
    'my baby',
    'students',
    'kids',
    'children',
    'parenting',
];

const AGE_PATTERNS = [
    /\b\d{1,2}\s?(?:yo|yrs?|years?)\b/i, // 3yo, 3 yrs
    /\b\d{1,2}\s?(?:-| )?year[-\s]?old\b/i, // 3-year-old
    /\b\d{1,2}\s?(?:months?|mos?)\s?old\b/i, // 18 months old
];

export function looksLikeParentingPrompt(q) {
    const n = String(q || '').toLowerCase();
    const childHit = CHILD_TERMS.some(term => n.includes(term));
    const ageHit = AGE_PATTERNS.some(re => re.test(n));
    return childHit || ageHit;
}

// If validator says "non_parenting" but our soft check says "this really is about kids",
// we can nudge the LLM by reframing the text once.
export function reframeAsParenting(
    prompt,
    note = 'Please answer strictly as parenting advice for a child.',
) {
    console.log('reframingParenitng', `${prompt}\n\nContext: ${note}`);
    return `${prompt}\n\nContext: ${note}`;
}

const router = express.Router();

export function categoryReply(category, originalQuery) {
    const cfg =
        CATEGORY_RESPONSES[category] || CATEGORY_RESPONSES.non_parenting;
    // You can tailor suggestion seeds here by category if you want
    const suggestions = [
        'Ask about a calming bedtime routine',
        'Activities for a 3-year-old on a rainy day',
        'Sharing and turn-taking tips',
        'Gentle discipline ideas for toddlers',
    ];
    return {
        status: cfg.http,
        payload: {
            error: category,
            message: cfg.msg,
            isParentingRelated: false,
            originalQuery,
            suggestions,
        },
    };
}

// Track user interaction with a tip (like/dislike/save/unsave)
router.post('/interactions', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { tipId, interactionType, tipPayload } = req.body;
        const validTypes = ['like', 'dislike', 'save', 'unsave'];
        if (!validTypes.includes(interactionType)) {
            return res.status(400).json({
                error: 'Invalid interaction type. Must be one of: like, dislike, save, unsave',
            });
        }
        if (!tipId) {
            return res.status(400).json({ error: 'Tip ID is required' });
        }
        let finalTipId = tipId;
        if (String(tipId).startsWith('generated_')) {
            finalTipId = await personalizationService.upsertGeneratedTip(
                tipId,
                tipPayload,
            );
        }
        await personalizationService.trackUserInteraction(
            userId,
            finalTipId,
            interactionType,
        );
        res.status(200).json({
            message: 'Interaction tracked successfully',
            userId,
            tipId: finalTipId,
            interactionType,
        });
    } catch (error) {
        console.error('Error tracking interaction:', error);
        res.status(500).json({
            error: 'Failed to track interaction',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Personalized recommendations feed
router.get('/recommendations', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 10;
        const tips = await personalizationService.getPersonalizedTips(
            userId,
            limit,
        );
        res.status(200).json({
            tips,
            userId,
            isPersonalized: tips.length > 0,
        });
    } catch (error) {
        console.error('Error getting personalized recommendations:', error);
        res.status(500).json({
            error: 'Failed to get personalized recommendations',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Hybrid enhanced-tips endpoint with parenting guardrails
router.post('/enhanced-tips', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            prompt,
            contentPreferences = [],
            generateMode = 'hybrid',
        } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Soft override handling
        let effectivePrompt = prompt;
        const v = validateParentingQuery(prompt);
        if (!v.isValid) {
            if (looksLikeParentingPrompt(prompt)) {
                effectivePrompt = reframeAsParenting(
                    prompt,
                    'This question is about my child. Provide age-appropriate, safe, practical parenting strategies.',
                );
            } else {
                const { status, payload } = categoryReply(v.type, prompt);
                return res.status(status).json(payload);
            }
        }

        console.log(
            `✅ Validated parenting query (mode: ${generateMode}) original="${prompt}" effective="${effectivePrompt}"`,
        );

        let result = null;
        if (generateMode === 'generate') {
            // Pure AI mode (respect contentPreferences)
            result =
                await personalizationService.generatePersonalizedTipsForQuery(
                    userId,
                    effectivePrompt,
                    5,
                    contentPreferences,
                );
            return res.status(200).json({
                tips: result.tips,
                isPersonalized: result.isPersonalized,
                isGenerated: result.isGenerated,
                originalQuery: prompt,
                source: 'ai_generated',
                message: result.isPersonalized
                    ? `Generated ${result.tips.length} personalized parenting tips about "${prompt}" just for you!`
                    : `Generated ${result.tips.length} parenting tips about "${prompt}"`,
                preferenceContext: result.preferenceContext,
            });
        } else if (generateMode === 'database') {
            // DB search only (respect contentPreferences)
            result = await personalizationService.getContextualPersonalizedTips(
                userId,
                effectivePrompt,
                3,
                contentPreferences,
            );
            if (result.tips && result.tips.length > 0) {
                return res.status(200).json({
                    tips: result.tips,
                    isPersonalized: result.isPersonalized,
                    isGenerated: false,
                    originalQuery: prompt,
                    source: 'database_search',
                    message: `Found ${result.tips.length} relevant parenting tips about "${prompt}" in our database`,
                });
            }
        } else {
            // Hybrid: DB first, then AI fallback
            console.log(
                `🔍 DB-first search for "${prompt}" (effective="${effectivePrompt}")`,
            );
            result = await personalizationService.getContextualPersonalizedTips(
                userId,
                effectivePrompt,
                3,
                contentPreferences,
            );
            if (result.tips && result.tips.length > 0) {
                return res.status(200).json({
                    tips: result.tips,
                    isPersonalized: result.isPersonalized,
                    isGenerated: false,
                    originalQuery: prompt,
                    source: 'database_found',
                    message: result.isPersonalized
                        ? `Found ${result.tips.length} relevant parenting tips about "${prompt}" tailored to your preferences`
                        : `Found ${result.tips.length} relevant parenting tips about "${prompt}"`,
                });
            }

            // AI fallback
            console.log(
                `🤖 No DB results, generating AI parenting tips for "${prompt}" (effective="${effectivePrompt}")`,
            );
            result =
                await personalizationService.generatePersonalizedTipsForQuery(
                    userId,
                    effectivePrompt,
                    3,
                    contentPreferences,
                );
            if (result.tips && result.tips.length > 0) {
                return res.status(200).json({
                    tips: result.tips,
                    isPersonalized: result.isPersonalized,
                    isGenerated: result.isGenerated,
                    originalQuery: prompt,
                    source: 'ai_generated_fallback',
                    message: result.isPersonalized
                        ? `Generated ${result.tips.length} personalized parenting tips about "${prompt}" just for you!`
                        : `Generated ${result.tips.length} custom parenting tips about "${prompt}"`,
                    preferenceContext: result.preferenceContext,
                });
            }
        }

        // Ultimate fallback
        console.log(
            `❌ All methods failed for parenting query: "${prompt}" (effective="${effectivePrompt}")`,
        );
        res.status(200).json({
            tips: [],
            isPersonalized: false,
            isGenerated: false,
            originalQuery: prompt,
            source: 'no_results',
            message: `Sorry, I couldn't find or generate parenting tips about "${prompt}". Try asking about more general parenting topics like bedtime routines, activities for your child's age, or developmental milestones.`,
        });
    } catch (error) {
        console.error('Error in enhanced tips:', error);
        res.status(500).json({
            error: 'Failed to get enhanced tips',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// AI-only endpoint with parenting guardrails
router.post('/generate-tips', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { prompt, count = 5, contentPreferences = [] } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt is required' });
        }

        // Soft override handling
        let effectivePrompt = prompt;
        const v = validateParentingQuery(prompt);
        if (!v.isValid) {
            if (looksLikeParentingPrompt(prompt)) {
                effectivePrompt = reframeAsParenting(
                    prompt,
                    'This question is about my child. Provide age-appropriate, safe, practical parenting strategies.',
                );
            } else {
                const { status, payload } = categoryReply(v.type, prompt);
                return res.status(status).json(payload);
            }
        }

        console.log(
            `🤖 AI generation request (original="${prompt}", effective="${effectivePrompt}") user=${userId}`,
        );

        const result =
            await personalizationService.generatePersonalizedTipsForQuery(
                userId,
                effectivePrompt,
                count,
                contentPreferences,
            );
        res.status(200).json({
            tips: result.tips,
            isPersonalized: result.isPersonalized,
            isGenerated: true,
            originalQuery: prompt,
            source: 'ai_generated',
            message: result.isPersonalized
                ? `Generated ${result.tips.length} personalized parenting tips about "${prompt}" based on your preferences!`
                : `Generated ${result.tips.length} parenting tips about "${prompt}"`,
            preferenceContext: result.preferenceContext,
            generationStats: {
                avgPersonalMatch:
                    result.tips.length > 0
                        ? result.tips.reduce(
                              (sum, tip) => sum + tip.personal_match,
                              0,
                          ) / result.tips.length
                        : 0,
            },
        });
    } catch (error) {
        console.error('Error generating tips:', error);
        res.status(500).json({
            error: 'Failed to generate tips',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// POST /api/personalization/ai-interactions/batch
router.post('/ai-interactions/batch', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { interactions = [] } = req.body || {};
        if (!Array.isArray(interactions)) {
            return res
                .status(400)
                .json({ error: 'interactions must be an array' });
        }

        let persisted = 0;
        for (const item of interactions) {
            // accept either interactionType or kind
            const interactionType = item?.interactionType || item?.kind;
            const rawTipId = item?.tipId;
            if (
                !interactionType ||
                !['like', 'dislike', 'save', 'unsave'].includes(interactionType)
            )
                continue;
            if (!rawTipId) continue;

            // If AI-generated (e.g. "generated_..."), insert into tips first and embed
            const tipId = await ensureTipExists(rawTipId, {
                title: item?.title,
                body: item?.body,
                details: item?.details,
                categories: item?.categories,
            });

            try {
                await personalizationService.trackUserInteraction(
                    userId,
                    tipId,
                    interactionType,
                );
                persisted++;
            } catch (e) {
                console.warn(
                    'Skipping one interaction due to error:',
                    e.message,
                );
            }
        }

        return res.json({ ok: true, count: persisted, userId });
    } catch (e) {
        console.error('ai-interactions/batch error:', e);
        return res.status(500).json({ error: 'failed to record interactions' });
    }
});

// Profile summary
router.get('/profile', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const [profile] = await pool.query(
            `
      SELECT 
        total_interactions,
        last_updated,
        (SELECT COUNT(*) FROM user_tip_interactions WHERE user_id = ? AND interaction_type = 'like') as liked_tips,
        (SELECT COUNT(*) FROM user_tip_interactions WHERE user_id = ? AND interaction_type = 'dislike') as disliked_tips,
        (SELECT COUNT(*) FROM user_tip_interactions WHERE user_id = ? AND interaction_type = 'save') as saved_tips
      FROM user_preference_profiles 
      WHERE user_id = ?
    `,
            [userId, userId, userId, userId],
        );

        const userProfile =
            profile.length > 0
                ? profile[0]
                : {
                      total_interactions: 0,
                      last_updated: null,
                      liked_tips: 0,
                      disliked_tips: 0,
                      saved_tips: 0,
                  };

        res.status(200).json({
            userId,
            profile: userProfile,
            hasPreferences:
                profile.length > 0 && profile[0].total_interactions > 0,
        });
    } catch (error) {
        console.error('Error getting user profile:', error);
        res.status(500).json({
            error: 'Failed to get user profile',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

export function safeJSONParse(jsonString, fallback = []) {
    try {
        if (!jsonString && jsonString !== 0) {
            return fallback;
        }
        // If it's already an array, return it
        if (Array.isArray(jsonString)) {
            return jsonString;
        }
        // If it's a string, try to parse it
        if (typeof jsonString === 'string') {
            // Handle case where it might just be a comma-separated string
            if (!jsonString.startsWith('[') && !jsonString.startsWith('{')) {
                // Convert "activities,discipline" to ["activities", "discipline"]
                return jsonString
                    .split(',')
                    .map(item => item.trim())
                    .filter(Boolean);
            }
            return JSON.parse(jsonString);
        }
        return fallback;
    } catch (error) {
        console.error('JSON parse error:', error.message, 'Input:', jsonString);
        // Try to salvage the data if it's comma-separated
        if (typeof jsonString === 'string' && jsonString.includes(',')) {
            return jsonString
                .split(',')
                .map(item => item.trim())
                .filter(Boolean);
        }
        // If it's a single value, wrap it in an array
        if (typeof jsonString === 'string' && jsonString.length > 0) {
            return [jsonString.trim()];
        }
        return fallback;
    }
}

router.post('/survey', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { surveyData } = req.body;
        if (!surveyData) {
            return res.status(400).json({ error: 'Survey data is required' });
        }

        const {
            contentPreferences = [],
            challengeAreas = [],
            parentingGoals = [],
            engagementFrequency,
            currentChallenge,
            additionalNotes,
        } = surveyData;

        // Validate required fields
        if (!engagementFrequency) {
            return res
                .status(400)
                .json({ error: 'Engagement frequency is required' });
        }

        const validFrequencies = [
            'daily',
            'few-times-week',
            'weekly',
            'on-demand',
        ];
        if (!validFrequencies.includes(engagementFrequency)) {
            return res.status(400).json({
                error: 'Invalid engagement frequency',
                validOptions: validFrequencies,
            });
        }

        console.log(`💾 Saving survey for user ${userId}:`, {
            contentPreferences: contentPreferences.length,
            challengeAreas: challengeAreas.length,
            parentingGoals: parentingGoals.length,
            engagementFrequency,
        });

        // Save survey response
        await pool.query(
            `
      INSERT INTO user_survey_responses 
      (user_id, content_preferences, challenge_areas, parenting_goals, 
       engagement_frequency, current_challenge, additional_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
      content_preferences = VALUES(content_preferences),
      challenge_areas = VALUES(challenge_areas),
      parenting_goals = VALUES(parenting_goals),
      engagement_frequency = VALUES(engagement_frequency),
      current_challenge = VALUES(current_challenge),
      additional_notes = VALUES(additional_notes),
      updated_at = CURRENT_TIMESTAMP
    `,
            [
                userId,
                JSON.stringify(contentPreferences),
                JSON.stringify(challengeAreas),
                JSON.stringify(parentingGoals),
                engagementFrequency,
                currentChallenge || null,
                additionalNotes || null,
            ],
        );

        // Generate embeddings for survey preferences
        await generateSurveyEmbeddings(userId, surveyData);

        // Update combined preference profile
        await updateCombinedPreferenceProfile(userId);

        res.status(200).json({
            success: true,
            message: 'Survey saved successfully',
            userId,
            surveyData: {
                contentPreferences,
                challengeAreas,
                parentingGoals,
                engagementFrequency,
                hasCurrentChallenge: !!currentChallenge,
                hasAdditionalNotes: !!additionalNotes,
            },
        });
    } catch (error) {
        console.error('Error saving survey:', error);
        res.status(500).json({
            error: 'Failed to save survey',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Get user survey status
router.get('/survey-status', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const [survey] = await pool.query(
            'SELECT completed_at, updated_at FROM user_survey_responses WHERE user_id = ?',
            [userId],
        );

        res.status(200).json({
            userId,
            hasCompletedSurvey: survey.length > 0,
            completedAt: survey.length > 0 ? survey[0].completed_at : null,
            lastUpdated: survey.length > 0 ? survey[0].updated_at : null,
        });
    } catch (error) {
        console.error('Error getting survey status:', error);
        res.status(500).json({
            error: 'Failed to get survey status',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Get full survey data
router.get('/survey', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const [survey] = await pool.query(
            'SELECT * FROM user_survey_responses WHERE user_id = ?',
            [userId],
        );

        if (survey.length === 0) {
            return res.status(404).json({
                error: 'No survey found',
                hasCompletedSurvey: false,
            });
        }

        const surveyData = survey[0];
        res.status(200).json({
            userId,
            hasCompletedSurvey: true,
            surveyData: {
                contentPreferences: safeJSONParse(
                    surveyData.content_preferences,
                ),
                challengeAreas: safeJSONParse(surveyData.challenge_areas),
                parentingGoals: safeJSONParse(surveyData.parenting_goals),
                engagementFrequency: surveyData.engagement_frequency,
                currentChallenge: surveyData.current_challenge,
                additionalNotes: surveyData.additional_notes,
                completedAt: surveyData.completed_at,
                updatedAt: surveyData.updated_at,
            },
        });
    } catch (error) {
        console.error('Error getting survey data:', error);
        res.status(500).json({
            error: 'Failed to get survey data',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Enhanced tips with survey integration
router.post('/enhanced-tips-survey', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            prompt,
            contentPreferences = [],
            generateMode = 'hybrid',
        } = req.body;

        // BUGFIX: Validate prompt input
        if (!prompt || typeof prompt !== 'string') {
            return res.status(400).json({ error: 'Prompt is required and must be a string' });
        }

        const sanitizedPrompt = prompt.trim();
        if (sanitizedPrompt.length === 0) {
            return res.status(400).json({ error: 'Prompt cannot be empty' });
        }

        if (sanitizedPrompt.length > 1000) {
            return res.status(400).json({ error: 'Prompt is too long (max 1000 characters)' });
        }

        // Soft override handling
        let effectivePrompt = sanitizedPrompt;
        const v = isStrictlyInScope(sanitizedPrompt);
        if (!v.isValid) {
            // CRITICAL: Block harmful content even if it has child terms
            if (v.reason === 'harmful_content') {
                const { status, payload } = categoryReply(v.reason, sanitizedPrompt);
                return res.status(status).json(payload);
            }

            if (looksLikeParentingPrompt(sanitizedPrompt)) {
                effectivePrompt = reframeAsParenting(
                    sanitizedPrompt,
                    'This question is about my child. Strictly Provide age-appropriate, safe, practical parenting strategies.',
                );
            } else {
                const { status, payload } = categoryReply(v.type, sanitizedPrompt);
                return res.status(status).json(payload);
            }
        }

        console.log(
            `✅ Validated parenting query (survey) mode=${generateMode} original="${prompt}" effective="${effectivePrompt}"`,
        );

        // Get survey data to enhance recommendations
        const [surveyData] = await pool.query(
            'SELECT content_preferences, challenge_areas, parenting_goals, current_challenge FROM user_survey_responses WHERE user_id = ?',
            [userId],
        );

        let enhancedContentPrefs = [];
        let surveyContext = '';
        let hasSurveyData = false;

        if (surveyData.length > 0) {
            const survey = surveyData[0];
            const userPrefs = safeJSONParse(survey.content_preferences);
            // const userChallenges = safeJSONParse(survey.challenge_areas);
            // const userGoals = safeJSONParse(survey.parenting_goals);

            // Merge preferences
            enhancedContentPrefs = [
                ...new Set([...enhancedContentPrefs, ...userPrefs]),
            ];
            hasSurveyData = true;

            // Build context for AI
            surveyContext = buildSurveyContext(survey);
        }

        let result = null;

        // OPTIMIZATION: Hybrid mode should try DB first (fast), then AI fallback
        if (generateMode === 'hybrid' || generateMode === 'database') {
            // Try database search first (much faster)
            result = await personalizationService.getContextualPersonalizedTips(
                userId,
                effectivePrompt,
                5,
                enhancedContentPrefs,
            );

            if (result.tips && result.tips.length > 0) {
                return res.status(200).json({
                    tips: result.tips,
                    isPersonalized: result.isPersonalized || hasSurveyData,
                    isGenerated: false,
                    hasSurveyPersonalization: hasSurveyData,
                    originalQuery: prompt,
                    source: 'database_search_with_survey',
                    message: `Found ${result.tips.length} relevant parenting tips about "${prompt}"`,
                });
            }

            // If database mode only, stop here
            if (generateMode === 'database') {
                return res.status(200).json({
                    tips: [],
                    isPersonalized: hasSurveyData,
                    isGenerated: false,
                    hasSurveyPersonalization: hasSurveyData,
                    originalQuery: prompt,
                    source: 'no_results',
                    message: `No database tips found for "${prompt}"`,
                });
            }
        }

        // AI generation (for 'generate' mode or 'hybrid' fallback)
        if (generateMode === 'generate' || generateMode === 'hybrid') {
            const enhancedPrompt = surveyContext
                ? `${effectivePrompt}\n\nUser Context: ${surveyContext}`
                : effectivePrompt;

            result =
                await personalizationService.generatePersonalizedTipsForQuery(
                    userId,
                    enhancedPrompt,
                    5,
                    enhancedContentPrefs,
                );

            if (result.tips && result.tips.length > 0) {
                // Apply survey-based scoring boost
                if (hasSurveyData) {
                    result.tips = await applySurveyScoring(
                        result.tips,
                        surveyData,
                    );
                }

                return res.status(200).json({
                    tips: result.tips,
                    isPersonalized: result.isPersonalized || hasSurveyData,
                    isGenerated: result.isGenerated,
                    hasSurveyPersonalization: hasSurveyData,
                    originalQuery: prompt,
                    source: generateMode === 'hybrid' ? 'ai_fallback_with_survey' : 'ai_generated_with_survey',
                    message: hasSurveyData
                        ? `Generated ${result.tips.length} personalized parenting tips about "${prompt}" based on your survey preferences!`
                        : `Generated ${result.tips.length} parenting tips about "${prompt}"`,
                    surveyContext: surveyContext,
                });
            }
        }

        // No results found
        res.status(200).json({
            tips: [],
            isPersonalized: hasSurveyData,
            isGenerated: false,
            hasSurveyPersonalization: hasSurveyData,
            originalQuery: prompt,
            source: 'no_results',
            message: `Sorry, I couldn't find parenting tips about "${prompt}". Try asking about bedtime routines, activities, or developmental milestones.`,
        });
    } catch (error) {
        console.error('Error in enhanced tips with survey:', error);
        res.status(500).json({
            error: 'Failed to get enhanced tips',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Survey analytics
router.get('/survey-analytics', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const [survey] = await pool.query(
            'SELECT completed_at FROM user_survey_responses WHERE user_id = ?',
            [userId],
        );

        if (survey.length === 0) {
            return res.status(200).json({
                hasCompletedSurvey: false,
                analytics: null,
                message:
                    'Complete the personalization survey to see your analytics',
            });
        }

        const surveyDate = survey[0].completed_at;

        // Get interaction metrics before and after survey
        const [metrics] = await pool.query(
            `
      SELECT 
        COUNT(CASE WHEN uti.created_at < ? THEN 1 END) as interactions_before,
        COUNT(CASE WHEN uti.created_at >= ? THEN 1 END) as interactions_after,
        COUNT(CASE WHEN uti.created_at < ? AND uti.interaction_type = 'like' THEN 1 END) as likes_before,
        COUNT(CASE WHEN uti.created_at >= ? AND uti.interaction_type = 'like' THEN 1 END) as likes_after
      FROM user_tip_interactions uti
      WHERE uti.user_id = ?
    `,
            [surveyDate, surveyDate, surveyDate, surveyDate, userId],
        );

        const data = metrics[0];
        const likeRateBefore =
            data.interactions_before > 0
                ? (data.likes_before / data.interactions_before) * 100
                : 0;
        const likeRateAfter =
            data.interactions_after > 0
                ? (data.likes_after / data.interactions_after) * 100
                : 0;
        const improvement = likeRateAfter - likeRateBefore;

        res.status(200).json({
            userId,
            hasCompletedSurvey: true,
            surveyCompletedAt: surveyDate,
            analytics: {
                interactionsBefore: data.interactions_before,
                interactionsAfter: data.interactions_after,
                likeRateBefore: Math.round(likeRateBefore * 10) / 10,
                likeRateAfter: Math.round(likeRateAfter * 10) / 10,
                improvement: Math.round(improvement * 10) / 10,
                hasImprovement: improvement > 0,
                message:
                    improvement > 5
                        ? `Your tip relevance improved by ${Math.round(improvement)}% after completing the survey!`
                        : data.interactions_after < 5
                        ? 'Keep interacting with tips to see your personalization improvement!'
                        : 'Your personalized tips are getting better as you use the app!',
            },
        });
    } catch (error) {
        console.error('Error getting survey analytics:', error);
        res.status(500).json({
            error: 'Failed to get survey analytics',
            details:
                process.env.NODE_ENV === 'development'
                    ? error.message
                    : undefined,
        });
    }
});

// Helper functions
async function generateSurveyEmbeddings(userId, surveyData) {
    const { contentPreferences, challengeAreas, parentingGoals } = surveyData;

    // Clear existing survey embeddings
    await pool.query(
        'DELETE FROM survey_preference_embeddings WHERE user_id = ?',
        [userId],
    );

    const preferenceTypes = [
        { type: 'content', values: contentPreferences },
        { type: 'challenge', values: challengeAreas },
        { type: 'goal', values: parentingGoals },
    ];

    for (const { type, values } of preferenceTypes) {
        for (const value of values) {
            try {
                const descriptiveText = getDescriptiveText(type, value);
                const embedding =
                    await personalizationService.generateQueryEmbedding(
                        descriptiveText,
                    );

                await pool.query(
                    `
          INSERT INTO survey_preference_embeddings 
          (user_id, preference_type, preference_value, embedding)
          VALUES (?, ?, ?, ?)
        `,
                    [userId, type, value, JSON.stringify(embedding)],
                );
            } catch (error) {
                console.error(
                    `Error generating embedding for ${type}:${value}`,
                    error,
                );
            }
        }
    }
}

function getDescriptiveText(type, value) {
    const descriptions = {
        content: {
            activities:
                'fun educational activities and games for children play time learning',
            discipline:
                'positive discipline strategies behavior management parenting techniques',
            emotional:
                'emotional support connection empathy understanding child feelings',
            routines:
                'daily routines structure schedules consistency parenting habits',
            sleep: 'sleep help bedtime routines rest nighttime parenting',
            nutrition: 'healthy eating nutrition meals food parenting feeding',
            potty: 'potty training toilet training bathroom independence',
            'screen-time':
                'screen time management technology devices digital parenting',
            travel: 'traveling with kids family trips vacation parenting',
            'big-feelings':
                'managing big emotions anxiety anger sadness parenting support',
        },
        challenge: {
            tantrums: 'tantrum meltdown crying screaming upset child behavior',
            bedtime: 'bedtime struggles sleep problems nighttime routine',
            'picky-eating':
                'picky eating food battles mealtime struggles nutrition',
            'sibling-rivalry':
                'sibling fighting rivalry jealousy sharing problems',
            'screen-battles': 'screen time battles technology device conflicts',
            'public-behavior':
                'public behavior store restaurant outings social situations',
            homework: 'homework resistance school work study struggles',
            transitions: 'transitions difficulty changing activities leaving',
        },
        goal: {
            patience: 'patience calm gentle understanding mindful parenting',
            connection: 'connection bonding relationship closeness family time',
            independence:
                'independence self-reliance confidence capability building',
            confidence:
                'confidence self-esteem pride capability child development',
            consistency:
                'consistency routine structure reliable predictable parenting',
            communication:
                'communication talking listening understanding dialogue',
            balance: 'work-life balance time management organization family',
            stress: 'stress reduction calm peaceful relaxed parenting',
        },
    };

    return (
        descriptions[type]?.[value] || `${type} ${value} parenting help advice`
    );
}

export function buildSurveyContext(survey) {
    const contentPrefs = safeJSONParse(survey.content_preferences);
    const challenges = safeJSONParse(survey.challenge_areas);
    const goals = safeJSONParse(survey.parenting_goals);

    let context = '';
    if (contentPrefs.length > 0) {
        context += `User prefers ${contentPrefs.join(', ')} type content. `;
    }
    if (challenges.length > 0) {
        context += `Current challenges include: ${challenges.join(', ')}. `;
    }
    if (goals.length > 0) {
        context += `Parenting goals: ${goals.join(', ')}. `;
    }
    if (survey.current_challenge) {
        context += `Specific current challenge: ${survey.current_challenge}. `;
    }
    return context;
}

async function updateCombinedPreferenceProfile(userId) {
    // This integrates survey data with your existing interaction-based preferences
    // The survey embeddings will be combined with like/dislike embeddings
    try {
        // Get existing interaction-based preference
        const [existingProfile] = await pool.query(
            'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
            [userId],
        );

        let interactionEmbedding = null;
        if (
            existingProfile.length > 0 &&
            existingProfile[0].preference_embedding
        ) {
            interactionEmbedding = Array.isArray(
                existingProfile[0].preference_embedding,
            )
                ? existingProfile[0].preference_embedding
                : JSON.parse(existingProfile[0].preference_embedding);
        }

        // Get survey-based preferences
        const [surveyEmbeddings] = await pool.query(
            'SELECT embedding FROM survey_preference_embeddings WHERE user_id = ?',
            [userId],
        );

        if (surveyEmbeddings.length === 0) return;

        // Average survey embeddings
        const surveyVectors = surveyEmbeddings.map(row =>
            Array.isArray(row.embedding)
                ? row.embedding
                : JSON.parse(row.embedding),
        );
        const dimension = surveyVectors[0].length;
        const surveyAverage = new Array(dimension).fill(0);

        for (const vector of surveyVectors) {
            for (let i = 0; i < dimension; i++) {
                surveyAverage[i] += vector[i];
            }
        }
        for (let i = 0; i < dimension; i++) {
            surveyAverage[i] /= surveyVectors.length;
        }

        // Combine with interaction data
        let combinedEmbedding;
        let surveyWeight = 0.7; // Start with high survey weight

        if (interactionEmbedding) {
            const [interactionCount] = await pool.query(
                'SELECT COUNT(*) as count FROM user_tip_interactions WHERE user_id = ?',
                [userId],
            );
            const interactions = interactionCount[0].count;
            surveyWeight = Math.max(0.3, 0.7 - interactions * 0.02);

            combinedEmbedding = surveyAverage.map(
                (sv, i) =>
                    sv * surveyWeight +
                    interactionEmbedding[i] * (1 - surveyWeight),
            );
        } else {
            combinedEmbedding = surveyAverage;
        }

        // Normalize
        const norm = Math.sqrt(
            combinedEmbedding.reduce((sum, val) => sum + val * val, 0),
        );
        if (norm > 0) {
            combinedEmbedding = combinedEmbedding.map(val => val / norm);
        }

        // Update preference profile
        await pool.query(
            `
      INSERT INTO user_preference_profiles 
      (user_id, preference_embedding, survey_embedding, survey_weight, last_survey_update)
      VALUES (?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
      preference_embedding = VALUES(preference_embedding),
      survey_embedding = VALUES(survey_embedding),
      survey_weight = VALUES(survey_weight),
      last_survey_update = VALUES(last_survey_update)
    `,
            [
                userId,
                JSON.stringify(combinedEmbedding),
                JSON.stringify(surveyAverage),
                surveyWeight,
            ],
        );
    } catch (error) {
        console.error('Error updating combined preference profile:', error);
    }
}

async function applySurveyScoring(tips, surveyData) {
    // Apply additional scoring based on survey preferences
    if (surveyData.length === 0) return tips;

    const survey = surveyData[0];
    const contentPrefs = safeJSONParse(survey.content_preferences);
    const challenges = safeJSONParse(survey.challenge_areas);
    const goals = safeJSONParse(survey.parenting_goals);

    // Precompute a merged { keyword -> weight } map once
    const keywordWeights = new Map();

    // helper to add keywords with a weight
    const addWeighted = (arr, getKeywordsFn, weight) => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            const kws = getKeywordsFn(item) || [];
            for (let i = 0; i < kws.length; i++) {
                const kw = String(kws[i] || '').toLowerCase();
                if (!kw) continue;
                // de-dupe: if multiple prefs map to same kw, sum weights once
                keywordWeights.set(kw, (keywordWeights.get(kw) || 0) + weight);
            }
        }
    };

    // Build the map from your three sources
    addWeighted(contentPrefs, getKeywordsForPreference, 0.05);
    addWeighted(challenges, getKeywordsForChallenge, 0.08);
    addWeighted(goals, getKeywordsForGoal, 0.06);

    return tips
        .map(tip => {
            let boost = 0;
            // Build the searchable blob ONCE
            const tipText = (
                (tip.title || '') +
                ' ' +
                (tip.body || '') +
                ' ' +
                (tip.details || '')
            ).toLowerCase();

            // Fast path: iterate keywords once, add weight when found
            for (const [kw, weight] of keywordWeights) {
                if (tipText.indexOf(kw) !== -1) boost += weight;
            }

            const base =
                tip.similarity_score == null ? 0.5 : tip.similarity_score;
            const newScore = base + boost > 1 ? 1 : base + boost;

            return {
                ...tip,
                similarity_score: Math.round(newScore * 1000) / 1000,
                survey_boost: Math.round(boost * 1000) / 1000,
                hasSurveyBoost: boost > 0,
            };
        })
        .sort((a, b) => b.similarity_score - a.similarity_score);
}

// Upsert generated tips so they can be referenced by interactions/embeddings
async function ensureTipExists(tipId, aiTip = {}) {
    // If already a numeric DB id, return it as-is
    if (/^\d+$/.test(String(tipId))) return Number(tipId);

    const title = aiTip?.title || 'AI Tip';
    const description = aiTip?.body || aiTip?.details || '';
    const type =
        Array.isArray(aiTip?.categories) && aiTip.categories[0]
            ? aiTip.categories[0]
            : 'generated';

    // Try to find an existing row with same content to avoid dupes
    const [existing] = await pool.query(
        `SELECT id FROM tips WHERE type = ? AND title = ? AND description = ? LIMIT 1`,
        [type, title, description],
    );
    if (existing.length) return existing[0].id;

    // Insert new tip
    const [insert] = await pool.query(
        `INSERT INTO tips (title, description, type) VALUES (?, ?, ?)`,
        [title, description, type],
    );
    const newId = insert.insertId;

    // Create embedding so it participates in personalization
    try {
        const embedding = await personalizationService.generateTipEmbedding({
            title,
            body: description,
            details: '',
        });
        await personalizationService.storeTipEmbedding(newId, embedding);
    } catch (e) {
        console.warn('Failed to embed generated tip:', e.message);
    }

    return newId;
}

function getKeywordsForPreference(pref) {
    const keywords = {
        activities: ['activity', 'play', 'game', 'fun', 'creative'],
        discipline: ['discipline', 'behavior', 'rules', 'consequences'],
        emotional: ['emotion', 'feeling', 'comfort', 'support'],
        routines: ['routine', 'schedule', 'consistency'],
        sleep: ['sleep', 'bedtime', 'nap'],
        nutrition: ['food', 'eating', 'meal', 'healthy'],
        potty: ['potty', 'toilet', 'bathroom'],
        'screen-time': ['screen', 'technology', 'device'],
        travel: ['travel', 'car', 'trip'],
        'big-feelings': ['anxiety', 'anger', 'frustrated'],
    };
    return keywords[pref] || [];
}

function getKeywordsForChallenge(challenge) {
    const keywords = {
        tantrums: ['tantrum', 'meltdown', 'crying', 'upset'],
        bedtime: ['bedtime', 'sleep', 'night'],
        'picky-eating': ['picky', 'eating', 'food'],
        'sibling-rivalry': ['sibling', 'fighting', 'sharing'],
        'screen-battles': ['screen', 'device', 'technology'],
        'public-behavior': ['public', 'store', 'restaurant'],
        homework: ['homework', 'school', 'study'],
        transitions: ['transition', 'change', 'leaving'],
    };
    return keywords[challenge] || [];
}

function getKeywordsForGoal(goal) {
    const keywords = {
        patience: ['patience', 'calm', 'gentle'],
        connection: ['connection', 'bond', 'relationship'],
        independence: ['independence', 'self-reliant', 'confident'],
        confidence: ['confidence', 'self-esteem', 'proud'],
        consistency: ['consistency', 'routine', 'structure'],
        communication: ['communication', 'talking', 'listening'],
        balance: ['balance', 'time', 'manage'],
        stress: ['stress', 'calm', 'relax'],
    };
    return keywords[goal] || [];
}

export default router;