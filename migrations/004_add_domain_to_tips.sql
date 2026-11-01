-- Adds a domain column to tips so a tip's content domain (Science / Language /
-- Literacy / Social-Emotional) can be queried directly, instead of being
-- parsed out of the free-text tip_categories table.
--
-- The AI tip-generation pipeline (services/personalizationService.js,
-- SELECTABLE_DOMAINS / normalizeGeneratedDomain) already classifies every
-- generated tip into exactly one of these four canonical domain strings —
-- this column persists that existing classification instead of discarding
-- it. Reuses the SAME canonical strings as SELECTABLE_DOMAINS and
-- utils/strictDomains.js's ALLOWED_DOMAINS, so there is only one domain
-- vocabulary in this codebase, not two.
--
-- Existing rows start NULL:
--   - The 201 `source='db'` seed tips were never domain-tagged (they're
--     keyed by a messy `type` location/context field, e.g. "Bus/Walk",
--     "Library" — not a content domain) and need a one-time backfill pass.
--   - The 85 pre-existing `source='ai'` tips had their domain captured only
--     in tip_categories (free text) at insert time; a backfill can recover
--     most of these from that table before falling back to reclassifying
--     from title+description.
-- New `source='ai'` tips are populated directly by upsertGeneratedTip() going
-- forward (see services/personalizationService.js).
--
-- NOTE: this project has no automated migration runner (see package.json).
-- Apply by hand: mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/004_add_domain_to_tips.sql
-- Additive and backward-compatible: nullable column, no existing data
-- modified. Safe to run before or after deploying the code that reads/
-- writes it — until that code ships, this column simply stays NULL.

ALTER TABLE tips
    ADD COLUMN domain ENUM(
        'Language Development',
        'Early Science Skills',
        'Literacy Foundations',
        'Social-Emotional Learning'
    ) NULL
    AFTER source;
