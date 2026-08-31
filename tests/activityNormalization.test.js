import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveActivity, resolveActivities } from '../utils/activityNormalization.js';

const APPROVED = ['Bath time', 'Bed time', 'Meal time', 'Reading together'];

test('resolves exact matches', () => {
    assert.equal(resolveActivity('Bed time', APPROVED), 'Bed time');
});

test('resolves "bedtime" and "bed time" to the same canonical label', () => {
    assert.equal(resolveActivity('bedtime', APPROVED), 'Bed time');
    assert.equal(resolveActivity('bed time', APPROVED), 'Bed time');
});

test('resolves "bathtime" and "bath time" to the same canonical label', () => {
    assert.equal(resolveActivity('bathtime', APPROVED), 'Bath time');
    assert.equal(resolveActivity('bath time', APPROVED), 'Bath time');
});

test('is case-insensitive', () => {
    assert.equal(resolveActivity('BED TIME', APPROVED), 'Bed time');
    assert.equal(resolveActivity('bEd TiME', APPROVED), 'Bed time');
});

test('ignores hyphen differences', () => {
    assert.equal(resolveActivity('Bed-Time', APPROVED), 'Bed time');
    assert.equal(resolveActivity('bed-time', APPROVED), 'Bed time');
});

test('trims leading/trailing whitespace and collapses repeats', () => {
    assert.equal(resolveActivity('  Bed   time  ', APPROVED), 'Bed time');
    assert.equal(resolveActivity('\tbed time\n', APPROVED), 'Bed time');
});

test('rejects activities that cannot be resolved', () => {
    assert.equal(resolveActivity('skydiving', APPROVED), null);
    assert.equal(resolveActivity('', APPROVED), null);
    assert.equal(resolveActivity(undefined, APPROVED), null);
    assert.equal(resolveActivity(null, APPROVED), null);
});

test('never invents a canonical label not present in the approved list', () => {
    // "Nap time" is a plausible-looking activity but not in APPROVED here.
    assert.equal(resolveActivity('nap time', APPROVED), null);
});

test('resolveActivities: duplicate aliases collapse to one canonical value', () => {
    const { resolved, unresolved } = resolveActivities(
        ['bedtime', 'bed time', 'Bed-Time', 'BED TIME'],
        APPROVED,
    );
    assert.deepEqual(resolved, ['Bed time']);
    assert.deepEqual(unresolved, []);
});

test('resolveActivities: mixed valid and invalid activities', () => {
    const { resolved, unresolved } = resolveActivities(
        ['bath time', 'skydiving', 'Meal Time'],
        APPROVED,
    );
    assert.deepEqual(resolved, ['Bath time', 'Meal time']);
    assert.deepEqual(unresolved, ['skydiving']);
});

test('resolveActivities: non-string entries are reported as unresolved', () => {
    const { resolved, unresolved } = resolveActivities([42, null, 'Bed time'], APPROVED);
    assert.deepEqual(resolved, ['Bed time']);
    assert.deepEqual(unresolved, [42, null]);
});

test('resolveActivities: empty input resolves to nothing (activities are optional)', () => {
    const { resolved, unresolved } = resolveActivities([], APPROVED);
    assert.deepEqual(resolved, []);
    assert.deepEqual(unresolved, []);
});
