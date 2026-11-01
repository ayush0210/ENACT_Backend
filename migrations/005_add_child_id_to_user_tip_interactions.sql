-- Adds an optional child_id to user_tip_interactions so a like/dislike/save
-- can be attributed to a specific child, not just the account (user_id).
--
-- Why this was missing: the app already resolves which child a tip was
-- shown for at interaction time (MainScreen.tsx's activeChildId), but that
-- value was never sent with the like/dislike/save/unsave POST
-- (routes/personalization.js's POST /interactions) or stored here. This is
-- the dependency blocking any per-child feature built on top of likes (e.g.
-- a per-child "weekly reflection" summary).
--
-- Nullable and NOT retroactive: existing interactions keep child_id = NULL
-- (there is no reliable way to recover which child an old like was for).
-- New interactions set it going forward once the client/route changes ship
-- (see services/personalizationService.js trackUserInteraction and
-- routes/personalization.js POST /interactions).
--
-- The existing 3-way unique keys (user_id, tip_id, interaction_type) already
-- allow at most one row per (user, tip, type) today; this adds a SEPARATE
-- unique key that includes child_id, so the same tip can be liked/saved
-- independently per child once child_id starts being populated, without
-- touching or breaking the old keys (pre-migration NULL-child_id rows stay
-- valid and unique under them).
--
-- NOTE: this project has no automated migration runner (see package.json).
-- Apply by hand: mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/005_add_child_id_to_user_tip_interactions.sql
-- Additive and backward-compatible: nullable column, no existing data
-- modified or deleted. Safe to run before or after deploying the code that
-- reads/writes it — until the app sends child_id, every new row just keeps
-- behaving exactly as it does today.

ALTER TABLE user_tip_interactions
    ADD COLUMN child_id INT NULL AFTER tip_id,
    ADD KEY idx_uti_child (child_id),
    ADD CONSTRAINT fk_uti_child FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE,
    ADD UNIQUE KEY uniq_user_tip_type_child (user_id, tip_id, interaction_type, child_id);
