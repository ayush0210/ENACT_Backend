// Pure scoring math for blending the child personalization survey into the
// existing hybrid tip-ranking formula. Deliberately has ZERO imports of
// config/db.js, openai, or anything else with I/O/side effects, so it (and
// its tests) can never touch a live database or network — see
// tests/personalizationScoring.test.js.
//
// services/personalizationService.js imports these and uses them inside the
// live scoring formula:
//   finalScore = LAMBDA_QUERY * query_similarity
//              + LAMBDA_PERSONAL * personalization_similarity   <- blendPersonalization() feeds this
//              - LAMBDA_DISLIKE * dislike_penalty
//
// See docs/child-personalization.md ("Ranking weights") for the full
// rationale and where to adjust these safely.

/**
 * How the child personalization survey blends into the existing
 * like/dislike interaction-embedding signal. When only one signal exists
 * (no survey saved yet, or no interaction history yet), blendPersonalization
 * uses that signal alone rather than diluting it with a neutral 0.5 —
 * missing survey answers must not reduce the quality of generic tips.
 */
export const PERSONALIZATION_BLEND = {
    INTERACTION_WEIGHT: Number(process.env.PERSONALIZATION_INTERACTION_WEIGHT || 0.5),
    SURVEY_WEIGHT: Number(process.env.PERSONALIZATION_SURVEY_WEIGHT || 0.5),
};

/**
 * Within the survey signal itself: skills-in-progress and support needs are
 * high-value retrieval/adaptation signals. Favorites are intentionally
 * capped lower — a favorite should usually flavor an example/theme, not
 * redefine the learning objective.
 */
export const SURVEY_PERSONALIZATION_WEIGHTS = {
    SKILLS: Number(process.env.SURVEY_WEIGHT_SKILLS || 0.4),
    SUPPORT_NEEDS: Number(process.env.SURVEY_WEIGHT_SUPPORT || 0.4),
    FAVORITES: Number(process.env.SURVEY_WEIGHT_FAVORITES || 0.2),
};

/**
 * @param {number|null} interactionPersonal - cosine(user preference embedding, tip), or null if the account has none yet.
 * @param {number|null} surveyPersonalization - blended survey similarity for the current child, or null if no profile/embeddings exist.
 * @returns {number} 0.5 (today's existing default) only when NEITHER signal exists.
 */
export function blendPersonalization(interactionPersonal, surveyPersonalization) {
    const hasInteraction = typeof interactionPersonal === 'number' && !Number.isNaN(interactionPersonal);
    const hasSurvey = typeof surveyPersonalization === 'number' && !Number.isNaN(surveyPersonalization);

    if (hasInteraction && hasSurvey) {
        return (
            PERSONALIZATION_BLEND.INTERACTION_WEIGHT * interactionPersonal +
            PERSONALIZATION_BLEND.SURVEY_WEIGHT * surveyPersonalization
        );
    }
    if (hasSurvey) return surveyPersonalization;
    if (hasInteraction) return interactionPersonal;
    return 0.5;
}

/**
 * Combines the three per-category survey similarities into one
 * survey_personalization score, re-normalizing over whichever categories
 * actually have an embedding (a profile with only "skills" saved isn't
 * diluted by treating missing favorites/support as zero similarity).
 *
 * @param {{ skillsSim: number|null, supportNeedsSim: number|null, favoritesSim: number|null }} sims
 * @returns {number|null} null if no category had an embedding to compare.
 */
export function computeSurveyPersonalizationScore(sims) {
    const parts = [
        [SURVEY_PERSONALIZATION_WEIGHTS.SKILLS, sims.skillsSim],
        [SURVEY_PERSONALIZATION_WEIGHTS.SUPPORT_NEEDS, sims.supportNeedsSim],
        [SURVEY_PERSONALIZATION_WEIGHTS.FAVORITES, sims.favoritesSim],
    ].filter(([, sim]) => typeof sim === 'number' && !Number.isNaN(sim));

    if (parts.length === 0) return null;

    const totalWeight = parts.reduce((sum, [w]) => sum + w, 0);
    const weightedSum = parts.reduce((sum, [w, sim]) => sum + w * sim, 0);
    return weightedSum / totalWeight;
}
