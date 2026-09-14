import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocationTipPrompt } from '../utils/locationNotificationPayload.js';

test('builds the standard location prompt with child context', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'language development and literacy',
        locationName: 'Library',
        childContext: 'Mia: 3 years old',
    });
    assert.equal(
        prompt,
        'language development and literacy activities at Library for children (Mia: 3 years old)',
    );
});

test('builds the prompt without child context', () => {
    const prompt = buildLocationTipPrompt({
        domainDesc: 'language development and literacy',
        locationName: 'Library',
    });
    assert.equal(prompt, 'language development and literacy activities at Library');
});
