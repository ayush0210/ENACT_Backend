# Recording analysis deployment

The mobile app uploads recordings only to the authenticated ENACT API. Rev.ai and
OpenAI credentials must exist on the ENACT server and must never be added to the
mobile application.

## Required environment variables

```env
REVAI_API_KEY=replace_with_server_secret
OPENAI_API_KEY=replace_with_server_secret
OPENAI_CLASSIFICATION_MODEL=gpt-4o-mini
RECORDING_LLM_ENABLED=true
RECORDING_MAX_BYTES=52428800
RECORDING_TRANSCRIPTION_TIMEOUT_MS=600000
```

## Database migration

Back up the production database, then run:

```bash
mysql -u YOUR_DB_USER -p YOUR_DB_NAME < migrations/001_create_recordings.sql
```

Verify the migration:

```sql
SHOW CREATE TABLE recordings;
SHOW INDEX FROM recordings;
```

The migration is additive: it creates a new table and does not change existing
users, children, location, notification, or personalization tables.

## Deploy backend

```bash
npm ci
npm run test:recordings
pm2 restart ecosystem.config.cjs --env production
pm2 logs tat --lines 100
```

Test authentication before uploading real audio:

```bash
curl -i https://enact.education.ufl.edu/api/recordings
```

The response must be `401 Unauthorized` without a JWT.

## API lifecycle

-   `POST /api/recordings` accepts multipart audio and returns `202`.
-   `GET /api/recordings/:id` returns queued, processing, completed, or failed.
-   `GET /api/recordings` lists recordings owned by the signed-in user.
-   `DELETE /api/recordings/:id` deletes an owned server record.

The first implementation runs analysis asynchronously inside the single PM2
process. Before increasing PM2 beyond one instance, move processing to a durable
queue such as BullMQ/Redis.
