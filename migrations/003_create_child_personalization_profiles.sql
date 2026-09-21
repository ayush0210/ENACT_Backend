-- Adds per-child personalization profiles (favorites / skills-in-progress /
-- support-needs) backing the frontend's accordion survey. Previously this
-- data lived only in the app's local AsyncStorage (PersonalizationDataSource.ts).
--
-- A profile belongs to exactly one child (UNIQUE KEY on child_id), and is
-- owned transitively through children.user_id — ownership is enforced in
-- application code (see services/childPersonalizationService.js), not by a
-- column on this table, matching every other child-scoped table in this
-- schema (e.g. recordings).
--
-- Predefined selections are stored as canonical option IDs (JSON array of
-- strings), validated against utils/personalizationOptions.js on every
-- write — never trust IDs from the client without revalidating server-side.
-- Custom free-text answers are stored only after passing
-- utils/personalizationSafety.js; rejected raw text is never persisted here.
--
-- *_embedding columns cache OpenAI embeddings of the approved custom+canonical
-- text per category, computed on save, so tip-time scoring
-- (services/personalizationService.js) doesn't need to re-embed the profile
-- on every request — mirrors user_preference_profiles.preference_embedding.
--
-- NOTE: this project has no automated migration runner (see package.json).
-- Apply by hand: mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/003_create_child_personalization_profiles.sql
-- This migration is additive: it only creates a new table. No existing data
-- is modified. Safe to run before or after deploying the code that reads/
-- writes it (the table simply won't be used until the new routes are live).

CREATE TABLE IF NOT EXISTS child_personalization_profiles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    child_id INT NOT NULL,
    -- Canonical option IDs selected from utils/personalizationOptions.js.
    favorite_ids JSON NOT NULL,
    skill_ids JSON NOT NULL,
    support_need_ids JSON NOT NULL,
    -- Approved, normalized custom text (see utils/personalizationSafety.js).
    -- Each is a JSON array of strings; rejected/unmoderated text is never stored.
    custom_favorites JSON NOT NULL,
    custom_skills JSON NOT NULL,
    custom_support_needs JSON NOT NULL,
    -- Cached embeddings of this profile's approved text per category, used by
    -- the survey_personalization scoring term. NULL until first computed.
    favorites_embedding JSON NULL,
    skills_embedding JSON NULL,
    support_needs_embedding JSON NULL,
    -- Quarterly review bookkeeping (see PERSONALIZATION_REVIEW_INTERVAL_DAYS).
    -- "Remind me later" is deliberately NOT a column here — it stays device-
    -- local (AsyncStorage), same as before this migration. See
    -- docs/child-personalization.md ("Quarterly review") for why: it's a
    -- low-stakes UX snooze, not data that needs to survive a reinstall or
    -- sync across devices, and keeping it local avoids a write path that
    -- only ever sets one flag back to "not dismissed."
    last_reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_child_personalization_child (child_id),
    KEY idx_child_personalization_reviewed (last_reviewed_at),
    CONSTRAINT fk_child_personalization_child
        FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
);
