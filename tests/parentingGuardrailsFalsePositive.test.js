// Documents and guards against a false-positive found while investigating
// generated tips being dropped under categories including "software_it",
// "adult_content", "violence_illegal", and "drugs_alcohol" during a normal
// advice session.
//
// Root cause (confirmed, not hypothetical — see the reproduction below):
// utils/parentingGuardrails.js's SOFTWARE_IT pattern included the bare word
// "it" as a keyword: `/\b(...|software|it|api|...)\b/i`. "it" is one of the
// most common words in English. classifyParentingQuery (which uses this
// pattern) was originally only applied to USER QUERIES, where this was a
// latent but low-impact bug. Once classifyUnsafeContent (which reuses the
// SAME pattern) started being used to gate every GENERATED TIP'S OUTPUT text
// (see services/personalizationService.js's emitLine), the bug became
// high-impact: nearly every generated tip's body/details sentence contains
// "it" somewhere, so the large majority of ordinary, safe tips were being
// rejected as "software_it".
//
// This was NOT caused by Mike's/Ankit's survey data, unsafe content, or any
// personalization-specific code — it's a pre-existing pattern gap that
// became newly reachable via the output-validation gate. The other three
// categories in the bug report (adult_content, violence_illegal,
// drugs_alcohol) were traced separately to Mike's own unsafe SURVEY data
// (see personalizationSafety.test.js's regression cases) leaking into the
// generation prompt before the safety-pipeline gaps below were fixed — not
// a sanitizer false positive, and NOT altered here without evidence.
//
// A second, analogous false positive was found while writing this file's
// own test sentences (not part of the original bug report, but the same
// class of bug and evidenced the same way): FINANCIAL_ACTION's bare action
// verbs ("hold", "call", "put", "buy", "sell"...) triggered "finance_investing"
// with ZERO finance-topic context — e.g. "Hold up the book" alone. Fixed by
// no longer treating FINANCIAL_ACTION as a standalone trigger; FINANCE
// (actual finance nouns: stocks, crypto, trading, invest, etc.) and the
// existing loose-match list are untouched and still catch genuine finance
// content.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyUnsafeContent } from '../utils/parentingGuardrails.js';

test('false positive (fixed): ordinary tip sentences containing "it" are no longer flagged', () => {
    const ordinaryTipSentences = [
        'Practice counting dinosaurs together and talk about it with your child',
        'Point to different animals and name it out loud with your toddler',
        'Ask your child to describe it in their own words',
        'Hold up the book and let your child turn the page when they are ready for it',
        'Give your child a simple choice and let them pick it themselves',
    ];
    for (const sentence of ordinaryTipSentences) {
        const result = classifyUnsafeContent(sentence);
        assert.equal(result.ok, true, `expected "${sentence}" to be approved, got category=${result.category}`);
    }
});

test('SOFTWARE_IT still correctly catches genuine software/IT content (not weakened)', () => {
    const stillCaught = [
        'Learn React Native coding basics',
        'Set up a Kubernetes container for the app',
        'Debug this software algorithm',
    ];
    for (const sentence of stillCaught) {
        const result = classifyUnsafeContent(sentence);
        assert.equal(result.ok, false, `expected "${sentence}" to still be flagged`);
        assert.equal(result.category, 'software_it');
    }
});

test('false positive (fixed): ordinary sentences with common action verbs are not flagged as finance_investing', () => {
    const ordinarySentences = [
        'Hold up the book and let your child turn the page',
        'Call out the color of each toy as you point to it',
        'Put the toy away when you are done playing',
    ];
    for (const sentence of ordinarySentences) {
        const result = classifyUnsafeContent(sentence);
        assert.equal(result.ok, true, `expected "${sentence}" to be approved, got category=${result.category}`);
    }
});

test('genuine finance content is still caught (not weakened)', () => {
    for (const sentence of ['Talk about buying stocks', 'Explain cryptocurrency trading', 'Discuss investing basics']) {
        const result = classifyUnsafeContent(sentence);
        assert.equal(result.ok, false, `expected "${sentence}" to still be flagged`);
        assert.equal(result.category, 'finance_investing');
    }
});

test('inflected violence forms are now caught (evidence for the DANGEROUS_PATTERNS/VIOLENCE_WEAPONS widening)', () => {
    // "beat" alone (via \b...\b) never matched "beaten"/"beating" — the exact
    // gap that let "When he gets beaten" through the personalization survey.
    // Confirmed here at the shared-guardrail level too, since that's what
    // both the survey pipeline and the tip-output gate depend on.
    for (const sentence of ['He gets beaten', 'stop the beating', 'beats his sibling']) {
        const result = classifyUnsafeContent(sentence);
        assert.equal(result.ok, false, `expected "${sentence}" to be flagged`);
    }
});
