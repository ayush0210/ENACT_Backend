// Survey-specific safety pipeline for personalization custom-answer text.
//
// TRUST BOUNDARY: everything in this file treats caregiver-submitted custom
// text as UNTRUSTED until it has passed every step below. Only the
// `normalizedValue` on an "approved" result may ever be persisted, embedded,
// placed in an LLM prompt, or logged. Raw input that fails validation must
// never be stored, echoed back to the client, embedded, or written to
// standard logs/diagnostics/analytics — see the route handler in
// routes/childPersonalization.js, which enforces this by construction (it
// never has a code path that persists anything but `normalizedValue`).
//
// This is a STRICTER layer on top of the shared Parenting Companion
// guardrail (utils/parentingGuardrails.js#classifyUnsafeContent), not a
// second, disconnected safety policy — the shared guardrail's pattern
// constants are reused as-is (see that file), and this module only adds the
// checks that are specific to short, persistent, retrieval/prompt-facing
// survey answers: length/shape validation, PII detection, prompt-injection
// detection, and the category-specific nuance the product spec calls for
// (e.g. "discipline" alone is fine, physical punishment is not).
//
// This module makes NO network calls (no OpenAI, no moderation API) — it is
// pure, synchronous, and fully unit-testable without live/paid requests.
import { classifyUnsafeContent } from './parentingGuardrails.js';

export const PERSONALIZATION_CUSTOM_ANSWER_MAX_LENGTH = 100;

const NEUTRAL_REJECTION_MESSAGE =
    "This response can't be used for personalization. Please enter a child interest, learning goal, or support need.";

// Maps the shared guardrail's category taxonomy onto the narrower
// PersonalizationSafetyResult reasonCode union. self_harm and age_out_of_scope
// don't apply here (classifyUnsafeContent never returns them), listed only
// for completeness/documentation.
const CATEGORY_TO_REASON_CODE = {
    adult_content: 'sexual_content',
    adult_relationships: 'sexual_content',
    drugs_alcohol: 'drugs',
    violence_illegal: 'violence_or_abuse',
    harassment_hate: 'hate_or_harassment',
    illegal_activity: 'dangerous_activity',
    software_it: 'outside_scope',
    finance_investing: 'outside_scope',
    politics: 'outside_scope',
    gambling: 'outside_scope',
    career_jobs: 'outside_scope',
    medical_legal: 'medical_advice',
};

// --- Survey-specific pattern layers (on top of the shared guardrail) -------

// Physical/abusive discipline must be rejected; "discipline" itself, positive
// discipline, routines, redirection, and emotion-regulation wording must not
// be auto-rejected by a bare keyword match (the shared guardrail doesn't
// block "discipline" at all, so this is purely additive).
const ABUSIVE_DISCIPLINE_PATTERNS = [
    /\b(spank(ing|ed)?|smack(ing|ed)?|slap(ping|ped)?|whip(ping|ped)?|paddl(e|ing|ed))\b/i,
    /\b(hit|beat|belt)\s+(my|the|her|him|them)\s+(child|kid|toddler|baby|son|daughter)\b/i,
    /\b(physical|corporal)\s+punishment\b/i,
    /\b(humiliat(e|ing|ion)|shame\s+(him|her|them)|public(ly)?\s+humiliat)/i,
    /\b(threaten(ing)?|scare|terrify)\s+(him|her|them|my|the)\s*(child|kid)?\b/i,
    /\b(lock(ing)?|cage|confine)\s+(him|her|them|my child|the child)\b/i,
];

// The shared guardrail's classifyUnsafeContent buckets drugs together with
// violence/weapons/hacking under one broad "illegal_activity" category (see
// DANGEROUS_PATTERNS in parentingGuardrails.js) — accurate there, since that
// path only needs a single reject decision for a live tip query. Personalization
// needs the more specific "drugs" reasonCode the product spec calls for, so
// this narrow, survey-specific check runs first and reuses the same handful
// of substance names rather than widening the shared bucket's behavior.
const DRUG_REFERENCE_PATTERN =
    /\b(cocaine|heroin|meth(amphetamine)?|fentanyl|mdma|lsd|ecstasy|weed|marijuana|cannabis|opioid|crack|xanax|adderall|narcotics?|vape|vaping|alcohol|drugs?)\b/i;

// Explicit sexual content is always rejected outright, regardless of context.
const EXPLICIT_SEXUAL_PATTERNS = [
    /\b(porn|nude|naked|orgasm|fetish|kink|nsfw|masturbat)\b/i,
    /\bsexual(ly)?\s+(act|content|abuse|explicit)\b/i,
];

// Legitimate, age-appropriate body-safety education. A bare "sex" alone
// (e.g. inside "sex education") must not be treated as a hard reject when
// framed this way — see requirement: "the word 'sex' must not be the sole
// reason for a decision."
const BODY_SAFETY_ALLOWLIST_PATTERN =
    /\b(body\s*safety|private\s*parts|safe\s*touch|good\s*touch|bad\s*touch|body\s*autonomy|body\s*boundaries|consent)\b/i;

