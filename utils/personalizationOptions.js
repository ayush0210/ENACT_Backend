// Canonical backend registry for personalization survey options.
//
// TRUST BOUNDARY: this registry is the ONLY authority on which predefined
// option IDs exist, which category/age band they belong to, and what text
// ("promptValue") represents them to the model. The frontend
// (talk-around-town-native/src/data/personalizationOptionsByAge.ts) has its
// own copy of the same labels for rendering chips, but every ID the client
// submits is revalidated here on every write — a client can call the API
// directly and must not be able to smuggle an unknown, inactive, wrong-
// category, or age-inappropriate ID into a saved profile.
//
// The two registries are kept in sync by hand rather than shared via a
// package (separate repos/languages). tests/personalizationOptions.test.js
// pins the exact id/label/age-range set here; the frontend has an equivalent
// pinning test — see PersonalizationDataSource.test.ts's registry-drift test
// — so a change on either side that isn't mirrored on the other fails a test
// instead of silently drifting.
//
// "Under 1" is age 0, matching the existing child model (see
// routes/children.js's age validation and ChildInfoModal.tsx's AGES list).

export const PERSONALIZATION_CATEGORIES = ['favorite', 'skill', 'support'];

export const PREFER_NOT_TO_ANSWER_ID = 'support-prefer-not-to-answer';

export const PERSONALIZATION_REVIEW_INTERVAL_DAYS = 90;

/**
 * @typedef {Object} PersonalizationOption
 * @property {string} id
 * @property {'favorite'|'skill'|'support'} category
 * @property {string} label
 * @property {number} minAge
 * @property {number} maxAge
 * @property {string} promptValue
 * @property {boolean} active
 */

