// --- Patterns -------------
const DANGEROUS_PATTERNS = [
    // Violence / illegal
    /\b(beat|kill|murder|harm|poison|assault|stab|shoot|buy\s*gun|make\s*bomb|arson|break\s?in|burglary|steal|kidnap|abduct|stalk)\b/i,
    // Self-harm
    /\b(suicide|self[-\s]?harm|self[-\s]?injur(y|e)|kill myself|end my life|cutting)\b/i,
    // Adult sexual content
    /\b(porn|nsfw|onlyfans|nude|nudes|erotic|fetish|sex\s*positions?|blowjob|handjob)\b/i,
    // Drugs
    /\b(cocaine|heroin|meth(amphetamine)?|lsd|ecstasy|mdma|fentanyl|ketamine|weed|marijuana|how to get high|vape)\b/i,
    // Weapons / explosives specifics
    /\b(suppressor|ghost gun|tannerite|homemade\s*(gun|explosive|grenade)|anfo)\b/i,
    // Hacking / cybercrime
    /\b(hack|ddos|phish|crack\s*passwords?|botnet|keylogger|malware|ransomware)\b/i,
];

const URL_PATTERN = /(https?:\/\/|www\.)\S+/i;

const CONTACT_DOXXING = [
    /\b(phone|email|whatsapp|snap(chat)?|instagram|address|home\s*address|social\s*media)\b/i,
    /\bDM me|text me|call me\b/i,
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // US phone
];

const PROFANITY_HARASSMENT_HATE = [
    /\b(fuck|shit|bitch|asshole|bastard)\b/i,
    /\b(kill yourself|kys|die)\b/i,
    // add any specific slurs your policy team flags
];

const FINANCE =
    /\b(stocks?|crypto|bitcoin|ether(eum)?|nft|portfolio|dividends?|options?|short(ing)?|forex|trading|invest(ing|ment))\b/i;
const FINANCIAL_ACTION =
    /\b(buy|sell|hold|short|leverage|call|put|strike|stop[-\s]?loss)\b/i;

const POLITICS =
    /\b(election|vote|president|senate|congress|policy|democrat|republican|left|right|liberal|conservative)\b/i;
const GAMBLING =
    /\b(gambl(e|ing)|casino|bet(s|ting)|blackjack|roulette|poker|sportsbook|odds|parlay|lottery)\b/i;
const CAREER =
    /\b(resume|cv|cover letter|interview|job|salary|promotion|manager|career|recruit(er|ing))\b/i;

const SOFTWARE_IT =
    /\b(algorithm|code|coding|program|software|it|api|bug|deploy|container|kubernetes|docker)\b/i;
const EXPLOIT_ILLEGAL =
    /\b(hack(ing)?|exploit|sql injection|ddos|malware|shellcode|rootkit|zero[-\s]?day)\b/i;

const VIOLENCE_WEAPONS =
    /\b(kill|murder|stab|shoot|bomb|grenade|gun|pistol|rifle|ammo|arson|beat)\b/i;
const DRUGS =
    /\b(heroin|cocaine|meth|mdma|lsd|fentanyl|opioid|weed|marijuana|vape|alcohol|vodka|whiskey|beer)\b/i;

const ADULT_REL = /\b(dating|boyfriend|girlfriend|hookup|sext)\b/i;
const SEXUAL =
    /\b(sex|oral|anal|fetish|kink|orgasm|nude|naked|porn|nsfw|explicit)\b/i;

const ILLEGAL =
    /\b(steal|shoplift|counterfeit|fake id|piracy|torrent|crack(ed)? key|carding)\b/i;

const MEDICAL_LEGAL =
    /\b(dose|dosage|diagnos(is|e)|prescribe|antibiotic|legal advice|lawsuit|attorney|will\s+draft)\b/i;

const MEDICAL_LEGAL_PATTERNS = [
    // medical diagnosis/treatment (we do not give medical advice)
    /\b(diagnos(e|is)|prescrib(e|ing)|dosage|antibiotic|treat(ment)?|medication|medicine|vaccine|contraindications?)\b/i,
    // legal/financial advice
    /\b(legal advice|contract law|sue|lawsuit|tax advice|deduction|withholding|investment advice|stocks?)\b/i,
];

