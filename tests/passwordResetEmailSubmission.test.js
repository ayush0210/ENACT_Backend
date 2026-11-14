import assert from 'node:assert/strict';
import test from 'node:test';
import {
    wasRecipientAccepted,
    buildPasswordResetEmailLog,
} from '../utils/passwordResetEmail.js';

test('wasRecipientAccepted is true when the exact recipient is in info.accepted', () => {
    const info = { accepted: ['user@example.com'], rejected: [] };
    assert.equal(wasRecipientAccepted(info, 'user@example.com'), true);
});

test('wasRecipientAccepted is false when the recipient was rejected instead', () => {
    const info = { accepted: [], rejected: ['user@example.com'] };
    assert.equal(wasRecipientAccepted(info, 'user@example.com'), false);
});

test('wasRecipientAccepted is false when accepted is missing or malformed', () => {
    assert.equal(wasRecipientAccepted({}, 'user@example.com'), false);
    assert.equal(wasRecipientAccepted(undefined, 'user@example.com'), false);
    assert.equal(
        wasRecipientAccepted({ accepted: 'user@example.com' }, 'user@example.com'),
        false,
    );
});

test('wasRecipientAccepted does not match a different address in the accepted list', () => {
    const info = { accepted: ['someone-else@example.com'], rejected: [] };
    assert.equal(wasRecipientAccepted(info, 'user@example.com'), false);
});

test('buildPasswordResetEmailLog reports counts and messageId without the recipient address', () => {
    const info = {
        messageId: '<abc123@gmail.com>',
        accepted: ['user@example.com'],
        rejected: [],
        response: '250 2.0.0 OK 1699999999 abc123 - gsmtp',
    };
    const log = buildPasswordResetEmailLog('corr-1', info, 1234);

    assert.deepEqual(log, {
        correlationId: 'corr-1',
        messageId: '<abc123@gmail.com>',
        accepted: 1,
        rejected: 0,
        durationMs: 1234,
    });

    const serialized = JSON.stringify(log);
    assert.ok(!serialized.includes('user@example.com'));
    assert.ok(!serialized.includes('250 2.0.0 OK'));
});

test('buildPasswordResetEmailLog tolerates a missing/malformed info object', () => {
    const log = buildPasswordResetEmailLog('corr-2', undefined, 5);
    assert.deepEqual(log, {
        correlationId: 'corr-2',
        messageId: undefined,
        accepted: 0,
        rejected: 0,
        durationMs: 5,
    });
});
