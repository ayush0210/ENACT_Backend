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

**Verify this assumption before treating the IRB cleanup below as low-risk.** If `child_personalization_profiles` has since received real production traffic, Step 0 of `migrations/004_remove_support_needs.sql` (a read-only `SELECT COUNT`) tells you exactly how many rows actually have support-needs data, regardless of what this note assumed at the time it was written.

## IRB: removing the "Support needs" question (migrations/004_remove_support_needs.sql)

The "Support needs" personalization question was removed — it asked about developmental delays/disabilities, which is medical information this study is not approved to collect. The application code change (this commit) already:

- Stops accepting `supportNeeds`/`customSupportNeeds` in the `PUT .../personalization` request body (silently ignored, not rejected — an older client keeps working for every other field).
- Stops returning `supportNeeds`/`customSupportNeeds` from `GET`/`PUT` responses.
- Always writes empty values (`'[]'`, `'[]'`, `NULL`) to the `support_need_ids`/`custom_support_needs`/`support_needs_embedding` columns on every save, regardless of what a client submits — so no new support-needs content can be persisted even before the migration below runs.
- Removes "Support needs" entirely from the canonical option registry (`utils/personalizationOptions.js`), the survey-personalization scoring weights (`utils/personalizationScoring.js`), and the AI prompt (`services/personalizationService.js`).

**What still needs human review and approval — not run automatically:**

1. Run Step 0 (`SELECT COUNT...`) in `migrations/004_remove_support_needs.sql` to see how many existing rows have real support-needs data.
2. Review and run Step 1 (the `UPDATE ... SET support_need_ids = JSON_ARRAY(), ...`) to scrub that historical data. This does not touch any other column/row.
3. Step 2 (dropping the three columns) is optional cleanup, commented out in the same file, with a note on the one follow-up code edit it requires.

See that file's header comment for the full reasoning and ordering.
