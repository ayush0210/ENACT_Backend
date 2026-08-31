-- Adds optional per-location activity selection.
--
-- Column is nullable with no default so existing rows are unaffected: NULL means
-- "no activities selected" and is read back as [] by the API (see
-- utils/locationActivities.js#parseStoredActivities). No backfill required.
--
-- NOTE: this project has no automated migration runner (see package.json — there is
-- no "migrate" script). Apply this by hand against the target database BEFORE
-- deploying code that reads or writes the `activities` column (see deployment note
-- in the implementation report). Re-running this file against a database that
-- already has the column will fail with "Duplicate column name" — that is expected
-- and safe to ignore; it is not idempotent like 001_create_recordings.sql's
-- CREATE TABLE IF NOT EXISTS, because MySQL's ADD COLUMN IF NOT EXISTS is only
-- available on MySQL 8.0.29+.

ALTER TABLE locations
ADD COLUMN activities JSON NULL DEFAULT NULL;
