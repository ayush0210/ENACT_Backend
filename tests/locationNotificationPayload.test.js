import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildLocationTipPrompt,
    buildLocationNotificationPayload,
    notificationDataForPush,
} from '../utils/locationNotificationPayload.js';

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

// --- Tip shape must match the companion chat's tip shape (title/body/details/
// audioUrl/categories/isGenerated) so a tip looks identical whether it arrived
// via a location notification or via the in-app "Ask your Companion" chat. ---

test('geofence-notification tips match the companion chat tip shape exactly', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [
            {
                id: 'generated_1',
                title: 'Narrate the walk',
                body: 'Describe what you see out loud.',
                details: 'Say: "I see a red door."',
                categories: ['Language Development'],
                isGenerated: true,
            },
        ],
        notificationId: 'notif-1',
    });

    assert.equal(payload.tips.length, 1);
    assert.deepEqual(Object.keys(payload.tips[0]).sort(), [
        'audioUrl',
        'body',
        'categories',
        'details',
        'id',
        'isGenerated',
        'title',
    ]);
    assert.equal(payload.tips[0].audioUrl, null);
    assert.equal(payload.tips[0].title, 'Narrate the walk');
    assert.equal(payload.tips[0].body, 'Describe what you see out loud.');
    assert.equal(payload.tips[0].details, 'Say: "I see a red door."');
    assert.deepEqual(payload.tips[0].categories, ['Language Development']);
    assert.equal(payload.tips[0].isGenerated, true);
});

test('geofence-notification tips no longer carry description/activity/reason', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [
            {
                id: 'generated_1',
                title: 'Narrate the walk',
                body: 'Describe what you see out loud.',
                details: 'Say something.',
                activity: 'Library',
                reason: 'Personalized for your request.',
                categories: ['Language Development'],
                isGenerated: true,
            },
        ],
        notificationId: 'notif-1',
    });

    assert.ok(!('description' in payload.tips[0]));
    assert.ok(!('activity' in payload.tips[0]));
    assert.ok(!('reason' in payload.tips[0]));
});

test('a tip missing "body" falls back to its DB "description" column', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [{id: 1, title: 'Read together', description: 'Read a book aloud.'}],
        notificationId: 'notif-1',
    });

    assert.equal(payload.tips[0].body, 'Read a book aloud.');
});

test('a tip with no categories array defaults to an empty array, not undefined', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [{id: 1, title: 'Read together', body: 'Read a book aloud.'}],
        notificationId: 'notif-1',
    });

    assert.deepEqual(payload.tips[0].categories, []);
});

test('isGenerated always coerces to a boolean', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [{id: 1, title: 'A', body: 'a'}, {id: 2, title: 'B', body: 'b', isGenerated: 1}],
        notificationId: 'notif-1',
    });

    assert.equal(payload.tips[0].isGenerated, false);
    assert.equal(payload.tips[1].isGenerated, true);
});

test('only the first 3 tips are kept in the notification payload', () => {
    const tips = [1, 2, 3, 4, 5].map(n => ({id: n, title: `Tip ${n}`, body: `Body ${n}`}));
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips,
        notificationId: 'notif-1',
    });

    assert.equal(payload.tips.length, 3);
    assert.deepEqual(payload.tips.map(t => t.id), [1, 2, 3]);
});

test('the notification title/body and metadata are built from the tips and location', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [
            {id: 1, title: 'Narrate the walk', body: 'Describe what you see.', isGenerated: true},
        ],
        notificationId: 'notif-1',
    });

    assert.equal(payload.title, "You've arrived at Library");
    assert.equal(payload.body, 'Tips for Library:\n1. Narrate the walk: Describe what you see.');
    assert.equal(payload.notificationType, 'location_parenting_tips');
    assert.equal(payload.locationId, '7');
    assert.equal(payload.locationName, 'Library');
    assert.equal(payload.locationType, 'Library');
    assert.deepEqual(payload.generatedTipMetadata, {count: 1, hasGeneratedTips: true});
    assert.equal(payload.notificationId, 'notif-1');
});

test('falls back to a generic body when there are no tips', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [],
        notificationId: 'notif-1',
    });

    assert.equal(payload.body, 'Tips for Library at Library');
});

// --- notificationDataForPush: the FCM `data` payload built from the same
// buildLocationNotificationPayload() output, for the legacy /endpoint path. ---

test('notificationDataForPush stringifies tips and metadata for FCM transport', () => {
    const payload = buildLocationNotificationPayload({
        location: {id: 7, name: 'Library', type: 'Library'},
        tips: [{id: 1, title: 'Narrate the walk', body: 'Describe what you see.', isGenerated: true}],
        notificationId: 'notif-1',
    });

    const data = notificationDataForPush(payload);

    assert.equal(data.notificationType, 'location_parenting_tips');
    assert.equal(data.notificationId, 'notif-1');
    assert.equal(data.locationId, '7');
    assert.equal(data.locationName, 'Library');
    assert.equal(typeof data.tips, 'string');
    assert.deepEqual(JSON.parse(data.tips), payload.tips);
    assert.deepEqual(JSON.parse(data.generatedTipMetadata), payload.generatedTipMetadata);
});
