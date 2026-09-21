import assert from 'node:assert/strict';
import test from 'node:test';
import { createChildPersonalizationService } from '../services/childPersonalizationService.js';

// Minimal in-memory fake standing in for the mysql2 pool. Only implements the
// exact query shapes services/childPersonalizationService.js issues — see
// that file for the real SQL. Keeps this test free of any real DB or network
// dependency, per the project's existing test conventions (plain node:test,
// no test-DB harness exists elsewhere in this repo either).
function createFakePool({ children = [], profiles = [] } = {}) {
    const state = { children: [...children], profiles: [...profiles] };
    let nextId = profiles.length + 1;

    const query = async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();

        if (s.startsWith('SELECT id, nickname, age, date_of_birth FROM children')) {
            const [id, userId] = params;
            const row = state.children.find(c => c.id === id && c.user_id === userId);
            return [row ? [row] : []];
        }
        if (s.startsWith('SELECT * FROM child_personalization_profiles')) {
            const [childId] = params;
            const row = state.profiles.find(p => p.child_id === childId);
            return [row ? [{ ...row }] : []];
        }
        if (s.startsWith('UPDATE child_personalization_profiles SET last_reviewed_at')) {
            const [childId] = params;
            const row = state.profiles.find(p => p.child_id === childId);
            if (row) row.last_reviewed_at = new Date();
            return [{ affectedRows: row ? 1 : 0 }];
        }
        throw new Error(`Unhandled query in fake pool: ${s}`);
    };

    const getConnection = async () => ({
        query: async (sql, params = []) => {
            const s = sql.replace(/\s+/g, ' ').trim();
            if (s.startsWith('INSERT INTO child_personalization_profiles')) {
                const [
                    childId, favoriteIds, skillIds, supportNeedIds,
                    customFavorites, customSkills, customSupportNeeds,
                    favoritesEmbedding, skillsEmbedding, supportNeedsEmbedding,
                ] = params;
                let row = state.profiles.find(p => p.child_id === childId);
                const now = new Date();
                if (row) {
                    Object.assign(row, {
                        favorite_ids: favoriteIds,
                        skill_ids: skillIds,
                        support_need_ids: supportNeedIds,
                        custom_favorites: customFavorites,
                        custom_skills: customSkills,
                        custom_support_needs: customSupportNeeds,
                        favorites_embedding: favoritesEmbedding,
                        skills_embedding: skillsEmbedding,
                        support_needs_embedding: supportNeedsEmbedding,
                        last_reviewed_at: now,
                        updated_at: now,
                    });
                } else {
                    row = {
                        id: nextId++,
                        child_id: childId,
                        favorite_ids: favoriteIds,
                        skill_ids: skillIds,
                        support_need_ids: supportNeedIds,
                        custom_favorites: customFavorites,
                        custom_skills: customSkills,
                        custom_support_needs: customSupportNeeds,
                        favorites_embedding: favoritesEmbedding,
                        skills_embedding: skillsEmbedding,
                        support_needs_embedding: supportNeedsEmbedding,
                        last_reviewed_at: now,
                        created_at: now,
                        updated_at: now,
                    };
                    state.profiles.push(row);
                }
                return [{ insertId: row.id }];
            }
            throw new Error(`Unhandled connection query: ${s}`);
        },
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
    });

    return { query, getConnection, _state: state };
}

const fakeEmbed = async text => [text.length % 7, text.length % 5, text.length % 3];

const CHILDREN = [
    { id: 1, user_id: 10, nickname: 'Leo', age: 3, date_of_birth: '2022-01-01' },
    { id: 2, user_id: 20, nickname: 'Maya', age: 0, date_of_birth: '2025-06-01' },
];

test('an authenticated caregiver can read and update a profile for their own child', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const saveResult = await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: {
            favorites: ['fav-dinosaurs'],
            skillsInProgress: ['skill-taking-turns'],
            supportNeeds: [],
            customFavorites: ['loves painting'],
            customSkills: [],
            customSupportNeeds: [],
        },
    });

    assert.equal(saveResult.ok, true);
    assert.deepEqual(saveResult.profile.favorites, ['fav-dinosaurs']);
    assert.deepEqual(saveResult.profile.customFavorites, ['loves painting']);
    assert.ok(saveResult.profile.lastReviewedAt);

    const getResult = await service.getProfile({ userId: 10, childId: 1 });
    assert.equal(getResult.ok, true);
    assert.deepEqual(getResult.profile.favorites, ['fav-dinosaurs']);
});

test('a caregiver cannot read another caregiver\'s child profile', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.getProfile({ userId: 999, childId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
});

test('a caregiver cannot update another caregiver\'s child profile', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.saveProfile({
        userId: 999,
        childId: 1,
        payload: { favorites: ['fav-dinosaurs'], skillsInProgress: [], supportNeeds: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
});

test('unknown children are handled securely (same 403 as unauthorized, no existence leak)', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.getProfile({ userId: 10, childId: 99999 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
});

test('GET returns a clean empty profile when none has been saved yet', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.getProfile({ userId: 10, childId: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.profile.favorites, []);
    assert.equal(result.profile.lastReviewedAt, null);
});

test('upsert does not create duplicate profile rows', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: { favorites: ['fav-dinosaurs'], skillsInProgress: [], supportNeeds: [] },
    });
    const second = await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: { favorites: ['fav-sports'], skillsInProgress: [], supportNeeds: [] },
    });

    assert.equal(pool._state.profiles.length, 1);
    assert.deepEqual(second.profile.favorites, ['fav-sports']);
});

test('confirm-current updates only the review timestamp, not saved answers', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const saved = await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: { favorites: ['fav-dinosaurs'], skillsInProgress: [], supportNeeds: [] },
    });
    const firstReviewedAt = saved.profile.lastReviewedAt;

    await new Promise(resolve => setTimeout(resolve, 5));
    const confirmed = await service.confirmCurrent({ userId: 10, childId: 1 });

    assert.equal(confirmed.ok, true);
    assert.deepEqual(confirmed.profile.favorites, ['fav-dinosaurs']);
    assert.notEqual(confirmed.profile.lastReviewedAt, firstReviewedAt);
});

test('confirm-current on a child with no saved profile yet returns 404', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.confirmCurrent({ userId: 10, childId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
});

test('rejects an unknown/age-inappropriate option id with 400', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    // "Writing their name" is a 5-year-old skill; this child is 3.
    const result = await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: { favorites: [], skillsInProgress: ['skill-writing-their-name'], supportNeeds: [] },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_option');
});

test('rejects unsafe custom text with 422 and a neutral field-level message', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: {
            favorites: [],
            skillsInProgress: [],
            supportNeeds: [],
            customFavorites: ['cocaine tips'],
        },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.field, 'customFavorites');
    assert.ok(!result.message.toLowerCase().includes('cocaine'));
});

test('"Under 1" (age 0) options work correctly end-to-end', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    const result = await service.saveProfile({
        userId: 20,
        childId: 2, // age 0
        payload: { favorites: ['fav-faces'], skillsInProgress: ['skill-tummy-time'], supportNeeds: [] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.profile.favorites, ['fav-faces']);
});

test('rejecting a custom field never persists a row containing the rejected text', async () => {
    const pool = createFakePool({ children: CHILDREN });
    const service = createChildPersonalizationService(pool, fakeEmbed);

    await service.saveProfile({
        userId: 10,
        childId: 1,
        payload: { favorites: [], skillsInProgress: [], supportNeeds: [], customFavorites: ['cocaine tips'] },
    });

    assert.equal(pool._state.profiles.length, 0);
});