const HYPOTHETICAL_FRAMING =
    /\b(hypothetical(ly)?|assume|let'?s say|consider|imagine|for (the )?sake of argument|suppose)\b/i;

// ✅ NEW: topics we *do* serve (broad but kid-safe)
export const PARENTING_TOPICS = [
    'bath',
    'bathe',
    'bath time',
    'bathtime',
    'hygiene',
    'teeth',
    'toothbrushing',
    'brush teeth',
    'potty',
    'toilet',
    'diaper',
    'diapers',
    'nappy',
    'toilet training',
    'potty training',
    'sleep',
    'bedtime',
    'nap',
    'naptime',
    'routine',
    'morning routine',
    'bedtime routine',
    'tantrum',
    'tantrums',
    'meltdown',
    'big feelings',
    'emotion',
    'self-regulation',
    'calm down',
    'sharing',
    'turn-taking',
    'social skills',
    'play',
    'playtime',
    'independent play',
    'reading',
    'storytime',
    'language',
    'vocabulary',
    'screen time',
    'tv',
    'tablet',
    'safety',
    'stranger danger',
    'car seat',
    'booster seat',
    'seatbelt',
    'feeding',
    'mealtime',
    'picky eating',
    'snack',
    'water',
    'bottle',
    'cup',
    'wean',
    'weaning',
    'clothes',
    'dressing',
    'undressing',
    'shoes',
    'toys',
    'cleanup',
    'chores',
    'daycare',
    'preschool',
    'drop-off',
    'separation anxiety',
    'transition',
    'gross motor',
    'fine motor',
    'milestone',
    'activity',
    'indoor activity',
    'outdoor activity',
    'behavior',
    'discipline',
    'homework',
    'literacy',
    'activities',
    'speech',
    'picky eater',
    'vegetables',
    'social',
    'bullying',
    'focus',
    'study',
    'grades',
    'friends',
];

// ✅ NEW: child-focused anchors (ages/roles)
export const CHILD_TERMS = [
    'baby',
    'infant',
    'newborn',
    'toddler',
    'preschool',
    'kid',
    'child',
    'little one',
    '1-year-old',
    '2-year-old',
    '3-year-old',
    '4-year-old',
    '5-year-old',
    '1 yo',
    '2 yo',
    '3 yo',
    '4 yo',
    '5 yo',
    'age 1',
    'age 2',
    'age 3',
    'age 4',
    'age 5',
    '1 yr',
    '2 yr',
    '3 yr',
    '4 yr',
    '5 yr',
    '1 year',
    '2 year',
    '3 year',
    '4 year',
    '5 year',
];

// ✅ Optional: sensitive-but-legit parenting terms we don’t want auto-flagged as “adult”
const ALLOWLIST_SENSITIVE_PARENTING = [
    'breastfeed',
    'breastfeeding',
    'nursing',
    'latch',
    'wean',
    'weaning',
];

// const CHILD_TERMS = [
//     'child',
//     'kid',
//     'kids',
//     'children',
//     'toddler',
//     'baby',
//     'infant',
//     'newborn',
//     'teen',
//     'teenager',
//     'preteen',
//     'son',
//     'daughter',
//     'my boy',
//     'my girl',
//     'my kid',
//     'my child',
//     'my toddler',
//     'my baby',
//     'parent',
//     'parenting',
//     'student',
//     'students',
//     'daycare',
//     'preschool',
//     'school',
//     'classroom',
// ];

// const PARENTING_TOPICS = [
//     'bedtime',
//     'sleep',
//     'tantrum',
//     'meltdown',
//     'behavior',
//     'discipline',
//     'routine',
//     'screen time',
//     'homework',
//     'reading',
//     'literacy',
//     'milestone',
//     'play',
//     'activity',
//     'activities',
//     'language',
//     'speech',
//     'feeding',
//     'picky eater',
//     'vegetables',
//     'toilet',
//     'potty',
//     'diaper',
//     'social',
//     'sharing',
//     'bullying',
//     'focus',
//     'study',
//     'grades',
//     'friends',
// ];

// Age cues like "3yo", "3-year-old", "18 months old"
const AGE_PATTERNS = [
    /\b\d{1,2}\s?(yo|yrs?|years?)\b/i,
    /\b\d{1,2}\s?(-|\s)?year[-\s]?old\b/i,
    /\b\d{1,2}\s?(months?|mos?)\s?old\b/i,
];

// --- Helpers --------------

function extractAgeYears(q) {
    const m1 = q.match(/\b(\d{1,2})\s?(yo|yrs?|years?)\b/i);
    const m2 = q.match(/\b(\d{1,2})\s?(-|\s)?year[-\s]?old\b/i);
    if (m1) return parseInt(m1[1], 10);
    if (m2) return parseInt(m2[1], 10);
    return null;
}
function hardNormalize(input) {
    // use your existing hardNormalize if you already added it; else keep this light one
    return (input || '').toString().toLowerCase().trim();
}

function containsAny(text, terms) {
    const t = hardNormalize(text);
    return terms.some(w => t.includes(w));
}

// Parenting = at least one child term OR (common generic “parent/parenting/caregiver”) AND a known topic
function looksParentingRelated(text) {
    const t = hardNormalize(text);
    const generic = /\b(parent(ing)?|caregiver|mom|mother|dad|father)\b/i.test(
        text,
    );
    const hasChildWord = containsAny(t, CHILD_TERMS);
    const hasTopic =
        containsAny(t, PARENTING_TOPICS) ||
        /\b(routine|bedtime|tantrum|potty|toilet|bath|nap|play)\b/i.test(text);
    return (
        (hasChildWord && hasTopic) ||
        (generic && hasTopic) ||
        (hasTopic && /\b(age\s?[0-5]|[1-5]\s?yo)\b/i.test(text))
    );
}

// Strong anchors = MUST have (child term) AND (topic). Used when user uses “hypothetically/assume…”
function hasStrongParentingAnchors(text) {
    const t = hardNormalize(text);
    const hasChildWord = containsAny(t, CHILD_TERMS);
    const hasTopic = containsAny(t, PARENTING_TOPICS);
    return hasChildWord && hasTopic;
}
// Build a loose regex that allows up to 3 non-letters between letters: e.g. "s * e x"
function looseWordRegex(word) {
    const letters = Array.from(word.toLowerCase()).map(ch => {
        // escape regex special chars
        return ch.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    });
    // Allow up to 3 non-letters between each character
    return new RegExp(letters.join('[^a-zA-Z]{0,3}') + 's?', 'i'); // plural-ish
}

// Test any of several loose patterns
function matchesLooseAny(text, words) {
    return words.some(w => looseWordRegex(w).test(text));
}

// --- Public API ------------

// single source of truth for route responses
export const CATEGORY_RESPONSES = {
    adult_content: { http: 400, msg: 'We only provide parenting tips.' },
    adult_relationships: { http: 400, msg: 'We only provide parenting tips.' },
    violence_illegal: { http: 400, msg: 'We only provide parenting tips.' },
    weapons: { http: 400, msg: 'We only provide parenting tips.' },
    drugs_alcohol: { http: 400, msg: 'We only provide parenting tips.' },
    gambling: { http: 400, msg: 'We only provide parenting tips.' },
    politics: { http: 400, msg: 'We only provide parenting tips.' },
    finance_investing: { http: 400, msg: 'We only provide parenting tips.' },
    career_jobs: { http: 400, msg: 'We only provide parenting tips.' },
    software_it: { http: 400, msg: 'We only provide parenting tips.' },
    illegal_activity: { http: 400, msg: 'We only provide parenting tips.' },
    medical_legal: { http: 400, msg: 'We only provide parenting tips.' },
    harassment_hate: { http: 400, msg: 'We only provide parenting tips.' },
    self_harm: {
        http: 400,
        msg: 'If you’re thinking about self-harm, you’re not alone. If you’re in immediate danger, call your local emergency number. In the U.S., you can dial or text 988 for support.',
    },
    non_parenting: { http: 400, msg: 'We only provide parenting tips.' },
    age_out_of_scope: { http: 400, msg: 'This app is for ages 0–5.' },
    ok: { http: 200, msg: 'ok' },
};

// --- Add helpers ---
function looksBase64(s) {
    // heuristic: long-ish, valid chars, divisible by 4
    return (
        /^[A-Za-z0-9+/=\s]{12,}$/.test(s.replace(/\s+/g, '')) &&
        s.replace(/\s+/g, '').length % 4 === 0
    );
}
function tryBase64Decode(s) {
    try {
        const clean = s.replace(/\s+/g, '');
        // atob polyfill for Node: Buffer
        return Buffer.from(clean, 'base64').toString('utf8');
    } catch {
        return null;
    }
}

function looksHex(s) {
    return /^(?:0x)?[0-9a-fA-F\s]{16,}$/.test(s);
}
function tryHexDecode(s) {
    try {
        const clean = s.replace(/\s+/g, '').replace(/^0x/, '');
        if (clean.length % 2 !== 0) return null;
        return Buffer.from(clean, 'hex').toString('utf8');
    } catch {
        return null;
    }
}

// helper: test arrays of regex
function hasMatch(text, patterns) {
    return patterns?.some(re => re.test(text)) || false;
}

export function classifyParentingQuery(prompt) {
    const raw = prompt || '';
    const q = hardNormalize(raw); // your hardened normalizer (lowercase, trim, etc.)

    // --- Re-check decoded variants (base64/hex) BEFORE anything else ---
    const decodedCandidates = [];
    if (looksBase64(raw)) {
        const d = tryBase64Decode(raw);
        if (d) decodedCandidates.push(d);
    }
    if (looksHex(raw)) {
        const d = tryHexDecode(raw);
        if (d) decodedCandidates.push(d);
    }
    for (const dec of decodedCandidates) {
        const sub = classifyParentingQuery(dec); // recursive check on decoded text
        if (!sub.ok) return sub;
    }

    // --- Age gate ---
    const age = extractAgeYears(q);
    if (Number.isInteger(age) && age > 5) {
        return { ok: false, category: 'age_out_of_scope' };
    }

    // --- Parenting scope signals ---
    const isParenting = looksParentingRelated(q); // uses PARENTING_TOPICS + CHILD_TERMS
    const hasSensitiveParenting = containsAny(q, ALLOWLIST_SENSITIVE_PARENTING); // e.g., breastfeeding terms
    const framing = HYPOTHETICAL_FRAMING.test(q);

    // --- Broad dangerous fast-fail (violence/illegal/drugs/hacking bucket you defined) ---
    if (hasMatch(q, DANGEROUS_PATTERNS)) {
        return { ok: false, category: 'illegal_activity' };
    }

    // --- Adult/sexual content: allow breastfeeding/weaning terms; otherwise block ---
    if (!hasSensitiveParenting) {
        if (
            SEXUAL.test(q) ||
            matchesLooseAny(q, [
                'sex',
                'porn',
                'nude',
                'orgasm',
                'fetish',
                'kink',
            ])
        ) {
            return { ok: false, category: 'adult_content' };
        }
        if (ADULT_REL.test(q) || matchesLooseAny(q, ['dating', 'hookup'])) {
            return { ok: false, category: 'adult_relationships' };
        }
    }

    // --- Other disallowed categories ---
    if (PROFANITY_HARASSMENT_HATE.some(re => re.test(q))) {
        return { ok: false, category: 'harassment_hate' };
    }
    if (
        VIOLENCE_WEAPONS.test(q) ||
        matchesLooseAny(q, [
            'kill',
            'murder',
            'shoot',
            'bomb',
            'weapon',
            'gun',
            'knife',
        ])
    ) {
        return { ok: false, category: 'violence_illegal' };
    }
    if (
        DRUGS.test(q) ||
        matchesLooseAny(q, [
            'weed',
            'marijuana',
            'cocaine',
            'heroin',
            'meth',
            'lsd',
            'mdma',
            'fentanyl',
            'vape',
            'alcohol',
        ])
    ) {
        return { ok: false, category: 'drugs_alcohol' };
    }
    if (
        FINANCE.test(q) ||
        FINANCIAL_ACTION.test(q) ||
        matchesLooseAny(q, [
            'crypto',
            'bitcoin',
            'ethereum',
            'stock',
            'forex',
            'option',
            'trading',
            'invest',
        ])
    ) {
        return { ok: false, category: 'finance_investing' };
    }
    if (POLITICS.test(q)) {
        return { ok: false, category: 'politics' };
    }
    if (
        GAMBLING.test(q) ||
        matchesLooseAny(q, [
            'casino',
            'poker',
            'blackjack',
            'bet',
            'parlay',
            'sportsbook',
            'lottery',
        ])
    ) {
        return { ok: false, category: 'gambling' };
    }
    if (CAREER.test(q)) {
        return { ok: false, category: 'career_jobs' };
    }
    if (
        ILLEGAL.test(q) ||
        EXPLOIT_ILLEGAL.test(q) ||
        matchesLooseAny(q, [
            'hack',
            'exploit',
            'ddos',
            'malware',
            'sql injection',
            'rootkit',
            'zero day',
        ])
    ) {
        return { ok: false, category: 'illegal_activity' };
    }
    if (SOFTWARE_IT.test(q)) {
        return { ok: false, category: 'software_it' };
    }
    if (MEDICAL_LEGAL.test(q) || hasMatch(q, MEDICAL_LEGAL_PATTERNS)) {
        return { ok: false, category: 'medical_legal' };
    }

    // --- Framing gets stricter: require strong parenting anchors when "hypothetical/assume/let's say/consider" appears ---
    if (framing) {
        const hasChildWord = containsAny(q, CHILD_TERMS);
        const hasTopic = containsAny(q, PARENTING_TOPICS);
        const strongParentingAnchors = hasChildWord && hasTopic;
        if (!strongParentingAnchors) {
            return { ok: false, category: 'non_parenting' };
        }
    }

    // --- Final parenting scope check ---
    if (!isParenting) {
        return { ok: false, category: 'non_parenting' };
    }

    return { ok: true, category: 'ok', age: age ?? null };
}

// Backwards compatible wrapper you already call in routes
export function validateParentingQuery(prompt) {
    const r = classifyParentingQuery(prompt);
    if (!r.ok)
        return {
            isValid: false,
            type: r.category,
            message:
                CATEGORY_RESPONSES[r.category]?.msg ||
                'We only provide parenting tips.',
        };
    return { isValid: true, type: 'ok', message: 'ok' };
}

// Sanitizes LLM output before returning to client
export function sanitizeTipText(text) {
    if (!text) return text;
    let t = text.replace(URL_PATTERN, '[link removed]');
    for (const re of CONTACT_DOXXING) t = t.replace(re, '[contact removed]');
    for (const re of PROFANITY_HARASSMENT_HATE)
        t = t.replace(re, '[language removed]');
    return t;
}

export const TIPS_SYSTEM_PROMPT = `You are an expert parenting education assistant specializing in ONLY these 4 domains:

1. **Language Development** - Communication, vocabulary, storytelling, speech
2. **Early Science Skills** - Exploration, observation, curiosity about nature
3. **Literacy Foundations** - Reading, books, letters, phonics, writing
4. **Social-Emotional Learning** - Emotions, empathy, friendships, self-regulation

STRICT RULES:
- NEVER provide advice about: discipline, behavior management, sleep, eating, potty training, screen time, medical issues, or general parenting strategies
- If a query is outside these 4 domains, politely decline
- All tips must be specific, evidence-based, and actionable
- Focus on educational and developmental activities
- Never give medical, legal, or therapeutic advice

Your responses must stay strictly within the 4 domains above.`;

export function parentingSystemPrompt() {
    return [{ role: 'system', content: TIPS_SYSTEM_PROMPT }];
}

// export function validateParentingQuery(prompt) {
//     const q = normalize(prompt);

//     // 1) Hard safety blocks
//     if (
//         hasMatch(q, DANGEROUS_PATTERNS) ||
//         hasMatch(q, MEDICAL_LEGAL_PATTERNS)
//     ) {
//         return {
//             isValid: false,
//             type: 'safety',
//             message: 'We only provide parenting tips.',
//         };
//     }

//     // 2) Scope check: must look like parenting
//     if (!looksParentingRelated(q)) {
//         return {
//             isValid: false,
//             type: 'non_parenting',
//             message: 'We only provide parenting tips.',
//         };
//     }

//     // 3) OK
//     return { isValid: true, type: 'ok', message: 'ok' };
// }

// // Optional: use this when calling your LLM to enforce scope server-side as well.
// export function parentingSystemPrompt() {
//     return [
//         {
//             role: 'system',
//             content: `You are ENACT, a parenting tips assistant.
// Only answer parenting questions. If a request is outside parenting, reply exactly:
// "We only provide parenting tips"
// Do not give medical, legal, financial, adult, or illegal guidance.
// Keep answers short, age-appropriate, actionable, and supportive. Avoid diagnosing.
// When unsure if it’s parenting-related, choose the safe response above.`,
//         },
//     ];
// }

// --- Strict “Give me [CATEGORY] tips for [CHILD’S NAME] for [CONTEXT]” parsing ---

// Canonical category labels shown to users
// export const ALLOWED_CATEGORIES = [
//   'Language Dev.',
//   'Science',
//   'Math',
//   'Social-Emotional',
// ];

// // Normalization map to keep prompts tidy and predictable server-side
// const CATEGORY_NORMALIZE = {
//   'language dev.': 'Language Dev.',
//   'language dev': 'Language Dev.',
//   'language development': 'Language Dev.',
//   'science': 'Science',
//   'math': 'Math',
//   'mathematics': 'Math',
//   'social-emotional': 'Social-Emotional',
//   'social emotional': 'Social-Emotional',
//   'social-emotional learning': 'Social-Emotional',
// };

// const STRICT_PATTERN =
//   /^give me\s+(.+?)\s+tips\s+for\s+(.+?)\s+for\s+(.+?)\s*$/i;

// export function parseStrictParentingRequest(input) {
//   const m = STRICT_PATTERN.exec(input?.trim() ?? '');
//   if (!m) {
//     return {
//       ok: false,
//       error: 'format',
//       message:
//         'Use: "Give me [CATEGORY] tips for [CHILD’S NAME] for [CONTEXT/LOCATION]".',
//       examples: [
//         'Give me Language Dev. tips for Maya for bedtime',
//         'Give me Science tips for Liam for the park',
//         'Give me Math tips for Ava for grocery shopping',
//         'Give me Social-Emotional tips for Noah for preschool drop-off',
//       ],
//       allowedCategories: ALLOWED_CATEGORIES,
//     };
//   }

//   const rawCategory = m[1].toLowerCase().trim();
//   const normalizedCategory =
//     CATEGORY_NORMALIZE[rawCategory] || CATEGORY_NORMALIZE[rawCategory.replace(/\./g, '')];

//   if (!normalizedCategory || !ALLOWED_CATEGORIES.includes(normalizedCategory)) {
//     return {
//       ok: false,
//       error: 'category',
//       message: `Category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`,
//       provided: m[1],
//       allowedCategories: ALLOWED_CATEGORIES,
//     };
//   }

//   const childName = m[2].trim();
//   const context = m[3].trim();

//   if (!childName || !context) {
//     return {
//       ok: false,
//       error: 'format',
//       message:
//         'Include a child’s name and a context/location: "Give me Math tips for Ezra for the museum".',
//       allowedCategories: ALLOWED_CATEGORIES,
//     };
//   }

//   return {
//     ok: true,
//     category: normalizedCategory,
//     childName,
//     context,
//     // This is the ONLY prompt we let through to the model:
//     strictPrompt: `Give me ${normalizedCategory} tips for ${childName} for ${context}`,
//   };
// }
