# Saved-location activities deployment

Adds an optional, per-location list of activities used as extra context when
generating location-triggered parenting tips. Fully backward compatible: locations
with no selected activities behave exactly as before.

## Database migration

This project has no automated migration runner. Back up the production database,
then run:

```bash
mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/002_add_location_activities.sql
```

Verify the migration:

```sql
SHOW CREATE TABLE locations;
```

The migration is additive: it adds one nullable `activities JSON` column with no
default and does not touch existing rows or any other table.

**Deploy order matters:** apply this migration *before* deploying the updated
backend code. The new code selects/writes the `activities` column on `locations`
(`routes/location.js`, `routes/geofence.js`); if that code runs against a database
that hasn't been migrated yet, every location create/update/list/notification
request will fail with an SQL error (`Unknown column 'activities'`). Re-running the
migration file against an already-migrated database fails with "Duplicate column
name" — expected, and safe to ignore.

## Deploy backend

```bash
npm ci
npm run lint
npm run test:recordings
npm run test:location-activities
pm2 restart ecosystem.config.cjs --env production
pm2 logs tat --lines 100
```

## API changes

-   `POST /endpoint/addLocation` — `description` is now optional; accepts an optional
    `activities: string[]`. Unapproved activity names are rejected with `400`.
-   `PUT /endpoint/updateLocation` — new endpoint. Updates type/name/description/
    activities on a location owned by the authenticated user. Coordinates are not
    editable through this endpoint.
-   `POST /endpoint/locations` — `details[]` entries now also include `type` and
    `activities: string[]` (previously activities didn't exist; `type` was missing
    from this response even though it existed in the DB).
-   `POST /endpoint` and `POST /endpoint/geofence-enter` — when a location has
    selected activities, they're appended to the tip-generation prompt. Locations
    with no activities produce the exact same prompt as before this change.
