import { OpenAI } from 'openai';
import pool from '../config/db.js';
import {
  TIPS_SYSTEM_PROMPT,
  sanitizeTipText,
} from '../utils/parentingGuardrails.js';
import crypto from 'crypto';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Hard limits & weights to keep tips strictly on-topic.
 */
const ON_TOPIC = {
  // Minimum query-to-tip cosine similarity to accept a tip.
  MIN_QUERY_SIM: Number(process.env.MIN_QUERY_SIM || 0.40),
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
    .filter(w => w.length > 2 && !['the','and','for','with','that','this','your','about','from','into','over','under','when','what','into','kids','child','children','parenting'].includes(w));

  // keep top 6 unique tokens
  const uniq = [...new Set(words)].slice(0, 6);

  // also keep simple common bigrams present
  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    const bg = `${words[i]} ${words[i+1]}`;
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
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
        encoding_format: 'float',
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating query embedding:', error);
      throw error;
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
            return [newTipId, 'content', c.trim().toLowerCase(), 1.0];
          }
          const t = String(c.type || 'content').trim().toLowerCase();
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
    const embedding = await this.generateTipEmbedding({
      title,
      body,
      details,
      description: body,
    });
    await this.storeTipEmbedding(newTipId, embedding);

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

      // 0) Extract query keywords for later hard pin check
      const queryKeywords = extractQueryKeywords(query);

      // 1) Embed the user query
      const queryEmbedding = await this.generateQueryEmbedding(query);

      // 2) Load user preference profile
      const [userProfile] = await pool.query(
        'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
        [userId],
      );

      let userPreference = null;
      let hasPersonalization = false;
      if (userProfile.length > 0 && userProfile[0].preference_embedding) {
        userPreference = Array.isArray(userProfile[0].preference_embedding)
          ? userProfile[0].preference_embedding
          : JSON.parse(userProfile[0].preference_embedding);
        hasPersonalization = true;
      }

      // 3) Optional dislike centroid (for penalty)
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
            Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding),
          );
          const L = vecs[0].length;
          dislikeCentroid = new Array(L).fill(0);
          for (const v of vecs) for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
          for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
        }
      } catch {}

      // 4) Load embeddings for candidate tips, optionally filter by the selected areas
      const allowed = Array.isArray(contentPreferences)
        ? contentPreferences.filter(Boolean)
        : [];

      let sql = `
        SELECT te.tip_id, te.embedding, t.title, t.description, t.type
        FROM tip_embeddings te
        JOIN tips t ON te.tip_id = t.id
        WHERE te.tip_id NOT IN (
          SELECT DISTINCT tip_id 
          FROM user_tip_interactions 
          WHERE user_id = ? AND interaction_type IN ('like', 'dislike')
        )
      `;
      const params = [userId];

      if (allowed.length > 0) {
        const placeholders = allowed.map(() => '?').join(',');
        sql += ` AND t.type IN (${placeholders})`;
        params.push(...allowed);
      }

      const [tipEmbeddings] = await pool.query(sql, params);

      if (tipEmbeddings.length === 0) {
        console.log(`No available tips for user ${userId}`);
        return {
          tips: [],
          isPersonalized: hasPersonalization,
          queryRelevance: true,
          originalQuery: query,
        };
      }

      // 5) Score with hard on-topic gate
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
          if (!Array.isArray(embedding) || embedding.length === 0) continue;

          const querySimilarity = this.cosineSimilarity(queryEmbedding, embedding);

          // HARD FILTER: reject if not on-topic enough
          if (querySimilarity < ON_TOPIC.MIN_QUERY_SIM) continue;

          // keyword pin: must include at least one query keyword in title or description
          const blob = `${tipEmbedding.title} ${tipEmbedding.description}`.toLowerCase();
          const hasPinned = queryKeywords.length === 0
            ? true
            : queryKeywords.some(k => blob.includes(k));
          if (!hasPinned) continue;

          let personalizedScore = 0.5;
          if (hasPersonalization && userPreference) {
            personalizedScore = this.cosineSimilarity(userPreference, embedding);
          }

          // Combined score with optional dislike penalty; strong emphasis on query
          let combinedScore = ON_TOPIC.LAMBDA_QUERY * querySimilarity + ON_TOPIC.LAMBDA_PERSONAL * personalizedScore;
          if (dislikeCentroid) {
            const dislikeSim = this.cosineSimilarity(dislikeCentroid, embedding);
            combinedScore -= ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
          }

          recommendations.push({
            id: tipEmbedding.tip_id,
            title: tipEmbedding.title,
            body: tipEmbedding.description,
            details: hasPersonalization
              ? `Personalized ${tipEmbedding.type} tip for "${query}"`
              : `${tipEmbedding.type} tip for "${query}"`,
            audioUrl: null,
            similarity_score: Math.round(combinedScore * 1000) / 1000,
            query_relevance: Math.round(querySimilarity * 1000) / 1000,
            personal_match: Math.round(personalizedScore * 1000) / 1000,
            categories: [tipEmbedding.type],
            __is_strong_match: querySimilarity >= ON_TOPIC.STRONG_QUERY_SIM,
          });
        } catch (error) {
          console.error(`Error processing tip ${tipEmbedding.tip_id}:`, error.message);
        }
      }

      if (recommendations.length === 0) {
        console.log(`No valid recommendations for query: "${query}"`);
        return {
          tips: [],
          isPersonalized: hasPersonalization,
          queryRelevance: true,
          originalQuery: query,
        };
      }

      // 6) Sort: prefer strong on-topic, then combined score
      recommendations.sort((a, b) => {
        if (a.__is_strong_match && !b.__is_strong_match) return -1;
        if (!a.__is_strong_match && b.__is_strong_match) return 1;
        // tie-break by query relevance then combined similarity_score
        if (b.query_relevance !== a.query_relevance) {
          return b.query_relevance - a.query_relevance;
        }
        return b.similarity_score - a.similarity_score;
      });

      const finalTips = recommendations.slice(0, limit);

      console.log(`✅ Found ${finalTips.length} contextual personalized tips for "${query}"`);
      console.log(`   Top tip query relevance: ${finalTips[0]?.query_relevance ?? 'N/A'}`);
      console.log(`   Top tip personal match: ${finalTips[0]?.personal_match ?? 'N/A'}`);

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
  ) {
    try {
      console.log(
        `🎯 Generating personalized tips for user ${userId} with query: "${query}"`,
      );

      // Extract keywords to pin the model
      const queryKeywords = extractQueryKeywords(query);

      // Preference profile
      const [userProfile] = await pool.query(
        'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
        [userId],
      );

      let userPreference = null;
      let hasPersonalization = false;
      if (userProfile.length > 0 && userProfile[0].preference_embedding) {
        userPreference = Array.isArray(userProfile[0].preference_embedding)
          ? userProfile[0].preference_embedding
          : JSON.parse(userProfile[0].preference_embedding);
        hasPersonalization = true;
      }

      // Optional dislike centroid for penalty
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
            Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding),
          );
          const L = vecs[0].length;
          dislikeCentroid = new Array(L).fill(0);
          for (const v of vecs) for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
          for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
        }
      } catch {}

      // Analyze likes for a short natural-language context
      let preferenceContext = '';
      if (hasPersonalization) {
        preferenceContext = await this.analyzeUserPreferences(userId);
      }

      // Generate candidates via AI (focused by contentPreferences)
      const generatedTips = await this.generateTipsWithAI(
        query,
        preferenceContext,
        limit * 3, // generate extra then filter hard
        contentPreferences,
        queryKeywords,
      );
      if (!generatedTips || generatedTips.length === 0) {
        console.log(`❌ No tips generated for query: "${query}"`);
        return { tips: [], isPersonalized: false, isGenerated: true, originalQuery: query, preferenceContext };
      }

      // Prepare embeddings once for query
      const queryEmbedding = await this.generateQueryEmbedding(query);

      // Score generated tips against query + userPreference + dislike penalty
      const scoredTips = [];
      for (const tip of generatedTips) {
        try {
          const tipEmbedding = await this.generateTipEmbedding(tip);

          // HARD FILTER by query similarity
          const qSim = this.cosineSimilarity(queryEmbedding, tipEmbedding);
          if (qSim < ON_TOPIC.MIN_QUERY_SIM) continue;

          // keyword pin must pass
          const blob = `${tip.title} ${tip.body} ${tip.details}`.toLowerCase();
          const hasPinned = queryKeywords.length === 0
            ? true
            : queryKeywords.some(k => blob.includes(k));
          if (!hasPinned) continue;

          let personalizedScore = 0.5;
          if (hasPersonalization && userPreference) {
            personalizedScore = this.cosineSimilarity(userPreference, tipEmbedding);
          }

          let finalScore = ON_TOPIC.LAMBDA_QUERY * qSim + ON_TOPIC.LAMBDA_PERSONAL * personalizedScore;
          if (dislikeCentroid) {
            const dislikeSim = this.cosineSimilarity(dislikeCentroid, tipEmbedding);
            finalScore -= ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
          }

          scoredTips.push({
            ...tip,
            personal_match: Math.round(personalizedScore * 1000) / 1000,
            similarity_score: Math.round(finalScore * 1000) / 1000,
            query_relevance: Math.round(qSim * 1000) / 1000,
            isGenerated: true,
            __is_strong_match: qSim >= ON_TOPIC.STRONG_QUERY_SIM,
          });
        } catch (err) {
          console.error(`Error processing generated tip:`, err.message);
        }
      }

      if (scoredTips.length === 0) {
        console.log('After on-topic gating, no generated tips remain.');
        return { tips: [], isPersonalized: hasPersonalization, isGenerated: true, originalQuery: query, preferenceContext };
      }

      // Sort: strong on-topic first, then query_relevance, then blended score
      scoredTips.sort((a, b) => {
        if (a.__is_strong_match && !b.__is_strong_match) return -1;
        if (!a.__is_strong_match && b.__is_strong_match) return 1;
        if (b.query_relevance !== a.query_relevance) return b.query_relevance - a.query_relevance;
        return b.similarity_score - a.similarity_score;
      });

      const finalTips = scoredTips.slice(0, limit);

      console.log(
        `✅ Generated ${finalTips.length} on-topic personalized tips for "${query}"`,
      );
      if (finalTips.length > 0) {
        console.log(`   Best query relevance: ${finalTips[0].query_relevance}`);
        console.log(`   Best personal match: ${finalTips[0].personal_match}`);
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

      if (likedTips.length === 0) return '';

      const preferences = [];
      const categories = {};

      likedTips.forEach(tip => {
        categories[tip.type] = (categories[tip.type] || 0) + 1;

        const text = `${tip.title} ${tip.description}`.toLowerCase();
        if (text.includes('outdoor') || text.includes('active') || text.includes('play')) {
          preferences.push('active/outdoor activities');
        }
        if (text.includes('calm') || text.includes('quiet') || text.includes('gentle')) {
          preferences.push('calm/gentle approaches');
        }
        if (text.includes('creative') || text.includes('art') || text.includes('imagination')) {
          preferences.push('creative activities');
        }
        if (text.includes('routine') || text.includes('structure') || text.includes('schedule')) {
          preferences.push('structured routines');
        }
        if (text.includes('independent') || text.includes('choice') || text.includes('decide')) {
          preferences.push('child independence');
        }
      });

      const topCategories = Object.entries(categories)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([cat]) => cat);

      const uniquePreferences = [...new Set(preferences)].slice(0, 4);

      let context = `Based on your liked tips, you prefer: `;
      if (topCategories.length > 0) context += `${topCategories.join(', ')} activities. `;
      if (uniquePreferences.length > 0) context += `You like approaches that involve ${uniquePreferences.join(', ')}.`;

      console.log(`📊 User preference context: ${context}`);
      return context;
    } catch (error) {
      console.error('Error analyzing user preferences:', error);
      return '';
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

    // Compose a short keyword pin string to bias the model strongly
    const keywordPin = queryKeywords.length
      ? `\nStay STRICTLY on topic. Include these key concepts in each tip where natural: ${queryKeywords.map(k => `"${k}"`).join(', ')}.`
      : '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `🤖 AI generation attempt ${attempt}/${maxRetries} for query: "${query}"`,
        );

        let prompt = `Generate ${count} practical, specific parenting tips **about exactly** "${query}".${keywordPin}
Avoid drifting into unrelated areas.`;

        if (Array.isArray(contentPreferences) && contentPreferences.length) {
          let description = '';
          if (contentPreferences.includes('Language Development')) {
            description += '\n - Activities and tips that encourage vocabulary growth and communication skills.';
          }
          if (contentPreferences.includes('Early Science Skills')) {
            description += '\n - Explorations and experiments that nurture curiosity and basic science thinking.';
          }
          if (contentPreferences.includes('Literacy Foundations')) {
            description += '\n - Reading and pre-writing activities that build pre-literacy skills.';
          }
          if (contentPreferences.includes('Social-Emotional Learning')) {
            description += '\n - Guidance for emotional regulation, relationship skills, and healthy self-awareness.';
          }

          prompt += `\n\nRestrict content to the following preferred themes where possible:${description}`;
        }

        if (preferenceContext) {
          prompt += `\n\nPreference Context: ${preferenceContext}`;
        }

        prompt += `
Each tip must:
- Be practical and actionable
- Be age-appropriate and safe
- Be clearly relevant to "${query}" (no off-topic content)
- Be unique (no duplicates)

Return ONLY a pure JSON array with objects like:
[
  {
    "id": 1,
    "title": "Short catchy title",
    "body": "Main tip content (2-3 sentences).",
    "details": "Extra helpful details or explanation.",
    "categories": ["relevant_category"]
  }
]`;

        // Add timeout and better error handling
        const response = await Promise.race([
          openai.chat.completions.create({
            model: process.env.OPENAI_TIPS_MODEL || 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: `${TIPS_SYSTEM_PROMPT}\n\nIMPORTANT: Output ONLY valid JSON (no markdown/code fences).`,
              },
              { role: 'user', content: prompt },
            ],
            temperature: 0.25, // lower for focus
            max_tokens: 1400,
          }),
          // 25 second timeout
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('OpenAI request timeout after 25 seconds')), 25000),
          ),
        ]);

        const raw = (response.choices?.[0]?.message?.content || '').trim();
        console.log('🤖 Raw OpenAI response length:', raw.length);
        if (!raw) throw new Error('Empty response from OpenAI');

        // Robust JSON parse
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          if (!jsonMatch) throw new Error('No JSON array found in response');
          parsed = JSON.parse(jsonMatch[0]);
        }

        const tipsArray = Array.isArray(parsed) ? parsed : parsed.tips || [];
        if (!Array.isArray(tipsArray) || tipsArray.length === 0) {
          throw new Error('Parsed response does not contain a valid tips array');
        }

        const now = Date.now();
        const formattedTips = tipsArray.map((tip, index) => ({
          id: `generated_${now}_${index}`,
          title: tip.title || `Tip ${index + 1}`,
          body: tip.body || tip.description || '',
          details: tip.details || `AI-generated tip about ${query}`,
          audioUrl: null,
          categories: tip.categories || ['generated'],
        }));

        const cleanTips = formattedTips.map(t => ({
          ...t,
          title: sanitizeTipText(t.title),
          body: sanitizeTipText(t.body),
          details: sanitizeTipText(t.details),
        }));

        console.log(`✅ Successfully generated ${cleanTips.length} AI tips for "${query}"`);
        return cleanTips;
      } catch (error) {
        console.error(`❌ AI generation attempt ${attempt} failed:`, error.message);
        lastError = error;

        // Don't retry on certain errors
        if (error.message.includes('rate limit') || error.message.includes('quota')) {
          console.log('🚫 Rate limit hit, not retrying');
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.log(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`💥 All AI generation attempts failed for "${query}"`);
    console.error('Last error:', lastError?.message);
    return this.generateFallbackTips(query, count);
  }

  generateFallbackTips(query, count = 5) {
    const now = Date.now();
    const fallbackTips = [
      {
        id: `fallback_${now}_1`,
        title: `Getting Started with ${query}`,
        body: `Here are gentle, practical approaches to help with ${query}. Start small, observe your child, and iterate.`,
        details: `Every child is different—adjust strategies to your family's routine while focusing on ${query}.`,
        audioUrl: null,
        categories: ['general'],
      },
      {
        id: `fallback_${now}_2`,
        title: `Making ${query} Easier`,
        body: `Break ${query} into small steps. Use clear cues and consistent routines to reduce friction.`,
        details: `Celebrate small wins to build momentum with ${query}.`,
        audioUrl: null,
        categories: ['general'],
      },
    ];

    return fallbackTips.slice(0, count);
  }

  // ---------- Interactions & profiles ----------
  async trackUserInteraction(userId, tipId, interactionType) {
    try {
      console.log('🔍 trackUserInteraction called with:', { userId, tipId, interactionType });

      // Verify tip & user
      const [tipExists] = await pool.query('SELECT id FROM tips WHERE id = ?', [tipId]);
      if (tipExists.length === 0) throw new Error(`Tip with ID ${tipId} does not exist`);

      const [userExists] = await pool.query('SELECT id FROM users WHERE id = ?', [userId]);
      if (userExists.length === 0) throw new Error(`User with ID ${userId} does not exist`);

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
      await this.updateUserPreferenceProfile(userId);
      console.log('🎉 trackUserInteraction completed successfully');
    } catch (error) {
      console.error('❌ Error in trackUserInteraction:', error);
      throw error;
    }
  }

  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have the same length');
    }
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < vecA.length; i++) {
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
        rows.map(r => (Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding)));

      const likeVecs = toVecs(likes);
      const dislikeVecs = toVecs(dislikes);

      const avg = vecs => {
        if (!vecs.length) return null;
        const L = vecs[0].length;
        const out = new Array(L).fill(0);
        for (const v of vecs) for (let i = 0; i < L; i++) out[i] += v[i];
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
            Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding),
          );
          const L = vecs[0].length;
          dislikeCentroid = new Array(L).fill(0);
          for (const v of vecs) for (let i = 0; i < L; i++) dislikeCentroid[i] += v[i];
          for (let i = 0; i < L; i++) dislikeCentroid[i] /= vecs.length;
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
          if (!Array.isArray(embedding) || embedding.length === 0) continue;

          const similarity = this.cosineSimilarity(userPreference, embedding);

          // Apply dislike penalty for ranking
          let finalScore = similarity;
          if (dislikeCentroid) {
            const dislikeSim = this.cosineSimilarity(dislikeCentroid, embedding);
            finalScore -= ON_TOPIC.LAMBDA_DISLIKE * Math.max(0, dislikeSim);
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
          console.error(`Error processing tip ${tipEmbedding.tip_id}:`, error.message);
        }
      }

      if (recommendations.length === 0) {
        console.log(
          `No valid recommendations generated for user ${userId}, falling back to popular tips`,
        );
        return await this.getPopularTips(limit);
      }

      recommendations.sort((a, b) => b.similarity_score - a.similarity_score);
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
    const { contentPreferences = [], challengeAreas = [], parentingGoals = [] } = surveyData;

    // Clear existing survey embeddings
    await pool.query('DELETE FROM survey_preference_embeddings WHERE user_id = ?', [userId]);

    const preferenceTypes = [
      { type: 'content', values: contentPreferences },
      { type: 'challenge', values: challengeAreas },
      { type: 'goal', values: parentingGoals },
    ];

    for (const { type, values } of preferenceTypes) {
      for (const value of values) {
        try {
          const descriptiveText = this.getDescriptiveText(type, value);
          const embedding = await this.generateQueryEmbedding(descriptiveText);

          await pool.query(
            `
            INSERT INTO survey_preference_embeddings 
            (user_id, preference_type, preference_value, embedding)
            VALUES (?, ?, ?, ?)
          `,
            [userId, type, value, JSON.stringify(embedding)]
          );
        } catch (error) {
          console.error(`Error generating embedding for ${type}:${value}`, error);
        }
      }
    }
  }

  getDescriptiveText(type, value) {
    const descriptions = {
      content: {
        activities: 'fun educational activities and games for children play time learning',
        discipline: 'positive discipline strategies behavior management parenting techniques',
        emotional: 'emotional support connection empathy understanding child feelings',
        routines: 'daily routines structure schedules consistency parenting habits',
        sleep: 'sleep help bedtime routines rest nighttime parenting',
        nutrition: 'healthy eating nutrition meals food parenting feeding',
        potty: 'potty training toilet training bathroom independence',
        'screen-time': 'screen time management technology devices digital parenting',
        travel: 'traveling with kids family trips vacation parenting',
        'big-feelings': 'managing big emotions anxiety anger sadness parenting support',
      },
      challenge: {
        tantrums: 'tantrum meltdown crying screaming upset child behavior',
        bedtime: 'bedtime struggles sleep problems nighttime routine',
        'picky-eating': 'picky eating food battles mealtime struggles nutrition',
        'sibling-rivalry': 'sibling fighting rivalry jealousy sharing problems',
        'screen-battles': 'screen time battles technology device conflicts',
        'public-behavior': 'public behavior store restaurant outings social situations',
        homework: 'homework resistance school work study struggles',
        transitions: 'transitions difficulty changing activities leaving',
      },
      goal: {
        patience: 'patience calm gentle understanding mindful parenting',
        connection: 'connection bonding relationship closeness family time',
        independence: 'independence self-reliance confidence capability building',
        confidence: 'confidence self-esteem pride capability child development',
        consistency: 'consistency routine structure reliable predictable parenting',
        communication: 'communication talking listening understanding dialogue',
        balance: 'work-life balance time management organization family',
        stress: 'stress reduction calm peaceful relaxed parenting',
      },
    };

    return descriptions[type]?.[value] || `${type} ${value} parenting help advice`;
  }

  async updateCombinedPreferenceProfile(userId) {
    try {
      // Get existing interaction-based preference
      const [existingProfile] = await pool.query(
        'SELECT preference_embedding FROM user_preference_profiles WHERE user_id = ?',
        [userId],
      );

      let interactionEmbedding = null;
      if (existingProfile.length > 0 && existingProfile[0].preference_embedding) {
        interactionEmbedding = Array.isArray(existingProfile[0].preference_embedding)
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
        Array.isArray(row.embedding) ? row.embedding : JSON.parse(row.embedding),
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
          (sv, i) => sv * surveyWeight + interactionEmbedding[i] * (1 - surveyWeight),
        );
      } else {
        combinedEmbedding = surveyAverage;
      }

      // Normalize
      const norm = Math.sqrt(combinedEmbedding.reduce((sum, val) => sum + val * val, 0));
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
        [userId, JSON.stringify(combinedEmbedding), JSON.stringify(surveyAverage), surveyWeight],
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

    const getKeywordsForPreference = (pref) => {
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

    const getKeywordsForChallenge = (challenge) => {
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

    const getKeywordsForGoal = (goal) => {
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
        const tipText = `${tip.title} ${tip.body} ${tip.details}`.toLowerCase();

        contentPrefs.forEach(pref => {
          const keywords = getKeywordsForPreference(pref);
          const matches = keywords.filter(keyword => tipText.includes(keyword)).length;
          boost += matches * 0.05;
        });

        challenges.forEach(challenge => {
          const keywords = getKeywordsForChallenge(challenge);
          const matches = keywords.filter(keyword => tipText.includes(keyword)).length;
          boost += matches * 0.08;
        });

        goals.forEach(goal => {
          const keywords = getKeywordsForGoal(goal);
          const matches = keywords.filter(keyword => tipText.includes(keyword)).length;
          boost += matches * 0.06;
        });

        const newScore = Math.min((tip.similarity_score || 0.5) + boost, 1.0);

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
}

export default new PersonalizationService();