/** @type {PersonalizationOption[]} */
export const PERSONALIZATION_OPTIONS = [
    // ---------------- Favorites ----------------
    { id: 'fav-faces', category: 'favorite', label: 'Faces', minAge: 0, maxAge: 0, promptValue: 'looking at faces', active: true },
    { id: 'fav-music-infant', category: 'favorite', label: 'Music', minAge: 0, maxAge: 0, promptValue: 'music', active: true },
    { id: 'fav-rattles', category: 'favorite', label: 'Rattles', minAge: 0, maxAge: 0, promptValue: 'rattles', active: true },
    { id: 'fav-peekaboo', category: 'favorite', label: 'Peekaboo', minAge: 0, maxAge: 0, promptValue: 'peekaboo games', active: true },
    { id: 'fav-mirrors', category: 'favorite', label: 'Mirrors', minAge: 0, maxAge: 0, promptValue: 'mirrors', active: true },
    { id: 'fav-bath-time', category: 'favorite', label: 'Bath time', minAge: 0, maxAge: 0, promptValue: 'bath time', active: true },
    { id: 'fav-soft-toys', category: 'favorite', label: 'Soft toys', minAge: 0, maxAge: 0, promptValue: 'soft toys', active: true },
    { id: 'fav-being-held', category: 'favorite', label: 'Being held', minAge: 0, maxAge: 0, promptValue: 'being held and cuddled', active: true },

    { id: 'fav-animals', category: 'favorite', label: 'Animals', minAge: 1, maxAge: 4, promptValue: 'animals', active: true },
    { id: 'fav-songs', category: 'favorite', label: 'Songs', minAge: 1, maxAge: 3, promptValue: 'songs', active: true },
    { id: 'fav-balls', category: 'favorite', label: 'Balls', minAge: 1, maxAge: 1, promptValue: 'balls', active: true },
    { id: 'fav-bubbles', category: 'favorite', label: 'Bubbles', minAge: 1, maxAge: 1, promptValue: 'bubbles', active: true },
    { id: 'fav-blocks', category: 'favorite', label: 'Blocks', minAge: 1, maxAge: 1, promptValue: 'blocks', active: true },
    { id: 'fav-water-play', category: 'favorite', label: 'Water play', minAge: 1, maxAge: 2, promptValue: 'water play', active: true },
    { id: 'fav-dancing', category: 'favorite', label: 'Dancing', minAge: 1, maxAge: 1, promptValue: 'dancing', active: true },
    { id: 'fav-picture-books', category: 'favorite', label: 'Picture books', minAge: 1, maxAge: 1, promptValue: 'picture books', active: true },

    { id: 'fav-cars-trucks', category: 'favorite', label: 'Cars & trucks', minAge: 2, maxAge: 2, promptValue: 'cars and trucks', active: true },
    { id: 'fav-building-blocks', category: 'favorite', label: 'Building blocks', minAge: 2, maxAge: 2, promptValue: 'building blocks', active: true },
    { id: 'fav-pretend-play', category: 'favorite', label: 'Pretend play', minAge: 2, maxAge: 4, promptValue: 'pretend play', active: true },
    { id: 'fav-playground', category: 'favorite', label: 'Playground', minAge: 2, maxAge: 2, promptValue: 'the playground', active: true },
    { id: 'fav-art', category: 'favorite', label: 'Art', minAge: 2, maxAge: 5, promptValue: 'art and drawing', active: true },

    { id: 'fav-dinosaurs', category: 'favorite', label: 'Dinosaurs', minAge: 3, maxAge: 5, promptValue: 'dinosaurs', active: true },
    { id: 'fav-sports', category: 'favorite', label: 'Sports', minAge: 3, maxAge: 5, promptValue: 'sports', active: true },
    { id: 'fav-building', category: 'favorite', label: 'Building', minAge: 3, maxAge: 5, promptValue: 'building and construction', active: true },
    { id: 'fav-storybooks', category: 'favorite', label: 'Storybooks', minAge: 3, maxAge: 3, promptValue: 'storybooks', active: true },

    { id: 'fav-music', category: 'favorite', label: 'Music', minAge: 4, maxAge: 5, promptValue: 'music', active: true },
    { id: 'fav-space', category: 'favorite', label: 'Space', minAge: 4, maxAge: 5, promptValue: 'outer space', active: true },
    { id: 'fav-nature', category: 'favorite', label: 'Nature', minAge: 5, maxAge: 5, promptValue: 'nature', active: true },
    { id: 'fav-books-stories', category: 'favorite', label: 'Books & stories', minAge: 5, maxAge: 5, promptValue: 'books and stories', active: true },

    // ---------------- Skills in progress ----------------
    { id: 'skill-tummy-time', category: 'skill', label: 'Tummy time', minAge: 0, maxAge: 0, promptValue: 'tummy time', active: true },
    { id: 'skill-reaching-grasping', category: 'skill', label: 'Reaching and grasping', minAge: 0, maxAge: 0, promptValue: 'reaching and grasping objects', active: true },
    { id: 'skill-sitting-with-support', category: 'skill', label: 'Sitting with support', minAge: 0, maxAge: 0, promptValue: 'sitting with support', active: true },
    { id: 'skill-responding-to-sounds', category: 'skill', label: 'Responding to sounds', minAge: 0, maxAge: 0, promptValue: 'responding to sounds', active: true },
    { id: 'skill-babbling', category: 'skill', label: 'Babbling', minAge: 0, maxAge: 0, promptValue: 'babbling', active: true },
    { id: 'skill-tracking-objects', category: 'skill', label: 'Tracking objects', minAge: 0, maxAge: 0, promptValue: 'tracking moving objects with their eyes', active: true },
    { id: 'skill-exploring-textures', category: 'skill', label: 'Exploring textures', minAge: 0, maxAge: 0, promptValue: 'exploring different textures', active: true },

    { id: 'skill-first-words', category: 'skill', label: 'First words', minAge: 1, maxAge: 1, promptValue: 'saying first words', active: true },
    { id: 'skill-walking', category: 'skill', label: 'Walking', minAge: 1, maxAge: 1, promptValue: 'walking', active: true },
    { id: 'skill-pointing', category: 'skill', label: 'Pointing', minAge: 1, maxAge: 1, promptValue: 'pointing to communicate', active: true },
    { id: 'skill-using-a-spoon', category: 'skill', label: 'Using a spoon', minAge: 1, maxAge: 1, promptValue: 'using a spoon', active: true },
    { id: 'skill-following-simple-directions', category: 'skill', label: 'Following simple directions', minAge: 1, maxAge: 1, promptValue: 'following simple one-step directions', active: true },
    { id: 'skill-stacking-blocks', category: 'skill', label: 'Stacking blocks', minAge: 1, maxAge: 1, promptValue: 'stacking blocks', active: true },
    { id: 'skill-taking-turns-early', category: 'skill', label: 'Taking turns', minAge: 1, maxAge: 1, promptValue: 'taking turns', active: true },

    { id: 'skill-combining-words', category: 'skill', label: 'Combining words', minAge: 2, maxAge: 2, promptValue: 'combining words into short phrases', active: true },
    { id: 'skill-naming-objects', category: 'skill', label: 'Naming objects', minAge: 2, maxAge: 2, promptValue: 'naming everyday objects', active: true },
    { id: 'skill-running-climbing', category: 'skill', label: 'Running and climbing', minAge: 2, maxAge: 2, promptValue: 'running and climbing', active: true },
    { id: 'skill-using-utensils', category: 'skill', label: 'Using utensils', minAge: 2, maxAge: 2, promptValue: 'using utensils', active: true },
    { id: 'skill-simple-pretend-play', category: 'skill', label: 'Simple pretend play', minAge: 2, maxAge: 2, promptValue: 'simple pretend play', active: true },
    { id: 'skill-sharing-toys', category: 'skill', label: 'Sharing toys', minAge: 2, maxAge: 2, promptValue: 'sharing toys', active: true },
    { id: 'skill-following-routines', category: 'skill', label: 'Following routines', minAge: 2, maxAge: 2, promptValue: 'following daily routines', active: true },

    { id: 'skill-speaking-in-sentences', category: 'skill', label: 'Speaking in sentences', minAge: 3, maxAge: 3, promptValue: 'speaking in full sentences', active: true },
    { id: 'skill-taking-turns', category: 'skill', label: 'Taking turns', minAge: 3, maxAge: 3, promptValue: 'taking turns', active: true },
    { id: 'skill-dressing-with-help', category: 'skill', label: 'Dressing with help', minAge: 3, maxAge: 3, promptValue: 'dressing with help', active: true },
    { id: 'skill-counting-small-groups', category: 'skill', label: 'Counting small groups', minAge: 3, maxAge: 3, promptValue: 'counting small groups of objects', active: true },
    { id: 'skill-recognizing-emotions', category: 'skill', label: 'Recognizing emotions', minAge: 3, maxAge: 3, promptValue: 'recognizing emotions', active: true },
    { id: 'skill-using-the-toilet', category: 'skill', label: 'Using the toilet', minAge: 3, maxAge: 3, promptValue: 'using the toilet independently', active: true },
    { id: 'skill-following-two-step-directions', category: 'skill', label: 'Following two-step directions', minAge: 3, maxAge: 3, promptValue: 'following two-step directions', active: true },

    { id: 'skill-telling-stories', category: 'skill', label: 'Telling stories', minAge: 4, maxAge: 4, promptValue: 'telling stories', active: true },
    { id: 'skill-recognizing-letters', category: 'skill', label: 'Recognizing letters', minAge: 4, maxAge: 4, promptValue: 'recognizing letters', active: true },
    { id: 'skill-counting', category: 'skill', label: 'Counting', minAge: 4, maxAge: 4, promptValue: 'counting', active: true },
    { id: 'skill-cooperative-play', category: 'skill', label: 'Cooperative play', minAge: 4, maxAge: 4, promptValue: 'cooperative play with peers', active: true },
    { id: 'skill-managing-emotions', category: 'skill', label: 'Managing emotions', minAge: 4, maxAge: 4, promptValue: 'managing big emotions', active: true },
    { id: 'skill-dressing-independently', category: 'skill', label: 'Dressing independently', minAge: 4, maxAge: 4, promptValue: 'dressing independently', active: true },
    { id: 'skill-using-scissors', category: 'skill', label: 'Using scissors', minAge: 4, maxAge: 4, promptValue: 'using scissors safely', active: true },

    { id: 'skill-letter-sounds', category: 'skill', label: 'Letter sounds', minAge: 5, maxAge: 5, promptValue: 'letter sounds', active: true },
    { id: 'skill-writing-their-name', category: 'skill', label: 'Writing their name', minAge: 5, maxAge: 5, promptValue: 'writing their name', active: true },
    { id: 'skill-simple-addition', category: 'skill', label: 'Simple addition', minAge: 5, maxAge: 5, promptValue: 'simple addition', active: true },
    { id: 'skill-following-multi-step-directions', category: 'skill', label: 'Following multi-step directions', minAge: 5, maxAge: 5, promptValue: 'following multi-step directions', active: true },
    { id: 'skill-problem-solving', category: 'skill', label: 'Problem-solving', minAge: 5, maxAge: 5, promptValue: 'problem-solving', active: true },
    { id: 'skill-preparing-for-school-routines', category: 'skill', label: 'Preparing for school routines', minAge: 5, maxAge: 5, promptValue: 'preparing for school routines', active: true },
    { id: 'skill-resolving-peer-conflicts', category: 'skill', label: 'Resolving peer conflicts', minAge: 5, maxAge: 5, promptValue: 'resolving peer conflicts', active: true },

    // ---------------- Support needs (not age-scoped) ----------------
    { id: 'support-aac-device', category: 'support', label: 'Uses an AAC device', minAge: 0, maxAge: 5, promptValue: 'uses an AAC (augmentative and alternative communication) device', active: true },
    { id: 'support-speech-language', category: 'support', label: 'Speech or language support', minAge: 0, maxAge: 5, promptValue: 'receiving speech or language support', active: true },
    { id: 'support-hearing-impairment', category: 'support', label: 'Hearing impairment', minAge: 0, maxAge: 5, promptValue: 'a hearing impairment', active: true },
    { id: 'support-visual-impairment', category: 'support', label: 'Visual impairment', minAge: 0, maxAge: 5, promptValue: 'a visual impairment', active: true },
    { id: 'support-physical-motor-impairment', category: 'support', label: 'Physical or motor impairment', minAge: 0, maxAge: 5, promptValue: 'a physical or motor impairment', active: true },
    { id: 'support-sensory-needs', category: 'support', label: 'Sensory support needs', minAge: 0, maxAge: 5, promptValue: 'sensory support needs', active: true },
    { id: 'support-cognitive-learning-delay', category: 'support', label: 'Cognitive or learning delay', minAge: 0, maxAge: 5, promptValue: 'a cognitive or learning delay', active: true },
    { id: 'support-autism-related', category: 'support', label: 'Autism-related support', minAge: 0, maxAge: 5, promptValue: 'autism-related support needs', active: true },
    { id: 'support-other', category: 'support', label: 'Other support need', minAge: 0, maxAge: 5, promptValue: 'another support need', active: true },
    { id: PREFER_NOT_TO_ANSWER_ID, category: 'support', label: 'Prefer not to answer', minAge: 0, maxAge: 5, promptValue: '', active: true },
];

