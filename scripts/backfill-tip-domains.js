// One-time backfill: assigns tips.domain (added by
// migrations/004_add_domain_to_tips.sql) to every existing tip that doesn't
// have one yet — the 201 `source='db'` seed tips (keyed by a location/
// context `type` like "Bus/Walk", not a content domain) and the 85
// pre-existing `source='ai'` tips whose domain was only ever captured as
// free text in tip_categories.
//
// Two-step recovery per tip, cheapest first:
//   1. Check tip_categories for a category_value that normalizes to one of
//      the 4 canonical domains (SELECTABLE_DOMAINS) — this is the SAME
//      classification the AI pipeline already made at generation time, just
//      reading it back instead of re-deriving it. No API call needed.
//   2. If that's not available (true for all 201 `source='db'` seed tips),
//      classify from title+description with a single-domain-output LLM
//      call, using the exact same 4-domain constraint as
//      personalizationService.js's tip generation.
//
// SAFE BY DEFAULT: dry run unless you pass --commit. Dry run prints exactly
// what it would set so you can read it over before writing anything.
//
// Usage (run ON THE SERVER, after applying migrations/004 and 005):
//   node scripts/backfill-tip-domains.js            # dry run — no writes
//   node scripts/backfill-tip-domains.js --commit    # actually writes

import { OpenAI } from 'openai';
import pool from '../config/db.js';
import { SELECTABLE_DOMAINS, normalizeGeneratedDomain } from '../services/personalizationService.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const COMMIT = process.argv.includes('--commit');
const DELAY_MS_BETWEEN_LLM_CALLS = 250; // light pacing, not a real rate limiter — 286 rows max, fine at this volume

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function recoverFromTipCategories(tipId) {
    const [rows] = await pool.query(
        'SELECT category_value FROM tip_categories WHERE tip_id = ?',
        [tipId],
    );
    for (const row of rows) {
        const normalized = normalizeGeneratedDomain(row.category_value);
        if (SELECTABLE_DOMAINS.includes(normalized)) return normalized;
    }
    return null;
}

async function classifyWithLLM(title, description) {
    const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_TIPS_MODEL || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 20,
        messages: [
            {
                role: 'system',
                content: `You classify a parenting tip into exactly ONE of these 4 fixed domains: ${SELECTABLE_DOMAINS.join(', ')}. Respond with ONLY the domain name, exactly as written, nothing else.`,
            },
            {
                role: 'user',
                content: `Title: "${title}"\nDescription: "${description}"`,
            },
        ],
    });
    const raw = completion.choices?.[0]?.message?.content?.trim();
    const normalized = normalizeGeneratedDomain(raw);
    return SELECTABLE_DOMAINS.includes(normalized) ? normalized : null;
}

async function main() {
    const [tips] = await pool.query(
        'SELECT id, title, description, source FROM tips WHERE domain IS NULL ORDER BY id',
    );

    console.log(
        `${tips.length} tip(s) need a domain.${COMMIT ? '' : ' DRY RUN — pass --commit to actually write.'}\n`,
    );

    let fromCategories = 0;
    let fromLLM = 0;
    let unresolved = 0;

    for (const tip of tips) {
        let domain = await recoverFromTipCategories(tip.id);
        let method = 'tip_categories';

        if (!domain) {
            try {
                domain = await classifyWithLLM(tip.title, tip.description);
                method = 'llm';
                await sleep(DELAY_MS_BETWEEN_LLM_CALLS);
            } catch (err) {
                console.error(`  tip ${tip.id}: LLM classification failed — ${err.message}`);
            }
        }

        if (!domain) {
            unresolved++;
            console.warn(`  tip ${tip.id} [UNRESOLVED, needs manual tagging]: "${tip.title}"`);
            continue;
        }

        if (method === 'tip_categories') fromCategories++;
        else fromLLM++;

        console.log(`  tip ${tip.id} (${method} -> ${domain}): "${tip.title}"`);

        if (COMMIT) {
            await pool.query('UPDATE tips SET domain = ? WHERE id = ?', [domain, tip.id]);
        }
    }

    console.log(
        `\nDone. Recovered from tip_categories: ${fromCategories}, classified by LLM: ${fromLLM}, unresolved: ${unresolved}.`,
    );
    if (!COMMIT) {
        console.log('This was a DRY RUN — no rows were changed. Re-run with --commit to write.');
    }
    if (unresolved > 0) {
        console.log(`${unresolved} tip(s) need manual review — see [UNRESOLVED] lines above.`);
    }

    await pool.end();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
