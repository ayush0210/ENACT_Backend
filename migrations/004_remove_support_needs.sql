-- IRB compliance: removes the "Support needs" personalization question and
-- its data. Support needs (developmental delays/disabilities/AAC device/
-- hearing or visual impairment/etc.) is classified as medical information
-- this study is not approved to collect.
--
-- *** DO NOT RUN THIS AUTOMATICALLY. ***
-- This file is a proposal for human review. It is destructive (Step 2 drops
-- columns, which is irreversible without a backup) and must be run only
-- after you have:
--   1. Confirmed the application code deploy that stops collecting/reading
--      this field (services/childPersonalizationService.js,
--      routes/childPersonalization.js, services/personalizationService.js,
--      utils/personalizationOptions.js/personalizationScoring.js) is live,
--      so no in-flight request can re-populate these columns after cleanup.
--   2. Taken a full database backup.
--   3. Reviewed Step 1's SELECT COUNT output below to know how much
--      historical data exists before deciding when/whether to run Step 2.
--
-- Safe to run any time after that code is deployed: the application no
-- longer writes real content to these columns (it always writes '[]'/null
-- regardless of what a client submits — see
-- services/childPersonalizationService.js#saveProfile), so this migration
-- only ever clears legacy/historical values, never something newly entered.

-- ---------------------------------------------------------------------------
-- Step 0 (read-only, safe to run any time): how much historical data exists?
-- ---------------------------------------------------------------------------
SELECT
    COUNT(*) AS total_profiles,
    SUM(JSON_LENGTH(support_need_ids) > 0) AS profiles_with_support_need_ids,
    SUM(JSON_LENGTH(custom_support_needs) > 0) AS profiles_with_custom_support_needs,
    SUM(support_needs_embedding IS NOT NULL) AS profiles_with_support_needs_embedding
FROM child_personalization_profiles;

-- ---------------------------------------------------------------------------
-- Step 1 (data cleanup — scrubs historical values, keeps every other
-- column/row untouched): run this first, independently of Step 2.
-- ---------------------------------------------------------------------------
UPDATE child_personalization_profiles
SET
    support_need_ids = JSON_ARRAY(),
    custom_support_needs = JSON_ARRAY(),
    support_needs_embedding = NULL
WHERE
    JSON_LENGTH(support_need_ids) > 0
    OR JSON_LENGTH(custom_support_needs) > 0
    OR support_needs_embedding IS NOT NULL;

-- Verify Step 1 worked (expect all zero/NULL after running the UPDATE above):
-- SELECT
--     SUM(JSON_LENGTH(support_need_ids) > 0) AS remaining_support_need_ids,
--     SUM(JSON_LENGTH(custom_support_needs) > 0) AS remaining_custom_support_needs,
--     SUM(support_needs_embedding IS NOT NULL) AS remaining_support_needs_embedding
-- FROM child_personalization_profiles;

-- ---------------------------------------------------------------------------
-- Step 2 (schema cleanup — irreversible column drop): run only once you're
-- satisfied Step 1 is complete and you no longer need the columns at all
-- (e.g. no rollback plan depends on them). Not required for compliance —
-- Step 1 already ensures no support-needs content remains anywhere the
-- application can read it — this just removes the now-always-empty columns.
-- ---------------------------------------------------------------------------
-- ALTER TABLE child_personalization_profiles
--     DROP COLUMN support_need_ids,
--     DROP COLUMN custom_support_needs,
--     DROP COLUMN support_needs_embedding;

-- NOTE: if you run Step 2, you must also remove the three hardcoded '[]'/
-- '[]'/null placeholders for these columns from the INSERT statement in
-- services/childPersonalizationService.js#saveProfile (and the matching
-- column list), since that INSERT will otherwise reference dropped columns
-- and every save will start failing. This is a small, low-risk follow-up
-- edit — intentionally not made in this change so Step 2 stays optional and
-- can be deferred indefinitely without anything else needing to change.