const OPTIONS_BY_ID = new Map(PERSONALIZATION_OPTIONS.map(o => [o.id, o]));

export function getOptionById(id) {
    return OPTIONS_BY_ID.get(id) || null;
}

export function isSupportedChildAge(age) {
    return Number.isInteger(age) && age >= 0 && age <= 5;
}

/**
 * Validates a list of submitted option IDs for one category against the
 * canonical registry and the child's current age. Never trusts the client's
 * own notion of category/age/label — only the ID is taken from the client;
 * everything else is looked up here.
 *
 * Duplicate IDs are normalized (de-duplicated), not rejected — a client
 * re-submitting the same selection twice is not a security or data concern.
 *
 * @param {string[]} ids
 * @param {'favorite'|'skill'|'support'} category
 * @param {number} childAge
 * @returns {{ validIds: string[], errors: Array<{ id: string, reason: string }> }}
 */
export function validateOptionIdsForCategory(ids, category, childAge) {
    const validIds = [];
    const errors = [];
    const seen = new Set();

    for (const rawId of Array.isArray(ids) ? ids : []) {
        const id = String(rawId ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const option = getOptionById(id);
        if (!option) {
            errors.push({ id, reason: 'unknown_option' });
            continue;
        }
        if (!option.active) {
            errors.push({ id, reason: 'inactive_option' });
            continue;
        }
        if (option.category !== category) {
            errors.push({ id, reason: 'wrong_category' });
            continue;
        }
        if (isSupportedChildAge(childAge) && (childAge < option.minAge || childAge > option.maxAge)) {
            errors.push({ id, reason: 'age_inappropriate' });
            continue;
        }
        validIds.push(id);
    }

    return { validIds, errors };
}

export function optionsToPromptValues(ids) {
    return (Array.isArray(ids) ? ids : [])
        .map(id => getOptionById(id)?.promptValue)
        .filter(Boolean);
}

export function optionsToLabels(ids) {
    return (Array.isArray(ids) ? ids : [])
        .map(id => getOptionById(id)?.label)
        .filter(Boolean);
}
