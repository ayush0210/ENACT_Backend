// Regression tests for the "every prompt rejected as unsupported" bug.
//
// Root cause: index.js's WebSocket handler called the ASYNC function
// `isStrictlyInScope(prompt, approvedActivities)` WITHOUT `await`. `v` was
// therefore a pending Promise, `v.isValid` was always `undefined`, and
// `!v.isValid` was always `true` — so EVERY query, valid or not, was
// rejected as out-of-scope. This predates the child-personalization work
// (introduced when isStrictlyInScope became async for the LLM domain
// classifier, in the "guardrails pipeline changes" commit) but was only
// noticed while re-testing the WS flow for personalization.
//
// index.js itself (the WS server) isn't unit-testable in isolation — it
// opens a real MySQL pool and a real HTTP/WebSocket server as import-time
// side effects (see services/childPersonalizationService.js's comment on
// the same issue). So this file combines:
//   1. Direct tests of isStrictlyInScope (the guardrail itself) — these use
//      the activity-whitelist fast path, which needs no OpenAI/network call.
//   2. Source-level regression guards on index.js's WS handler, pinning the
//      exact ordering/behavior contract that broke — `await` present,
//      scope check before survey-context concatenation, ownership check
//      before childId use. These fail immediately if the same mistake (or
//      an equivalent one) is reintroduced, without needing to boot the
//      server or mock a WebSocket end-to-end.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// utils/strictDomains.js constructs an OpenAI client at import time and
// throws if OPENAI_API_KEY is unset. None of the test cases below reach the
// LLM classifier (they all hit the deterministic activity-whitelist or
// absolute-reject fast paths — see isStrictlyInScope's own comments), so a
// placeholder is enough to satisfy the constructor without ever making a
// real request.
process.env.OPENAI_API_KEY ||= 'test-key-not-used';

const { isStrictlyInScope } = await import('../utils/strictDomains.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

// --- 1. The guardrail itself approves genuinely valid prompts ---

test('valid prompt "Tips for my 1-year-old at the park" is approved', async () => {
    const result = await isStrictlyInScope('Tips for my 1-year-old at the park', ['Park']);
    assert.equal(result.isValid, true);
});

test('valid prompt "Language-development activities for Ankit at the park" is approved', async () => {
    const result = await isStrictlyInScope(
        'Language-development activities for Ankit at the park',
        ['Park'],
    );
    assert.equal(result.isValid, true);
});

test('valid prompt "Tips for my toddler during bath time" is approved', async () => {
    const result = await isStrictlyInScope('Tips for my toddler during bath time', ['Bath time']);
    assert.equal(result.isValid, true);
});

test('an unsupported prompt is still rejected (guardrail not weakened by the fix)', async () => {
    const result = await isStrictlyInScope('cocaine dosage for my toddler', []);
    assert.equal(result.isValid, false);
});

// --- 2. Regression guard: isStrictlyInScope is async and must be awaited ---

test('regression guard: isStrictlyInScope returns a Promise (it is async — callers must await it)', () => {
    const maybePromise = isStrictlyInScope('Tips for my 1-year-old at the park', ['Park']);
    assert.ok(
        maybePromise instanceof Promise,
        'isStrictlyInScope is async — a caller that forgets `await` gets a pending Promise back, ' +
            'whose .isValid is always undefined, silently rejecting every query',
    );
});

test('regression guard: index.js awaits isStrictlyInScope in the WS handler', () => {
    assert.match(
        indexSource,
        /await isStrictlyInScope\(/,
        'the WS handler must `await isStrictlyInScope(...)` — without it, every prompt is rejected regardless of content',
    );
    // Guard against the exact prior bug text specifically (no leading `await`).
    assert.doesNotMatch(
        indexSource,
        /(?<!await )isStrictlyInScope\(prompt, approvedActivities\)/,
        'found an un-awaited call to isStrictlyInScope — this is the exact regression that rejected every prompt',
    );
});

// --- 3. Regression guard: processing order (scope check before personalization) ---

test('regression guard: the query is not contaminated with survey/personalization text before scope validation', () => {
    const scopeCallIndex = indexSource.indexOf('await isStrictlyInScope(prompt');
    const surveyContextDeclIndex = indexSource.indexOf("let surveyContext = '';");
    const childProfileBlockIndex = indexSource.indexOf('CHILD_PROFILE');

    assert.notEqual(scopeCallIndex, -1, 'expected to find the scope-check call site');
    assert.notEqual(surveyContextDeclIndex, -1, 'expected to find survey context declaration');

    assert.ok(
        scopeCallIndex < surveyContextDeclIndex,
        'scope validation must run on the raw prompt BEFORE any survey/personalization context is built or appended to it',
    );
    // CHILD_PROFILE injection lives entirely inside personalizationService.js's
    // prompt builder, which index.js only calls after the scope check returns
    // (via generateTipsStreamNDJSON) — so it should never appear before it here.
    if (childProfileBlockIndex !== -1) {
        assert.ok(scopeCallIndex < childProfileBlockIndex);
    }
});

test('regression guard: child ownership is verified before childId is used for personalization', () => {
    const ownershipCheckIndex = indexSource.indexOf(
        'SELECT id FROM children WHERE id = ? AND user_id = ?',
    );
    const scopeCallIndex = indexSource.indexOf('await isStrictlyInScope(prompt');
    assert.notEqual(ownershipCheckIndex, -1, 'expected an ownership-verifying query for childId');
    // Ownership check happens before the scope check in the current handler
    // (both must happen before generation either way); assert it exists and
    // precedes generation, which is what actually matters for security.
    const generationCallIndex = indexSource.indexOf('generateTipsStreamNDJSON({');
    assert.ok(ownershipCheckIndex < generationCallIndex);
    assert.ok(scopeCallIndex < generationCallIndex);
});

// --- 4. Payload schema contract (pinned on both frontend and backend) ---
// See talk-around-town-native's src/screens/__tests__/wsPayloadSchema.test.ts
// for the frontend half of this same contract.

test('payload schema contract: the WS handler destructures the fields the client actually sends', () => {
    assert.match(indexSource, /const\s*\{\s*\n?\s*prompt,/, 'expected `prompt` field');
    assert.match(indexSource, /contentPreferences\s*=\s*\[\]/, 'expected `contentPreferences` field');
    assert.match(indexSource, /generateMode\s*=\s*'hybrid'/, 'expected `generateMode` field');
    assert.match(indexSource, /childId:\s*rawChildId\s*=\s*null/, 'expected `childId` field');
});
