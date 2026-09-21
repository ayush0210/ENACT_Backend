import assert from 'node:assert/strict';
import test from 'node:test';
import {
    blendPersonalization,
    computeSurveyPersonalizationScore,
} from '../utils/personalizationScoring.js';

test('blendPersonalization falls back to the existing neutral default when neither signal exists', () => {
    assert.equal(blendPersonalization(null, null), 0.5);
});

test('blendPersonalization uses the survey signal alone when there is no interaction history', () => {
    // Missing interaction history must not reduce/dilute a real survey signal.
    assert.equal(blendPersonalization(null, 0.8), 0.8);
});

test('blendPersonalization uses the interaction signal alone when there is no survey profile', () => {
    // Missing survey answers must not reduce generic-tip quality.
    assert.equal(blendPersonalization(0.7, null), 0.7);
});

test('blendPersonalization averages both signals equally by default', () => {
    const result = blendPersonalization(0.6, 0.8);
    assert.ok(Math.abs(result - 0.7) < 1e-9);
});

test('computeSurveyPersonalizationScore returns null when no category has an embedding', () => {
    assert.equal(
        computeSurveyPersonalizationScore({ skillsSim: null, supportNeedsSim: null, favoritesSim: null }),
        null,
    );
});

test('computeSurveyPersonalizationScore re-normalizes when only some categories exist (missing categories are not penalized as zero)', () => {
    // Only favorites saved: score should equal the favorites similarity
    // itself, not that similarity diluted by two phantom zeros.
    const score = computeSurveyPersonalizationScore({
        skillsSim: null,
        supportNeedsSim: null,
        favoritesSim: 0.9,
    });
    assert.ok(Math.abs(score - 0.9) < 1e-9);
});

test('computeSurveyPersonalizationScore weights skills and support needs above favorites', () => {
    // Skills=1.0, favorites=0.0 — with skills weighted higher (0.4 vs 0.2 of
    // a 0.6 total-weight split), the result should sit above the midpoint.
    const score = computeSurveyPersonalizationScore({
        skillsSim: 1.0,
        supportNeedsSim: null,
        favoritesSim: 0.0,
    });
    assert.ok(score > 0.5, `expected skills-weighted score above 0.5, got ${score}`);
});

test('computeSurveyPersonalizationScore combines all three categories using the documented weights', () => {
    const score = computeSurveyPersonalizationScore({
        skillsSim: 1.0,
        supportNeedsSim: 1.0,
        favoritesSim: 0.0,
    });
    // (0.4*1 + 0.4*1 + 0.2*0) / 1.0 = 0.8
    assert.ok(Math.abs(score - 0.8) < 1e-9);
});
