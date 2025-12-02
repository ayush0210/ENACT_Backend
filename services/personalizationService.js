import { OpenAI } from 'openai';
import pool from '../config/db.js';
import {
    TIPS_SYSTEM_PROMPT,
    sanitizeTipText,
} from '../utils/parentingGuardrails.js';
import crypto from 'crypto';
import { getCached, setCached, purge } from '../utils/emb-cache.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// OPTIMIZATION: Simple in-memory cache for user preference analysis (5 min TTL)
const userPreferenceCache = new Map();
const PREFERENCE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPreference(userId) {
    const cached = userPreferenceCache.get(userId);
    if (cached && Date.now() - cached.timestamp < PREFERENCE_CACHE_TTL) {
        return cached.value;
    }
    return null;
}

function setCachedPreference(userId, value) {
    userPreferenceCache.set(userId, {
        value,
        timestamp: Date.now()
    });
    // Auto cleanup old entries
    if (userPreferenceCache.size > 1000) {
        const oldestKey = userPreferenceCache.keys().next().value;
        userPreferenceCache.delete(oldestKey);
    }
}

/**
 * Hard limits & weights to keep tips strictly on-topic.
 */
const ON_TOPIC = {
    // Minimum query-to-tip cosine similarity to accept a tip.
    MIN_QUERY_SIM: Number(process.env.MIN_QUERY_SIM || 0.4),
    // Minimum query-to-tip cosine similarity for "great" tips (for tie-breaks).
    STRONG_QUERY_SIM: Number(process.env.STRONG_QUERY_SIM || 0.55),
    // Blend weights: prioritize query relevance over personalization.
    LAMBDA_QUERY: Number(process.env.LAMBDA_QUERY || 0.65),
    LAMBDA_PERSONAL: Number(process.env.LAMBDA_PERSONAL || 0.35),
    // Penalty weight for similarity to the "disliked" centroid.
    LAMBDA_DISLIKE: Number(process.env.LAMBDA_DISLIKE || 0.25),
};

/**
 * Extract lightweight keywords from a user query to pin the model to topic.
 * Super simple: nouns-ish tokens and key phrases; you can swap for a real NLP if you want.
 */
function extractQueryKeywords(q) {
    const text = String(q || '').toLowerCase();
    const words = text
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(
            w =>
                w.length > 2 &&
                ![
                    'the',
                    'and',
                    'for',
                    'with',
                    'that',
                    'this',
                    'your',
                    'about',
                    'from',
                    'into',
                    'over',
                    'under',
                    'when',
                    'what',
                    'into',
                    'kids',
                    'child',
                    'children',
                    'parenting',
                ].includes(w),
        );

    // keep top 6 unique tokens
    const uniq = [...new Set(words)].slice(0, 6);

    // also keep simple common bigrams present
    const bigrams = [];
    for (let i = 0; i < words.length - 1; i++) {
        const bg = `${words[i]} ${words[i + 1]}`;
        if (bg.length > 5) bigrams.push(bg);
    }
    const uniqBigrams = [...new Set(bigrams)].slice(0, 4);

    return [...uniq, ...uniqBigrams];
}

class PersonalizationService {
    // ---------- Embeddings ----------
    async generateTipEmbedding(tip) {
        try {
            // Cover both DB tips (title/description) and AI tips (title/body/details)
            const text = [tip.title, tip.description, tip.body, tip.details]
                .filter(Boolean)
                .join(' ');

            const response = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: text,
                encoding_format: 'float',
            });

