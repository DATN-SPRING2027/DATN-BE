# Project code unique index in the effective IAM database

The IAM persistence definition already declares a unique `{ organizationId: 1, code: 1 }` index. With runtime `MONGODB_AUTO_INDEX=false`, the connected `continuum_db.projects` collection may lack it. This script verifies the effective IAM database, reports duplicate pairs and existing indexes, then creates the declared index only after a reviewed clean dry-run. It never changes or deletes Project documents.

Run from the BE repository with the runtime MongoDB environment. Keep the dry-run report and check the database name, target fingerprint, duplicates, existing indexes and proposed action:

```sh
node scripts/migrations/20260929-project-code-unique-index.mjs > project-code-index-dry-run.json
```

Only when `clean=true`, `duplicatePairs=[]` and the target is correct, apply using `reportSha256` from that exact report. A same-key non-unique, sparse, partial or differently collated index is treated as a conflict, not as adequate uniqueness:

```sh
node scripts/migrations/20260929-project-code-unique-index.mjs --apply --expected-report-sha256=<reportSha256>
```

The script rereads the database and refuses a changed report. MongoDB's unique index build also rejects a concurrent duplicate write. A repeated dry-run after success reports `NOOP`; repeating apply with its new report hash verifies the index without changing it. A conflicting index, missing collection or duplicate pair is blocked for manual resolution. Do not remove or rename an existing index automatically. If a wrongly targeted index was created, inspect that environment and its writers before deciding whether to drop it; never run a blind rollback. This migration does not alter schema fields, statuses or existing Project documents.

The index is created with explicit `simple` collation, including when a collection has a different default collation. To exercise duplicate detection and MongoDB enforcement without writing to the real Project collection, run the opt-in integration test; it creates and removes its own randomly named test database:

```sh
MONGODB_INTEGRATION=true node --test scripts/migrations/project-code-index.mongodb.test.mjs
```
