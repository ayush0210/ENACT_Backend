# Child personalization: deployment

## Database migration

This project has no automated migration runner. Back up the production database, then apply:

```
mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/003_create_child_personalization_profiles.sql
```

Verify:

```sql
DESCRIBE child_personalization_profiles;
```

The migration is additive: it only creates a new table (`child_personalization_profiles`), with a foreign key to `children(id)` (`ON DELETE CASCADE`). No existing table is altered. It is safe to apply before deploying the code that uses it — the table is simply unused until then.

## Deploy order

Apply the migration *before* deploying code that reads/writes `child_personalization_profiles` — the new routes and the personalization-scoring changes in `services/personalizationService.js` will throw on missing-table errors otherwise. The rest of tip generation/retrieval is unaffected if the table doesn't exist yet, since every new personalization lookup is wrapped to degrade to "no profile" behavior (see `docs/child-personalization.md`).

## Environment / config

No new environment variables are required. The scoring blend weights (`PERSONALIZATION_BLEND`, `SURVEY_PERSONALIZATION_WEIGHTS` in `services/personalizationService.js`) and the review interval (`PERSONALIZATION_REVIEW_INTERVAL_DAYS` in `utils/personalizationOptions.js`) are code constants, not env vars — see `docs/child-personalization.md` for where to adjust them.

## Frontend data migration

This feature has not shipped to users yet (the frontend personalization UI was built against a temporary AsyncStorage-only data source in the same development cycle as this backend work). There is no production install base with locally-saved survey answers to migrate, so no one-time client migration routine was added — see `docs/child-personalization.md` ("Frontend data migration" section) for the full reasoning and what to do if that assumption turns out to be wrong before release.
