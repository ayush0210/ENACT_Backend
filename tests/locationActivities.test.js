import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStoredActivities } from '../utils/locationActivities.js';

test('null (historical rows with no activities) parses to []', () => {
    assert.deepEqual(parseStoredActivities(null), []);
    assert.deepEqual(parseStoredActivities(undefined), []);
});

test('already-parsed array passes through, dropping non-string entries', () => {
    assert.deepEqual(parseStoredActivities(['Bath time', 'Bed time']), [
        'Bath time',
        'Bed time',
    ]);
    assert.deepEqual(parseStoredActivities(['Bath time', 42, null]), ['Bath time']);
});

test('JSON string form is parsed', () => {
    assert.deepEqual(parseStoredActivities('["Bath time","Bed time"]'), [
        'Bath time',
        'Bed time',
    ]);
});

test('malformed JSON falls back to [] instead of throwing', () => {
    assert.deepEqual(parseStoredActivities('{not valid json'), []);
});

test('JSON string that is not an array falls back to []', () => {
    assert.deepEqual(parseStoredActivities('{"foo":"bar"}'), []);
});

test('unexpected type falls back to []', () => {
    assert.deepEqual(parseStoredActivities(42), []);
    assert.deepEqual(parseStoredActivities({ not: 'an array' }), []);
});
