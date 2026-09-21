// Scenario 20: a legacy child_personalization_profiles row containing text
// that was approved under an earlier/looser ruleset (or that a rule change
// now catches) must not enter retrieval, ranking, or prompt generation.
//
// services/personalizationService.js#getChildPersonalizationContext calls
// filterApprovedCustomText on every READ (not just at save time) for exactly
// this reason. This file tests that pure function directly — see the
// comment in services/childPersonalizationService.js and
// tests/childPersonalizationService.test.js for why personalizationService.js
// itself (real pool/OpenAI imports) is never imported from tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { filterApprovedCustomText } from '../utils/personalizationSafety.js';

test('drops legacy unsafe custom text even though it was presumably approved once', () => {
    const legacyStored = ['When he gets beaten', 'loves painting', 'Fighting'];
    const result = filterApprovedCustomText(legacyStored, 'favorite', 4);
    assert.deepEqual(result, ['loves painting']);
});

test('keeps all values when none are unsafe', () => {
    const result = filterApprovedCustomText(['loves painting', 'toy trains'], 'favorite', 4);
    assert.deepEqual(result, ['loves painting', 'toy trains']);
});

test('drops an ableist slur stored under support needs', () => {
    const result = filterApprovedCustomText(['uses hearing aids', 'retard'], 'support', 4);
    assert.deepEqual(result, ['uses hearing aids']);
});

test('returns an empty array for a fully-unsafe legacy record (never partially-unsafe leakage)', () => {
    const result = filterApprovedCustomText(['Fighting', 'When he gets beaten'], 'skill', 4);
    assert.deepEqual(result, []);
});

test('non-array input degrades to an empty array rather than throwing', () => {
    assert.deepEqual(filterApprovedCustomText(null, 'favorite', 4), []);
    assert.deepEqual(filterApprovedCustomText(undefined, 'favorite', 4), []);
});

test('empty array in, empty array out', () => {
    assert.deepEqual(filterApprovedCustomText([], 'favorite', 4), []);
});
