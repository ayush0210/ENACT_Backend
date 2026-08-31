import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocationTipPrompt } from '../utils/locationNotificationPayload.js';

test('no activities: prompt is identical to the pre-activities format', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'language development and literacy',
        locationName: 'Library',
        activities: [],
        childContext: 'Mia: 3 years old',
    });
    assert.equal(
        prompt,
        'language development and literacy activities at Library for children (Mia: 3 years old)',
    );
});

test('no activities, no child context: matches the pre-activities format', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'language development and literacy',
        locationName: 'Library',
        activities: [],
    });
    assert.equal(prompt, 'language development and literacy activities at Library');
});

test('with activities: activities are appended in a clearly delimited clause', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'language development and literacy',
        locationName: 'Library',
        activities: ['Reading together', 'Playing (general)'],
        childContext: 'Mia: 3 years old',
    });
    assert.match(prompt, /Reading together, Playing \(general\)/);
    assert.match(prompt, /^language development and literacy activities at Library/);
    assert.match(prompt, /for children \(Mia: 3 years old\)$/);
});

test('activities defaults to [] when omitted', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'science',
        locationName: 'Park',
    });
    assert.equal(prompt, 'science activities at Park');
});
