import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PERSONALIZATION_OPTIONS,
    getOptionById,
    validateOptionIdsForCategory,
    optionsToPromptValues,
    optionsToLabels,
    PREFER_NOT_TO_ANSWER_ID,
} from '../utils/personalizationOptions.js';

test('registry pin: every option has the required shape', () => {
    for (const opt of PERSONALIZATION_OPTIONS) {
        assert.equal(typeof opt.id, 'string');
        assert.ok(['favorite', 'skill', 'support'].includes(opt.category));
        assert.equal(typeof opt.label, 'string');
        assert.ok(Number.isInteger(opt.minAge));
        assert.ok(Number.isInteger(opt.maxAge));
        assert.ok(opt.minAge >= 0 && opt.minAge <= 5);
        assert.ok(opt.maxAge >= opt.minAge && opt.maxAge <= 5);
        assert.equal(typeof opt.active, 'boolean');
    }
});

test('registry pin: no duplicate IDs', () => {
    const ids = PERSONALIZATION_OPTIONS.map(o => o.id);
    assert.equal(new Set(ids).size, ids.length);
});

test('"Under 1" (age 0) has infant-appropriate favorites and skills', () => {
    const age0Favorites = PERSONALIZATION_OPTIONS.filter(
        o => o.category === 'favorite' && o.minAge <= 0 && o.maxAge >= 0,
    );
    assert.ok(age0Favorites.some(o => o.label === 'Peekaboo'));
    assert.ok(!age0Favorites.some(o => o.label === 'Dinosaurs'));

    const age0Skills = PERSONALIZATION_OPTIONS.filter(
        o => o.category === 'skill' && o.minAge <= 0 && o.maxAge >= 0,
    );
    assert.ok(age0Skills.some(o => o.label === 'Tummy time'));
});

test('getOptionById returns null for unknown ids', () => {
    assert.equal(getOptionById('not-a-real-id'), null);
});

test('validateOptionIdsForCategory accepts a valid, age-appropriate id', () => {
    const { validIds, errors } = validateOptionIdsForCategory(['fav-dinosaurs'], 'favorite', 4);
    assert.deepEqual(validIds, ['fav-dinosaurs']);
    assert.deepEqual(errors, []);
});

test('validateOptionIdsForCategory rejects an unknown id', () => {
    const { validIds, errors } = validateOptionIdsForCategory(['not-a-real-id'], 'favorite', 3);
    assert.deepEqual(validIds, []);
    assert.equal(errors[0].reason, 'unknown_option');
});

test('validateOptionIdsForCategory rejects an id from the wrong category', () => {
    // skill-walking is a 'skill' option, submitted under 'favorite'
    const { validIds, errors } = validateOptionIdsForCategory(['skill-walking'], 'favorite', 1);
    assert.deepEqual(validIds, []);
    assert.equal(errors[0].reason, 'wrong_category');
});

test('validateOptionIdsForCategory rejects an age-inappropriate skill', () => {
    // "Writing their name" is a 5-year-old skill; submitted for a 1-year-old.
    const { validIds, errors } = validateOptionIdsForCategory(
        ['skill-writing-their-name'],
        'skill',
        1,
    );
    assert.deepEqual(validIds, []);
    assert.equal(errors[0].reason, 'age_inappropriate');
});

test('validateOptionIdsForCategory normalizes duplicate ids instead of erroring', () => {
    const { validIds, errors } = validateOptionIdsForCategory(
        ['fav-dinosaurs', 'fav-dinosaurs', 'fav-dinosaurs'],
        'favorite',
        4,
    );
    assert.deepEqual(validIds, ['fav-dinosaurs']);
    assert.deepEqual(errors, []);
});

test('"Prefer not to answer" is a valid support option for every age', () => {
    const option = getOptionById(PREFER_NOT_TO_ANSWER_ID);
    assert.ok(option);
    assert.equal(option.category, 'support');
    for (let age = 0; age <= 5; age++) {
        const { validIds } = validateOptionIdsForCategory([PREFER_NOT_TO_ANSWER_ID], 'support', age);
        assert.deepEqual(validIds, [PREFER_NOT_TO_ANSWER_ID]);
    }
});

test('optionsToPromptValues/optionsToLabels skip unknown ids safely', () => {
    assert.deepEqual(optionsToPromptValues(['fav-dinosaurs', 'bogus']), ['dinosaurs']);
    assert.deepEqual(optionsToLabels(['fav-dinosaurs', 'bogus']), ['Dinosaurs']);
});