            return response.data[0].embedding;
        } catch (error) {
            console.error('Error generating embedding:', error);
            throw error;
        }
    }

    async storeTipEmbedding(tipId, embedding) {
        try {
            const [existing] = await pool.query(
                'SELECT id FROM tip_embeddings WHERE tip_id = ?',
                [tipId],
            );

            if (existing.length > 0) {
                await pool.query(
                    'UPDATE tip_embeddings SET embedding = ?, updated_at = NOW() WHERE tip_id = ?',
                    [JSON.stringify(embedding), tipId],
                );
            } else {
                await pool.query(
                    'INSERT INTO tip_embeddings (tip_id, embedding) VALUES (?, ?)',
                    [tipId, JSON.stringify(embedding)],
                );
            }
        } catch (error) {
            console.error('Error storing embedding:', error);
            throw error;
        }
    }

    async generateQueryEmbedding(query) {
        console.time(
            '<--------------Generating Query Embedding-------------->',
        );
        try {
            purge();

            // BUGFIX: Validate and sanitize query input
            const sanitizedQuery = String(query || '').trim();
            if (!sanitizedQuery || sanitizedQuery.length === 0) {
                throw new Error('Query cannot be empty for embedding generation');
            }

            // BUGFIX: Truncate very long queries to prevent API errors
            const truncatedQuery = sanitizedQuery.slice(0, 8000);

            const key = `qe:${truncatedQuery}`;
            const hit = getCached(key);
            if (hit && hit.exp > Date.now()) return hit.v;

            const response = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: truncatedQuery,
                encoding_format: 'float',
            });
            const emb = response.data[0].embedding;
            setCached(key, emb);
            return emb;
        } catch (error) {
            console.error('Error generating query embedding:', error);
            throw error;
        } finally {
            console.timeEnd(
                '<--------------Generating Query Embedding-------------->',
            );
        }
    }

    // ---------- CRUD for generated tips ----------
    async upsertGeneratedTip(clientTipId, tipPayload) {
        if (!tipPayload || !tipPayload.title || !tipPayload.body) {
            throw new Error(
                'tipPayload with {title, body} is required for generated tips',
            );
        }

        const title = String(tipPayload.title).trim().slice(0, 100);
        const body = String(tipPayload.body).trim();
        const details = String(tipPayload.details || '').trim();

        // categories can be ["activities","sibling-rivalry"] OR
        // [{ type:'challenge', value:'tantrums', confidence:0.9 }]
        let categories = Array.isArray(tipPayload.categories)
            ? tipPayload.categories
            : [];

        // Deduplicate by content
        const content_hash = crypto
            .createHash('sha256')
            .update(`${title}|${body}|${details}`)
            .digest('hex');

        // Reuse if present
        const [existing] = await pool.query(
            'SELECT id FROM tips WHERE content_hash = ? LIMIT 1',
            [content_hash],
        );
        if (existing.length) return existing[0].id;

        // Insert the tip
        const [ins] = await pool.query(
            `INSERT INTO tips (type, title, description, source, content_hash)
       VALUES (?, ?, ?, 'ai', ?)`,
            ['generated', title, body, content_hash],
        );
        const newTipId = ins.insertId;

        // insert normalized categories
        try {
            const rows = categories
                .slice(0, 12)
                .map(c => {
                    if (!c) return null;
                    if (typeof c === 'string') {
                        return [
                            newTipId,
                            'content',
                            c.trim().toLowerCase(),
                            1.0,
                        ];
                    }
                    const t = String(c.type || 'content')
                        .trim()
                        .toLowerCase();
                    const v = String(c.value ?? c.name ?? c.category ?? '')
                        .trim()
                        .toLowerCase();
                    if (!v) return null;
                    const conf =
                        typeof c.confidence === 'number'
                            ? Math.max(0, Math.min(1, c.confidence))
                            : 1.0;
                    return [newTipId, t, v, conf];
                })
                .filter(Boolean);

            if (rows.length) {
                await pool.query(
                    `INSERT IGNORE INTO tip_categories
             (tip_id, category_type, category_value, confidence)
           VALUES ?`,
                    [rows],
                );
            }
        } catch (catErr) {
            console.error('Category insert failed (non-fatal):', catErr);
        }

        // Create/store embedding
        try {
            const embedding = await this.generateTipEmbedding({
                title,
                body,
                details,
                description: body,
            });
            await this.storeTipEmbedding(newTipId, embedding);
        } catch (embErr) {
            console.warn('Failed to create embedding (non-critical):', embErr.message);
        }

        return newTipId;
    }

    // ---------- Retrieval: DB contextual + personalization with hard on-topic gating ----------
    async getContextualPersonalizedTips(
        userId,
        query,
        limit = 10,
        contentPreferences = [],
    ) {
        try {
            console.log(
                `🔍 Getting contextual personalized tips for user ${userId} with query: "${query}"`,
            );

            // OPTIMIZATION: Pre-parse embeddings to avoid repeated JSON.parse in loop
            const parseEmbedding = (emb) => Array.isArray(emb) ? emb : JSON.parse(emb);

            // Run independent work in parallel
            const [queryEmbedding, [userProfile], [dislikes], [interacted]] =
                await Promise.all([
                    this.generateQueryEmbedding(query),
                    pool.query(
                        'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
                        [userId],
                    ),
                    pool.query(
                        `SELECT te.embedding FROM user_tip_interactions uti
                        JOIN tip_embeddings te ON uti.tip_id = te.tip_id
                        WHERE uti.user_id = ? AND uti.interaction_type = 'dislike'`,
                        [userId],
                    ),
                    pool.query(
                        `SELECT DISTINCT tip_id FROM user_tip_interactions WHERE user_id = ? AND interaction_type IN ('like','dislike')`,
                        [userId],
                    ),
                ]);

            // Unpack personalization
            let userPreference = null;
            let hasPersonalization = false;
            if (userProfile.length > 0 && userProfile[0].preference_embedding) {
                userPreference = parseEmbedding(userProfile[0].preference_embedding);
                hasPersonalization = true;
            }

            // Build dislike centroid
            let dislikeCentroid = null;
            if (dislikes.length) {
                const vecs = dislikes.map(r => parseEmbedding(r.embedding));
                const L = vecs[0].length;
                dislikeCentroid = new Array(L).fill(0);
                for (const v of vecs)
                    for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
                for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
            }

            // Get tip embeddings from MySQL (excluding already interacted)
            const excludeIds = (interacted || []).map(r => r.tip_id).filter(Boolean);
            const excludePlaceholders = excludeIds.length
                ? `AND t.id NOT IN (${excludeIds.map(() => '?').join(',')})`
                : '';

            // OPTIMIZATION: Reduce limit and fetch only what we need
            const [tipEmbeddings] = await pool.query(
                `SELECT te.tip_id, te.embedding, t.title, t.description, t.type
                 FROM tip_embeddings te
                 JOIN tips t ON te.tip_id = t.id
                 WHERE 1=1 ${excludePlaceholders}
                 LIMIT ?`,
                [...excludeIds, Math.min(limit * 3, 30)]
            );

            if (tipEmbeddings.length === 0) {
                return {
                    tips: [],
                    isPersonalized: hasPersonalization,
                    queryRelevance: true,
                    originalQuery: query,
                };
            }

            // OPTIMIZATION: Pre-parse all embeddings and calculate similarities in batch
            console.time('<----------MySQL Vector Search------------------->');
            const recommendations = [];

            for (const row of tipEmbeddings) {
                try {
                    const tipEmb = parseEmbedding(row.embedding);

                    // Calculate query similarity (HARD FILTER)
                    const qSim = this.cosineSimilarity(queryEmbedding, tipEmb);
                    if (qSim < ON_TOPIC.MIN_QUERY_SIM) continue;

                    // Calculate personalization score
                    let personal = 0.5;
                    if (hasPersonalization && userPreference) {
                        personal = this.cosineSimilarity(userPreference, tipEmb);
                    }

                    // Calculate final score with dislike penalty
                    let finalScore =
                        ON_TOPIC.LAMBDA_QUERY * qSim +
                        ON_TOPIC.LAMBDA_PERSONAL * personal;

                    if (dislikeCentroid) {
                        const dislikeSim = this.cosineSimilarity(dislikeCentroid, tipEmb);
                        finalScore -= ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
                    }

                    // Clean query for display (remove context prompts)
                    const cleanQuery = query
                        .replace(/\n\nContext:.*$/s, '')  // Remove context instructions
                        .trim()
                        .slice(0, 100);  // Limit length

                    recommendations.push({
                        id: row.tip_id,
                        title: row.title,
                        body: row.description,
                        details: hasPersonalization
                            ? `Personalized ${row.type} tip for "${cleanQuery}"`
                            : `${row.type} tip for "${cleanQuery}"`,
                        categories: [row.type].filter(Boolean),
                        query_relevance: Math.round(qSim * 1000) / 1000,
                        personal_match: Math.round(personal * 1000) / 1000,
                        similarity_score: Math.round(finalScore * 1000) / 1000,
                        __is_strong_match: qSim >= ON_TOPIC.STRONG_QUERY_SIM,
                    });
                } catch (err) {
                    console.error(`Error processing tip ${row.tip_id}:`, err.message);
                }
            }
            console.timeEnd('<----------MySQL Vector Search------------------->');

            if (recommendations.length === 0) {
                return {
                    tips: [],
                    isPersonalized: hasPersonalization,
                    queryRelevance: true,
                    originalQuery: query,
                };
            }

            // Sort: strong on-topic first, then query relevance, then blended score
            recommendations.sort((a, b) => {
                if (a.__is_strong_match && !b.__is_strong_match) return -1;
                if (!a.__is_strong_match && b.__is_strong_match) return 1;
                if (b.query_relevance !== a.query_relevance)
                    return b.query_relevance - a.query_relevance;
                return b.similarity_score - a.similarity_score;
            });

            const finalTips = recommendations.slice(0, limit);
            return {
                tips: finalTips,
                isPersonalized: hasPersonalization,
                queryRelevance: true,
                originalQuery: query,
            };
        } catch (error) {
            console.error('Error getting contextual personalized tips:', error);
            throw error;
        }
    }

    // ---------- Generation: AI with strict JSON + on-topic constraints ----------
    async generatePersonalizedTipsForQuery(
        userId,
        query,
        limit = 5,
        contentPreferences = [],
        onToken,
    ) {
        try {
            console.log(
                `🎯 Generating personalized tips for user ${userId} with query: "${query}"`,
            );

            // Extract keywords to pin the model
            const queryKeywords = extractQueryKeywords(query);

            // Run independent work in parallel: query embedding, profile, dislikes
            const [queryEmbedding, [userProfile], [dislikes]] =
                await Promise.all([
                    this.generateQueryEmbedding(query),
                    pool.query(
                        'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
                        [userId],
                    ),
                    pool.query(
                        `SELECT te.embedding
                        FROM user_tip_interactions uti
                        JOIN tip_embeddings te ON uti.tip_id = te.tip_id
                        WHERE uti.user_id = ? AND uti.interaction_type = 'dislike'`,
                        [userId],
                    ),
                ]);

            // Unpack personalization
            let userPreference = null;
            let hasPersonalization = false;
            if (userProfile.length > 0 && userProfile[0].preference_embedding) {
                userPreference = Array.isArray(
                    userProfile[0].preference_embedding,
                )
                    ? userProfile[0].preference_embedding
                    : JSON.parse(userProfile[0].preference_embedding);
                hasPersonalization = true;
            }

            // Build dislike centroid (if any)
            let dislikeCentroid = null;
            if (dislikes.length) {
                const vecs = dislikes.map(r =>
                    Array.isArray(r.embedding)
                        ? r.embedding
                        : JSON.parse(r.embedding),
                );
                const L = vecs[0].length;
                dislikeCentroid = new Array(L).fill(0);
                for (const v of vecs) {
                    for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
                }
                for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
            }

            // OPTIMIZATION: Run preference analysis and RAG context in parallel
            const [preferenceContext, [contextTips]] = await Promise.all([
                hasPersonalization
                    ? this.analyzeUserPreferences(userId)
                    : Promise.resolve(''),
                // OPTIMIZATION: Reduce RAG context size from 20 to 10 for faster query
                pool.query(
                    `SELECT te.tip_id, te.embedding, t.title, t.description, t.type
                     FROM tip_embeddings te
                     JOIN tips t ON te.tip_id = t.id
                     LIMIT 10`
                )
            ]);

            // OPTIMIZATION: Pre-parse embeddings helper
            const parseEmb = (emb) => Array.isArray(emb) ? emb : JSON.parse(emb);

            // Calculate similarity and get top 4 (reduced from 6)
            console.time('<----------MySQL Search for RAG Context------------------->');
            const ragCtx = contextTips
                .map(row => {
                    const tipEmb = parseEmb(row.embedding);
                    const score = this.cosineSimilarity(queryEmbedding, tipEmb);
                    return {
                        score,
                        payload: {
                            type: row.type,
                            title: row.title,
                            description: row.description
                        }
                    };
                })
                .filter(r => r.score >= ON_TOPIC.MIN_QUERY_SIM)
                .sort((a, b) => b.score - a.score)
                .slice(0, 4);

            console.timeEnd('<----------MySQL Search for RAG Context------------------->');

            const contextSnippets = ragCtx
                .map((p, i) => {
                    const pl = p.payload || {};
                    return `#${i + 1} [${pl.type}] ${pl.title}: ${pl.description}`;
                })
                .join('\n');

            // OPTIMIZATION: Reduce AI generation count and simplify context
            const generatedTips = await this.generateTipsWithAI(
                query,
                [
                    preferenceContext,
                    contextSnippets ? `Context:\n${contextSnippets}` : '',
                ]
                    .filter(Boolean)
                    .join('\n\n'),
                Math.min(limit * 2, 6), // Cap at 6 tips max for faster generation
                contentPreferences,
                queryKeywords,
                onToken,
            );

            // Score generated tips against query + userPreference + dislike penalty
            const scoredTips = [];

            const tipTexts = generatedTips.map(t =>
                [t.title, t.body, t.details].filter(Boolean).join(' '),
            );

            console.time(
                '<---------------Generating response embedding--------------->',
            );
            const batchEmb = await openai.embeddings.create({
                model: 'text-embedding-3-small',
                input: tipTexts,
                encoding_format: 'float',
            });
            console.timeEnd(
                '<---------------Generating response embedding--------------->',
            );
            const tipVectors = batchEmb.data.map(d => d.embedding);

            for (let i = 0; i < generatedTips.length; i++) {
                try {
                    const tip = generatedTips[i];
                    const tipEmbedding = tipVectors[i];

                    // HARD FILTER by query similarity
                    const qSim = this.cosineSimilarity(
                        queryEmbedding,
                        tipEmbedding,
                    );
                    if (qSim < ON_TOPIC.MIN_QUERY_SIM) continue;

                    // keyword pin must pass
                    const blob =
                        `${tip.title} ${tip.body} ${tip.details}`.toLowerCase();
                    const hasPinned =
                        queryKeywords.length === 0
                            ? true
                            : queryKeywords.some(k => blob.includes(k));
                    if (!hasPinned) continue;

                    let personalizedScore = 0.5;
                    if (hasPersonalization && userPreference) {
                        personalizedScore = this.cosineSimilarity(
                            userPreference,
                            tipEmbedding,
                        );
                    }

                    let finalScore =
                        ON_TOPIC.LAMBDA_QUERY * qSim +
                        ON_TOPIC.LAMBDA_PERSONAL * personalizedScore;
                    if (dislikeCentroid) {
                        const dislikeSim = this.cosineSimilarity(
                            dislikeCentroid,
                            tipEmbedding,
                        );
                        finalScore -=
                            ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
                    }

                    scoredTips.push({
                        ...tip,
                        personal_match:
                            Math.round(personalizedScore * 1000) / 1000,
                        similarity_score: Math.round(finalScore * 1000) / 1000,
                        query_relevance: Math.round(qSim * 1000) / 1000,
                        isGenerated: true,
                        __is_strong_match: qSim >= ON_TOPIC.STRONG_QUERY_SIM,
                    });
                } catch (err) {
                    console.error(
                        `Error processing generated tip:`,
                        err.message,
                    );
                }
            }

            if (scoredTips.length === 0) {
                console.log('After on-topic gating, no generated tips remain.');
                return {
                    tips: [],
                    isPersonalized: hasPersonalization,
                    isGenerated: true,
                    originalQuery: query,
                    preferenceContext,
                };
            }

            // Sort: strong on-topic first, then query_relevance, then blended score
            scoredTips.sort((a, b) => {
                if (a.__is_strong_match && !b.__is_strong_match) return -1;
                if (!a.__is_strong_match && b.__is_strong_match) return 1;
                if (b.query_relevance !== a.query_relevance)
                    return b.query_relevance - a.query_relevance;
                return b.similarity_score - a.similarity_score;
            });

            const finalTips = scoredTips.slice(0, limit);

            console.log(
                `✅ Generated ${finalTips.length} on-topic personalized tips for "${query}"`,
            );
            if (finalTips.length > 0) {
                console.log(
                    `   Best query relevance: ${finalTips[0].query_relevance}`,
                );
                console.log(
                    `   Best personal match: ${finalTips[0].personal_match}`,
                );
            }

            return {
                tips: finalTips,
                isPersonalized: hasPersonalization,
                isGenerated: true,
                originalQuery: query,
                preferenceContext,
            };
        } catch (error) {
            console.error('Error generating personalized tips:', error);
            throw error;
        }
    }

    // ---------- Preference analysis ----------
    async analyzeUserPreferences(userId) {
        try {
            // OPTIMIZATION: Check cache first
            const cached = getCachedPreference(userId);
            if (cached !== null) {
                console.log(`📊 User preference context (cached): ${cached}`);
                return cached;
            }

            console.time(
                '<--------------------Analyzing user preferences-------------------->',
            );
            const [likedTips] = await pool.query(
                `
        SELECT t.title, t.description, t.type
        FROM user_tip_interactions uti
        JOIN tips t ON uti.tip_id = t.id
        WHERE uti.user_id = ? AND uti.interaction_type = 'like'
        ORDER BY uti.created_at DESC
        LIMIT 10
      `,
                [userId],
            );

            if (likedTips.length === 0) {
                setCachedPreference(userId, '');
                return '';
            }

            const preferences = [];
            const categories = {};

            likedTips.forEach(tip => {
                categories[tip.type] = (categories[tip.type] || 0) + 1;

                const text = `${tip.title} ${tip.description}`.toLowerCase();
                if (
                    text.includes('outdoor') ||
                    text.includes('active') ||
                    text.includes('play')
                ) {
                    preferences.push('active/outdoor activities');
                }
                if (
                    text.includes('calm') ||
                    text.includes('quiet') ||
                    text.includes('gentle')
                ) {
                    preferences.push('calm/gentle approaches');
                }
                if (
                    text.includes('creative') ||
                    text.includes('art') ||
                    text.includes('imagination')
                ) {
                    preferences.push('creative activities');
                }
                if (
                    text.includes('routine') ||
                    text.includes('structure') ||
                    text.includes('schedule')
                ) {
                    preferences.push('structured routines');
                }
                if (
                    text.includes('independent') ||
                    text.includes('choice') ||
                    text.includes('decide')
                ) {
                    preferences.push('child independence');
                }
            });

            const topCategories = Object.entries(categories)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 3)
                .map(([cat]) => cat);

            const uniquePreferences = [...new Set(preferences)].slice(0, 4);

            let context = `Based on your liked tips, you prefer: `;
            if (topCategories.length > 0)
                context += `${topCategories.join(', ')} activities. `;
            if (uniquePreferences.length > 0)
                context += `You like approaches that involve ${uniquePreferences.join(', ')}.`;

            console.log(`📊 User preference context: ${context}`);

            // OPTIMIZATION: Cache the result
            setCachedPreference(userId, context);

            return context;
        } catch (error) {
            console.error('Error analyzing user preferences:', error);
            return '';
        } finally {
            console.timeEnd(
                '<--------------------Analyzing user preferences-------------------->',
            );
        }
    }

    // ---------- AI tip generation with strict JSON + keyword pin ----------
    async generateTipsWithAI(
        query,
        preferenceContext = '',
        count = 10,
        contentPreferences = [],
        queryKeywords = [],
    ) {
        const maxRetries = 3;
        let lastError = null;

        // Short keyword pin string
        const keywordPin = queryKeywords.length
            ? `\nStay STRICTLY on topic. Prefer including: ${queryKeywords.map(k => `"${k}"`).join(', ')}.`
            : '';

        // Assemble a minimal prompt (short => faster)
        const domainLine =
            'Language Development; Early Science Skills; Literacy Foundations; Social-Emotional Learning';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(
                    `🤖 AI generation attempt ${attempt}/${maxRetries} for query: "${query}"`,
                );

                // OPTIMIZATION: Drastically simplified prompt for faster generation
                let userMsg = `Generate ${count} tips about "${query}".${keywordPin}
Domains: ${domainLine}
NO: discipline, sleep, eating, potty, screen time, medical, legal.
Return JSON array:
[{"id":1,"title":"<50 chars","body":"2 sentences","details":"1 sentence","categories":["domain"]}]`;

                if (
                    Array.isArray(contentPreferences) &&
                    contentPreferences.length
                ) {
                    const allowed = contentPreferences.filter(p =>
                        [
                            'Language Development',
                            'Early Science Skills',
                            'Literacy Foundations',
                            'Social-Emotional Learning',
                        ].includes(p),
                    );
                    if (allowed.length) {
                        userMsg += `\n\nUser-selected domains: ${allowed.join(', ')}. Prioritize these.`;
                    }
                }

                if (preferenceContext) {
                    // This may include RAG context if you feed it upstream
                    userMsg += `\n\nUser Context:\n${preferenceContext}`;
                }
                const timerLabel = `OpenAI-${Date.now()}-${attempt}`;
                console.time(timerLabel);
                // OPTIMIZATION: Reduce timeout from 25s to 8s for faster failures
                // OPTIMIZATION: Simplified system prompt and reduced temperature for faster, more deterministic responses
                const response = await Promise.race([
                    openai.chat.completions.create({
                        model: process.env.OPENAI_TIPS_MODEL || 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: 'Output valid JSON array only. Parenting tips within 4 domains. Never provide harmful, violent, or illegal advice.',
                            },
                            { role: 'user', content: userMsg },
                        ],
                        temperature: 0.2, // Lower temperature = faster generation
                        // OPTIMIZATION: Reduce from 1200 to 600 for faster responses
                        max_tokens: 600,
                    }),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('OpenAI timeout')),
                            8000,
                        ),
                    ),
                ]);
                console.timeEnd(timerLabel);

                const raw = (
                    response.choices?.[0]?.message?.content || ''
                ).trim();
                console.log('🤖 Raw OpenAI response length:', raw.length);
                if (!raw) throw new Error('Empty response from OpenAI');

                // Robust JSON parse
                let parsed;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    const jsonMatch = raw.match(/\[[\s\S]*\]/);
                    if (!jsonMatch)
                        throw new Error('No JSON array found in response');
                    parsed = JSON.parse(jsonMatch[0]);
                }

                const tipsArray = Array.isArray(parsed)
                    ? parsed
                    : parsed.tips || [];
                if (!Array.isArray(tipsArray) || tipsArray.length === 0) {
                    throw new Error(
                        'Parsed response does not contain a valid tips array',
                    );
                }

                // Light post-trim to keep fields tight
                const now = Date.now();
                const formattedTips = tipsArray.map((tip, index) => {
                    const title = (tip.title || `Tip ${index + 1}`)
                        .toString()
                        .trim()
                        .slice(0, 50);

                    // ensure "2 short sentences" roughly: split + take up to 2
                    const bodyRaw = (tip.body || tip.description || '')
                        .toString()
                        .trim();
                    const bodySentences = bodyRaw
                        .replace(/\s+/g, ' ')
                        .split(/(?<=[.!?])\s+/)
                        .slice(0, 2)
                        .join(' ');
                    const body = bodySentences;

                    const detailsRaw = (
                        tip.details || `AI-generated tip about ${query}`
                    )
                        .toString()
                        .trim();
                    const details = detailsRaw
                        .replace(/\s+/g, ' ')
                        .split(/(?<=[.!?])\s+/)
                        .slice(0, 1)
                        .join(' ');

                    const cats =
                        Array.isArray(tip.categories) && tip.categories.length
                            ? tip.categories.slice(0, 1) // keep one domain
                            : ['generated'];

                    return {
                        id: `generated_${now}_${index}`,
                        title,
                        body,
                        details,
                        audioUrl: null,
                        categories: cats,
                    };
                });

                const cleanTips = formattedTips.map(t => ({
                    ...t,
                    title: sanitizeTipText(t.title),
                    body: sanitizeTipText(t.body),
                    details: sanitizeTipText(t.details),
                }));

                console.log(
                    `✅ Successfully generated ${cleanTips.length} tight AI tips for "${query}"`,
                );
                return cleanTips;
            } catch (error) {
                console.error(
                    `❌ AI generation attempt ${attempt} failed:`,
                    error.message,
                );
                lastError = error;

                if (
                    error.message.includes('rate limit') ||
                    error.message.includes('quota')
                ) {
                    console.log('🚫 Rate limit hit, not retrying');
                    break;
                }
            }
        }

        console.error(`💥 All AI generation attempts failed for "${query}"`);
        console.error('Last error:', lastError?.message);

        // BUGFIX: Return fallback tips instead of empty array
        console.log('🔄 Returning fallback tips due to AI generation failure');
        return this.generateFallbackTips(query, count);
    }

    generateFallbackTips(query, count = 5) {
        const now = Date.now();

        // Clean query for display (remove context prompts)
        const cleanQuery = query
            .replace(/\n\nContext:.*$/s, '')  // Remove context instructions
            .trim()
            .slice(0, 100);  // Limit length

        const fallbackTips = [
            {
                id: `fallback_${now}_1`,
                title: `Getting Started with ${cleanQuery}`,
                body: `Here are gentle, practical approaches to help with ${cleanQuery}. Start small, observe your child, and iterate.`,
                details: `Every child is different—adjust strategies to your family's routine while focusing on ${cleanQuery}.`,
                audioUrl: null,
                categories: ['general'],
            },
            {
                id: `fallback_${now}_2`,
                title: `Making ${cleanQuery} Easier`,
                body: `Break ${cleanQuery} into small steps. Use clear cues and consistent routines to reduce friction.`,
                details: `Celebrate small wins to build momentum with ${cleanQuery}.`,
                audioUrl: null,
                categories: ['general'],
            },
        ];

        return fallbackTips.slice(0, count);
    }

    // ---------- Interactions & profiles ----------
    async trackUserInteraction(userId, tipId, interactionType) {
        try {
            console.log('🔍 trackUserInteraction called with:', {
                userId,
                tipId,
                interactionType,
            });

            // Verify tip & user
            const [tipExists] = await pool.query(
                'SELECT id FROM tips WHERE id = ?',
                [tipId],
            );
            if (tipExists.length === 0)
                throw new Error(`Tip with ID ${tipId} does not exist`);

            const [userExists] = await pool.query(
                'SELECT id FROM users WHERE id = ?',
                [userId],
            );
            if (userExists.length === 0)
                throw new Error(`User with ID ${userId} does not exist`);

            // Apply interaction logic (like ↔ dislike mutual exclusion)
            if (interactionType === 'like') {
                await pool.query(
                    'DELETE FROM user_tip_interactions WHERE user_id = ? AND tip_id = ? AND interaction_type = "dislike"',
                    [userId, tipId],
                );
                await pool.query(
                    'INSERT IGNORE INTO user_tip_interactions (user_id, tip_id, interaction_type) VALUES (?, ?, "like")',
                    [userId, tipId],
                );
            } else if (interactionType === 'dislike') {
                await pool.query(
                    'DELETE FROM user_tip_interactions WHERE user_id = ? AND tip_id = ? AND interaction_type = "like"',
                    [userId, tipId],
                );
                await pool.query(
                    'INSERT IGNORE INTO user_tip_interactions (user_id, tip_id, interaction_type) VALUES (?, ?, "dislike")',
                    [userId, tipId],
                );
            } else if (interactionType === 'save') {
                await pool.query(
                    'INSERT IGNORE INTO user_tip_interactions (user_id, tip_id, interaction_type) VALUES (?, ?, "save")',
                    [userId, tipId],
                );
            } else if (interactionType === 'unsave') {
                await pool.query(
                    'DELETE FROM user_tip_interactions WHERE user_id = ? AND tip_id = ? AND interaction_type = "save"',
                    [userId, tipId],
                );
            }

            // Refresh preference profile
            try {
                await this.updateUserPreferenceProfile(userId);
                // OPTIMIZATION: Invalidate preference cache when user interacts
                userPreferenceCache.delete(userId);
                console.log('🎉 trackUserInteraction completed successfully');
            } catch (profileErr) {
                console.warn('⚠️  Preference profile update warning:', profileErr.message);
                // Non-critical - interactions are still tracked in MySQL
            }
        } catch (error) {
            console.error('❌ Error in trackUserInteraction:', error);
            throw error;
        }
    }

    cosineSimilarity(vecA, vecB) {
        // OPTIMIZATION: Fast path check for same vectors
        if (vecA === vecB) return 1;

        const len = vecA.length;
        if (len !== vecB.length) {
            throw new Error('Vectors must have the same length');
        }

        let dot = 0,
            na = 0,
            nb = 0;

        // OPTIMIZATION: Unrolled loop for better performance
        const remainder = len % 4;
        const limit = len - remainder;

        for (let i = 0; i < limit; i += 4) {
            const a0 = vecA[i], b0 = vecB[i];
            const a1 = vecA[i+1], b1 = vecB[i+1];
            const a2 = vecA[i+2], b2 = vecB[i+2];
            const a3 = vecA[i+3], b3 = vecB[i+3];

            dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
            na += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
            nb += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
        }

        // Handle remainder
        for (let i = limit; i < len; i++) {
            const a = vecA[i];
            const b = vecB[i];
            dot += a * b;
            na += a * a;
            nb += b * b;
        }

        const denom = Math.sqrt(na) * Math.sqrt(nb);
        return denom ? dot / denom : 0;
    }

    async updateUserPreferenceProfile(userId) {
        try {
            const [likes] = await pool.query(
                `
        SELECT te.embedding
        FROM user_tip_interactions uti
        JOIN tip_embeddings te ON uti.tip_id = te.tip_id
        WHERE uti.user_id = ? AND uti.interaction_type = 'like'
      `,
                [userId],
            );

            const [dislikes] = await pool.query(
                `
        SELECT te.embedding
        FROM user_tip_interactions uti
        JOIN tip_embeddings te ON uti.tip_id = te.tip_id
        WHERE uti.user_id = ? AND uti.interaction_type = 'dislike'
      `,
                [userId],
            );

            if (likes.length === 0 && dislikes.length === 0) {
                await pool.query(
                    `UPDATE user_preference_profiles 
           SET total_interactions = 0, last_updated = NOW() 
           WHERE user_id = ?`,
                    [userId],
                );
                return;
            }

            const toVecs = rows =>
                rows.map(r =>
                    Array.isArray(r.embedding)
                        ? r.embedding
                        : JSON.parse(r.embedding),
                );

            const likeVecs = toVecs(likes);
            const dislikeVecs = toVecs(dislikes);

            const avg = vecs => {
                if (!vecs.length) return null;
                const L = vecs[0].length;
                const out = new Array(L).fill(0);
                for (const v of vecs)
                    for (let i = 0; i < L; i++) out[i] += v[i];
                for (let i = 0; i < L; i++) out[i] /= vecs.length;
                return out;
            };

            const likeAvg = avg(likeVecs);
            const dislikeAvg = avg(dislikeVecs);

            // preference = likeAvg − α * dislikeAvg (normalized)
            const alpha = 0.6;
            let pref = likeAvg || dislikeAvg;
            if (likeAvg && dislikeAvg) {
                pref = likeAvg.map((x, i) => x - alpha * dislikeAvg[i]);
            }

            const norm = Math.sqrt(pref.reduce((s, x) => s + x * x, 0)) || 1;
            const prefNorm = pref.map(x => x / norm);

            const total = likeVecs.length + dislikeVecs.length;

            const [existing] = await pool.query(
                'SELECT id FROM user_preference_profiles WHERE user_id = ?',
                [userId],
            );

            if (existing.length) {
                await pool.query(
                    `UPDATE user_preference_profiles 
           SET preference_embedding = ?, total_interactions = ?, last_updated = NOW()
           WHERE user_id = ?`,
                    [JSON.stringify(prefNorm), total, userId],
                );
            } else {
                await pool.query(
                    `INSERT INTO user_preference_profiles (user_id, preference_embedding, total_interactions)
           VALUES (?, ?, ?)`,
                    [userId, JSON.stringify(prefNorm), total],
                );
            }
        } catch (err) {
            console.error('Error updating preference profile:', err);
            throw err;
        }
    }

    async getPersonalizedTips(userId, limit = 10) {
        try {
            const [profile] = await pool.query(
                'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
                [userId],
            );

            if (profile.length === 0) {
                console.log(
                    `No preference profile found for user ${userId}, falling back to popular tips`,
                );
                return await this.getPopularTips(limit);
            }

            let userPreference;
            userPreference = Array.isArray(profile[0].preference_embedding)
                ? profile[0].preference_embedding
                : JSON.parse(profile[0].preference_embedding);

            // Optional dislike centroid
            let dislikeCentroid = null;
            try {
                const [dislikes] = await pool.query(
                    `
          SELECT te.embedding
          FROM user_tip_interactions uti
          JOIN tip_embeddings te ON uti.tip_id = te.tip_id
          WHERE uti.user_id = ? AND uti.interaction_type = 'dislike'
        `,
                    [userId],
                );

                if (dislikes.length) {
                    const vecs = dislikes.map(r =>
                        Array.isArray(r.embedding)
                            ? r.embedding
                            : JSON.parse(r.embedding),
                    );
                    const L = vecs[0].length;
                    dislikeCentroid = new Array(L).fill(0);
                    for (const v of vecs)
                        for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
                    for (let i = 0; i < L; i++)
                        dislikeCentroid[i] /= vecs.length;
                }
            } catch {}

            const [tipEmbeddings] = await pool.query(
                `
        SELECT te.tip_id, te.embedding, t.title, t.description, t.type
        FROM tip_embeddings te
        JOIN tips t ON te.tip_id = t.id
        WHERE te.tip_id NOT IN (
          SELECT DISTINCT tip_id 
          FROM user_tip_interactions 
          WHERE user_id = ? AND interaction_type IN ('like', 'dislike')
        )
      `,
                [userId],
            );

            if (tipEmbeddings.length === 0) {
                console.log(
                    `No available tips for user ${userId}, returning empty array`,
                );
                return [];
            }

            const recommendations = [];
            for (const tipEmbedding of tipEmbeddings) {
                try {
                    let embedding;
                    if (typeof tipEmbedding.embedding === 'string') {
                        embedding = JSON.parse(tipEmbedding.embedding);
                    } else if (Array.isArray(tipEmbedding.embedding)) {
                        embedding = tipEmbedding.embedding;
                    } else {
                        continue;
                    }
                    if (!Array.isArray(embedding) || embedding.length === 0)
                        continue;

                    const similarity = this.cosineSimilarity(
                        userPreference,
                        embedding,
                    );

                    // Apply dislike penalty for ranking
                    let finalScore = similarity;
                    if (dislikeCentroid) {
                        const dislikeSim = this.cosineSimilarity(
                            dislikeCentroid,
                            embedding,
                        );
                        finalScore -=
                            ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
                    }

                    recommendations.push({
                        id: tipEmbedding.tip_id,
                        title: tipEmbedding.title,
                        body: tipEmbedding.description,
                        details: `Personalized ${tipEmbedding.type} tip based on your preferences`,
                        audioUrl: null,
                        similarity_score: Math.round(finalScore * 1000) / 1000,
                        categories: [tipEmbedding.type],
                    });
                } catch (error) {
                    console.error(
                        `Error processing tip ${tipEmbedding.tip_id}:`,
                        error.message,
                    );
                }
            }

            if (recommendations.length === 0) {
                console.log(
                    `No valid recommendations generated for user ${userId}, falling back to popular tips`,
                );
                return await this.getPopularTips(limit);
            }

            recommendations.sort(
                (a, b) => b.similarity_score - a.similarity_score,
            );
            return recommendations.slice(0, limit);
        } catch (error) {
            console.error('Error getting personalized tips:', error);
            return await this.getPopularTips(limit);
        }
    }

    async getPopularTips(limit = 10) {
        try {
            const [tips] = await pool.query(
                `
        SELECT t.id, t.title, t.description as body, t.type,
               COALESCE(interaction_count, 0) as popularity
        FROM tips t
        LEFT JOIN (
          SELECT tip_id, COUNT(*) as interaction_count
          FROM user_tip_interactions 
          WHERE interaction_type = 'like'
          GROUP BY tip_id
        ) interactions ON t.id = interactions.tip_id
        ORDER BY popularity DESC, t.id
        LIMIT ?
      `,
                [limit],
            );

            return tips.map(tip => ({
                id: tip.id,
                title: tip.title,
                body: tip.body,
                details: `Popular ${tip.type} tip`,
                audioUrl: null,
                categories: [tip.type],
                similarity_score: 0.5,
            }));
        } catch (error) {
            console.error('Error getting popular tips:', error);
            return [];
        }
    }

    // ---------- Batch utilities ----------
    async processAllExistingTips() {
        try {
            const [tips] = await pool.query(
                `
        SELECT t.id, t.title, t.description 
        FROM tips t
        LEFT JOIN tip_embeddings te ON t.id = te.tip_id
        WHERE te.tip_id IS NULL
      `,
            );

            console.log(`Processing ${tips.length} tips for embeddings...`);

            for (const tip of tips) {
                try {
                    const embedding = await this.generateTipEmbedding(tip);
                    await this.storeTipEmbedding(tip.id, embedding);
                    console.log(`✅ Processed tip ${tip.id}: ${tip.title}`);
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    console.error(`❌ Failed to process tip ${tip.id}:`, error);
                }
            }

            console.log('🎉 Finished processing all tips');
            return tips.length;
        } catch (error) {
            console.error('Error processing tips batch:', error);
            throw error;
        }
    }

    // ---------- Survey helpers (exposed so routes can reuse) ----------
    async generateSurveyEmbeddings(userId, surveyData) {
        const {
            contentPreferences = [],
            challengeAreas = [],
            parentingGoals = [],
        } = surveyData;

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
                    const descriptiveText = this.getDescriptiveText(
                        type,
                        value,
                    );
                    const embedding =
                        await this.generateQueryEmbedding(descriptiveText);

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

    getDescriptiveText(type, value) {
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
                nutrition:
                    'healthy eating nutrition meals food parenting feeding',
                potty: 'potty training toilet training bathroom independence',
                'screen-time':
                    'screen time management technology devices digital parenting',
                travel: 'traveling with kids family trips vacation parenting',
                'big-feelings':
                    'managing big emotions anxiety anger sadness parenting support',
            },
            challenge: {
                tantrums:
                    'tantrum meltdown crying screaming upset child behavior',
                bedtime: 'bedtime struggles sleep problems nighttime routine',
                'picky-eating':
                    'picky eating food battles mealtime struggles nutrition',
                'sibling-rivalry':
                    'sibling fighting rivalry jealousy sharing problems',
                'screen-battles':
                    'screen time battles technology device conflicts',
                'public-behavior':
                    'public behavior store restaurant outings social situations',
                homework: 'homework resistance school work study struggles',
                transitions:
                    'transitions difficulty changing activities leaving',
            },
            goal: {
                patience:
                    'patience calm gentle understanding mindful parenting',
                connection:
                    'connection bonding relationship closeness family time',
                independence:
                    'independence self-reliance confidence capability building',
                confidence:
                    'confidence self-esteem pride capability child development',
                consistency:
                    'consistency routine structure reliable predictable parenting',
                communication:
                    'communication talking listening understanding dialogue',
                balance:
                    'work-life balance time management organization family',
                stress: 'stress reduction calm peaceful relaxed parenting',
            },
        };

        return (
            descriptions[type]?.[value] ||
            `${type} ${value} parenting help advice`
        );
    }

    async updateCombinedPreferenceProfile(userId) {
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

    async applySurveyScoring(userId, tips) {
        // Apply additional scoring based on survey preferences
        const [surveyData] = await pool.query(
            'SELECT content_preferences, challenge_areas, parenting_goals FROM user_survey_responses WHERE user_id = ?',
            [userId],
        );

        if (surveyData.length === 0) return tips;

        const survey = surveyData[0];
        const contentPrefs = this.safeJSONParse(survey.content_preferences);
        const challenges = this.safeJSONParse(survey.challenge_areas);
        const goals = this.safeJSONParse(survey.parenting_goals);

        const getKeywordsForPreference = pref => {
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
        };

        const getKeywordsForChallenge = challenge => {
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
        };

        const getKeywordsForGoal = goal => {
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
        };

        return tips
            .map(tip => {
                let boost = 0;
                const tipText =
                    `${tip.title} ${tip.body} ${tip.details}`.toLowerCase();

                contentPrefs.forEach(pref => {
                    const keywords = getKeywordsForPreference(pref);
                    const matches = keywords.filter(keyword =>
                        tipText.includes(keyword),
                    ).length;
                    boost += matches * 0.05;
                });

                challenges.forEach(challenge => {
                    const keywords = getKeywordsForChallenge(challenge);
                    const matches = keywords.filter(keyword =>
                        tipText.includes(keyword),
                    ).length;
                    boost += matches * 0.08;
                });

                goals.forEach(goal => {
                    const keywords = getKeywordsForGoal(goal);
                    const matches = keywords.filter(keyword =>
                        tipText.includes(keyword),
                    ).length;
                    boost += matches * 0.06;
                });

                const newScore = Math.min(
                    (tip.similarity_score || 0.5) + boost,
                    1.0,
                );

                return {
                    ...tip,
                    similarity_score: Math.round(newScore * 1000) / 1000,
                    survey_boost: Math.round(boost * 1000) / 1000,
                    hasSurveyBoost: boost > 0,
                };
            })
            .sort((a, b) => b.similarity_score - a.similarity_score);
    }

    // ---------- Utilities ----------
    safeJSONParse(jsonString, fallback = []) {
        try {
            if (!jsonString && jsonString !== 0) {
                return fallback;
            }
            if (Array.isArray(jsonString)) return jsonString;
            if (typeof jsonString === 'string') return JSON.parse(jsonString);
            return fallback;
        } catch {
            return fallback;
        }
    }

    cleanOneLineJSON(text) {
        // optional: ensure no trailing commas etc. We'll rely on well-formed lines.
        return text.trim();
    }

    sanitize(s) {
        return sanitizeTipText(String(s ?? '').trim());
    }

    async generateTipsStreamNDJSON({
        ws,
        abortedRef,
        userId,
        query,
        contentPreferences = [],
        onTip, // async (tip) => void
        onPhase, // (phaseStr) => void
    }) {
        const allowedDomains = [
            'Language Development',
            'Early Science Skills',
            'Literacy Foundations',
            'Social-Emotional Learning',
        ];
        const keywords = extractQueryKeywords(query);
        const pinLine = keywords.length
            ? `Prefer including: ${keywords.map(k => `"${k}"`).join(', ')}`
            : '';

        let userMsg = `Output parenting tips about: "${query}" as NDJSON (one JSON object per line). Each line must be:
      {"title":"≤50 chars","body":"2 short sentences","details":"1 short sentence","categories":["one_of:${allowedDomains.join('|')}"]}
      
      Rules:
      - STRICTLY within: ${allowedDomains.join(', ')}.
      - No medical, sleep, eating, potty, discipline, legal, logistics, or screen-time advice.
      - Age-appropriate, specific, concise.
      - No markdown, no arrays, no extra text — ONLY JSON objects, one per line.
      ${pinLine}`;

        if (Array.isArray(contentPreferences) && contentPreferences.length) {
            const allowed = contentPreferences.filter(d =>
                allowedDomains.includes(d),
            );
            if (allowed.length)
                userMsg += `\nPrioritize domains: ${allowed.join(', ')}.`;
        }

        onPhase?.('openai:starting');

        const stream = await openai.chat.completions.create({
            model: process.env.OPENAI_TIPS_MODEL || 'gpt-4o-mini',
            temperature: 0.3,
            top_p: 0.95,
            stream: true,
            max_tokens: 1200,
            messages: [
                {
                    role: 'system',
                    content:
                        'You output STRICT NDJSON: one complete JSON object per line. No arrays or prose. Never provide harmful, violent, or illegal advice.',
                },
                { role: 'user', content: userMsg },
            ],
        });

        onPhase?.('openai:streaming');

        let buf = '';
        let idx = -1;
        let counter = 0;

        for await (const part of stream) {
            if (abortedRef()) break;
            const delta = part?.choices?.[0]?.delta?.content ?? '';
            if (!delta) continue;

            buf += delta;

            // process complete lines
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = this.cleanOneLineJSON(buf.slice(0, idx));
                buf = buf.slice(idx + 1);
                if (!line) continue;

                let obj;
                try {
                    obj = JSON.parse(line);
                } catch {
                    continue;
                } // wait for clean lines

                const formatted = {
                    id: `generated_${Date.now()}_${counter++}`,
                    title: this.sanitize(obj.title || ''),
                    body: this.sanitize(
                        String(obj.body || '')
                            .split(/(?<=[.!?])\s+/)
                            .slice(0, 2)
                            .join(' '),
                    ),
                    details: this.sanitize(
                        String(obj.details || '')
                            .split(/(?<=[.!?])\s+/)
                            .slice(0, 1)
                            .join(' '),
                    ),
                    audioUrl: null,
                    categories:
                        Array.isArray(obj.categories) && obj.categories.length
                            ? obj.categories.slice(0, 1)
                            : ['generated'],
                    isGenerated: true,
                };

                await onTip?.(formatted);
            }
        }

        onPhase?.('openai:ended');
    }

    async scoreSingleGeneratedTip({ userId, query, tip }) {
        try {
            // fetch personalization signals
            const [[userProfile], [dislikes]] = await Promise.all([
                pool.query(
                    'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
                    [userId],
                ),
                pool.query(
                    `SELECT te.embedding
               FROM user_tip_interactions uti
               JOIN tip_embeddings te ON uti.tip_id = te.tip_id
               WHERE uti.user_id = ? AND uti.interaction_type = 'dislike'`,
                    [userId],
                ),
            ]);

            const queryEmbedding = await openai.embeddings
                .create({
                    model: 'text-embedding-3-small',
                    input: [query],
                    encoding_format: 'float',
                })
                .then(r => r.data[0].embedding);

            const tipEmbedding = await openai.embeddings
                .create({
                    model: 'text-embedding-3-small',
                    input: [`${tip.title} ${tip.body} ${tip.details}`],
                    encoding_format: 'float',
                })
                .then(r => r.data[0].embedding);

            let userPreference = null;
            let hasPersonalization = false;
            if (userProfile.length && userProfile[0].preference_embedding) {
                userPreference = Array.isArray(
                    userProfile[0].preference_embedding,
                )
                    ? userProfile[0].preference_embedding
                    : JSON.parse(userProfile[0].preference_embedding);
                hasPersonalization = true;
            }

            // dislike centroid
            let dislikeCentroid = null;
            if (dislikes.length) {
                const vecs = dislikes.map(r =>
                    Array.isArray(r.embedding)
                        ? r.embedding
                        : JSON.parse(r.embedding),
                );
                const L = vecs[0].length;
                dislikeCentroid = new Array(L).fill(0);
                for (const v of vecs)
                    for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
                for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
            }

            // gates & scores
            const cosine = (a, b) => {
                let num = 0,
                    da = 0,
                    db = 0;
                for (let i = 0; i < a.length; i++) {
                    num += a[i] * b[i];
                    da += a[i] * a[i];
                    db += b[i] * b[i];
                }
                return num / (Math.sqrt(da) * Math.sqrt(db));
            };

            const qSim = cosine(queryEmbedding, tipEmbedding);
            if (qSim < ON_TOPIC.MIN_QUERY_SIM) return null;

            const blob =
                `${tip.title} ${tip.body} ${tip.details}`.toLowerCase();
            const pins = extractQueryKeywords(query);
            if (pins.length && !pins.some(k => blob.includes(k))) return null;

            let personal = 0.5;
            if (hasPersonalization && userPreference)
                personal = cosine(userPreference, tipEmbedding);

            let final =
                ON_TOPIC.LAMBDA_QUERY * qSim +
                ON_TOPIC.LAMBDA_PERSONAL * personal;
            if (dislikeCentroid) {
                const dSim = cosine(dislikeCentroid, tipEmbedding);
                final -= ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dSim);
            }

            return {
                ...tip,
                personal_match: Math.round(personal * 1000) / 1000,
                similarity_score: Math.round(final * 1000) / 1000,
                query_relevance: Math.round(qSim * 1000) / 1000,
            };
        } catch (e) {
            console.error('scoreSingleGeneratedTip error:', e.message);
            return null;
        }
    }

    // ---------- Location-Based AI Tips ----------
    async generateLocationBasedTips({ userId, locationName, locationType, children, preferences = [] }) {
        try {
            console.log(`🗺️  Generating location-based tips for user ${userId} at ${locationName} (${locationType})`);

            // Build child context
            const childContext = children && children.length > 0
                ? children.map(c => `${c.nickname} (age ${c.age})`).join(', ')
                : 'their child';

            const childAges = children && children.length > 0
                ? children.map(c => c.age).join(', ')
                : '3';

            // Build preference context
            const preferenceContext = preferences.length > 0
                ? preferences.join(', ')
                : 'Language Development, Early Science Skills, Literacy Foundations, Social-Emotional Learning';

            // Build location-specific prompt
            const userMsg = `Generate 3 specific, actionable parenting tips for a parent visiting ${locationName} (a ${locationType}) with their ${children?.length === 1 ? 'child' : 'children'}: ${childContext}.

User prefers activities in: ${preferenceContext}

STRICT RULES:
- ONLY provide tips within these 4 domains: Language Development, Early Science Skills, Literacy Foundations, Social-Emotional Learning
- Each tip must be age-appropriate for ${childAges} year old(s)
- Each tip must be specific to visiting a ${locationType}
- Include concrete, actionable activities parents can do at this location
- Keep tips practical and easy to implement
- NO medical, sleep, eating, discipline, or screen time advice

Return JSON array:
[
  {"title": "Short title (max 50 chars)", "body": "2-3 sentence description", "details": "1 sentence practical detail"},
  {"title": "...", "body": "...", "details": "..."},
  {"title": "...", "body": "...", "details": "..."}
]`;

            console.log('🤖 Calling OpenAI for location-based tips...');

            const response = await Promise.race([
                openai.chat.completions.create({
                    model: process.env.OPENAI_TIPS_MODEL || 'gpt-4o-mini',
                    messages: [
                        {
                            role: 'system',
                            content: 'Generate location-specific parenting tips. Output valid JSON array only. Never provide harmful, violent, or illegal advice.',
                        },
                        { role: 'user', content: userMsg },
                    ],
                    temperature: 0.3,
                    max_tokens: 600,
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('OpenAI timeout')), 8000)
                ),
            ]);

            const raw = response.choices[0].message.content.trim();
            let tips = JSON.parse(raw);

            // Validate and format tips
            if (!Array.isArray(tips)) {
                tips = [tips];
            }

            tips = tips.slice(0, 3).map((tip, idx) => ({
                id: `location_${Date.now()}_${idx}`,
                title: String(tip.title || '').slice(0, 100),
                body: String(tip.body || tip.description || ''),
                details: String(tip.details || ''),
                type: locationType,
                location_name: locationName,
                source: 'ai_location',
                isGenerated: true,
            }));

            console.log(`✅ Generated ${tips.length} location-based tips`);

            return tips;
        } catch (error) {
            console.error('❌ Error generating location-based tips:', error.message);
            throw error;
        }
    }
}

export default new PersonalizationService();