// Prompt-injection / instruction-like content. Custom answers are DATA, never
// instructions — this catches attempts to redirect the model or this
// pipeline itself.
const PROMPT_INJECTION_PATTERNS = [
    /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?|context)\b/i,
    /\b(system\s*prompt|you\s+are\s+now|act\s+as\s+(if\s+you('re| are)\s+)?(a|an)\b|new\s+instructions?:)/i,
    /\b(disregard|override|bypass)\s+(the\s+)?(safety|guardrails?|rules?|policy|moderation)\b/i,
    /^\s*(system|assistant|user)\s*:/i,
    /```/, // code-fence style instruction smuggling
];

// Simple PII detectors: email, phone numbers, long digit runs (SSN/card-like),
// and street-address-shaped text. Conservative on purpose — false positives
// here just mean "please rephrase," not a safety incident.
const PII_PATTERNS = [
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,
    /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/, // SSN-shaped
    /\b\d{9,}\b/,
    /\b\d{1,5}\s+\w+(\s+\w+){0,3}\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd|court|ct)\b/i,
];

const collapseWhitespace = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const stripHtml = value => value.replace(/[<>]/g, '');

/**
 * @typedef {{ status: 'approved', normalizedValue: string, category: 'favorite'|'skill'|'support' }
 *   | { status: 'needs_review', reasonCode: string }
 *   | { status: 'rejected', reasonCode: 'sexual_content'|'drugs'|'violence_or_abuse'|'medical_advice'|'personal_information'|'hate_or_harassment'|'dangerous_activity'|'outside_scope'|'prompt_injection' }
 * } PersonalizationSafetyResult
 */

/**
 * Validates and normalizes one custom personalization answer.
 *
 * Contract: callers must not invoke this for a blank/whitespace-only answer
 * (that's "no answer given," not something to reject) — check with
 * `isBlankCustomAnswer` first and simply omit the field instead.
 *
 * @param {{ category: 'favorite'|'skill'|'support', value: string, childAge: number }} input
 * @returns {PersonalizationSafetyResult}
 */
export function validateAndNormalizePersonalizationInput({ category, value, childAge: _childAge }) {
    // Note: childAge is accepted for interface parity with the canonical
    // option validator (utils/personalizationOptions.js), which DOES enforce
    // age bands. There's no reliable pattern-based way to judge whether a
    // free-text custom answer is age-appropriate, so it isn't used to reject
    // here — age-appropriateness for custom text is a caregiver judgment
    // call, same as it is for a "None of the above, add your own" field
    // anywhere else in the product. Safety (this file) and age-fit (the
    // option registry) are deliberately separate concerns.

    // 1. Type and length.
    if (typeof value !== 'string') {
        return { status: 'rejected', reasonCode: 'outside_scope' };
    }

    // 2. Trim + normalize whitespace, strip HTML-ish characters so it's never
    //    rendered as markup, and truncate to the shared max length.
    const collapsed = collapseWhitespace(stripHtml(value));
    const normalized = collapsed.slice(0, PERSONALIZATION_CUSTOM_ANSWER_MAX_LENGTH);

    // 3. Reject empty custom answers (defensive — see contract note above).
    if (normalized.length === 0) {
        return { status: 'rejected', reasonCode: 'outside_scope' };
    }

    // Must contain at least one letter — filters pure noise/spam
    // ("1234", "!!!") without needing a full relevance classifier.
    if (!/[a-zA-Z]/.test(normalized)) {
        return { status: 'rejected', reasonCode: 'outside_scope' };
    }

    // 5. Personal information.
    if (PII_PATTERNS.some(re => re.test(normalized))) {
        return { status: 'rejected', reasonCode: 'personal_information' };
    }

    // 6. Prompt injection / instruction-like content.
    if (PROMPT_INJECTION_PATTERNS.some(re => re.test(normalized))) {
        return { status: 'rejected', reasonCode: 'prompt_injection' };
    }

    // Survey-specific: explicit sexual content is always rejected outright.
    if (EXPLICIT_SEXUAL_PATTERNS.some(re => re.test(normalized))) {
        return { status: 'rejected', reasonCode: 'sexual_content' };
    }

    // Survey-specific: drugs get their own precise reasonCode (see comment
    // on DRUG_REFERENCE_PATTERN above).
    if (DRUG_REFERENCE_PATTERN.test(normalized)) {
        return { status: 'rejected', reasonCode: 'drugs' };
    }

    // Survey-specific: abusive/physical discipline is always rejected, even
    // though "discipline" alone is in scope.
    if (ABUSIVE_DISCIPLINE_PATTERNS.some(re => re.test(normalized))) {
        return { status: 'rejected', reasonCode: 'violence_or_abuse' };
    }

    // 7. Shared Parenting Companion scope/safety check (reused, not
    //    reimplemented — see utils/parentingGuardrails.js#classifyUnsafeContent).
    const shared = classifyUnsafeContent(normalized);
    if (!shared.ok) {
        // "sex" must not be the sole reason for a decision: if the ONLY
        // reason the shared check flagged this is the bare word "sex" (i.e.
        // category is adult_content but none of the explicit patterns above
        // matched), and the text uses legitimate body-safety framing, treat
        // it as approved rather than rejected.
        if (shared.category === 'adult_content' && BODY_SAFETY_ALLOWLIST_PATTERN.test(normalized)) {
            // fall through to approval below
        } else if (shared.category === 'adult_content' && /\bsex\b/i.test(normalized)) {
            // Bare "sex" with no explicit terms and no body-safety framing:
            // ambiguous rather than clearly unsafe. Not saveable today (no
            // human-review flow exists yet), but distinguished from a hard
            // reject for future review tooling.
            return { status: 'needs_review', reasonCode: 'ambiguous_sexual_context' };
        } else {
            const reasonCode = CATEGORY_TO_REASON_CODE[shared.category] || 'outside_scope';
            return { status: 'rejected', reasonCode };
        }
    }

    // 8. Category relevance is intentionally light-touch (no NLP relevance
    //    model): anything that passes the safety checks above and contains
    //    real text is accepted for whichever category the caregiver placed
    //    it in — the category itself is just where the caregiver chose to
    //    file a short, already-safety-checked interest/goal/need.

    // 9-10. Normalize into a short child-profile concept and return.
    return {
        status: 'approved',
        normalizedValue: normalized,
        category,
    };
}

export function getNeutralRejectionMessage() {
    return NEUTRAL_REJECTION_MESSAGE;
}
