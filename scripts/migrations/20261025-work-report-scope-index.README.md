# Work Report scope index migration

PR #99 stores separate `MEMBER` and `LEADER` reports for the same user and period. The existing unique index on `(projectId, memberUserId, periodStart)` prevents both records from coexisting. This migration replaces it with `(projectId, memberUserId, reportScope, periodStart)` and backfills older reports without `reportScope` as `MEMBER`.

Run against the `continuum_capture` database **before deploying the updated Capture service**, with Capture writes paused. The script uses `MONGODB_URI` and selects `continuum_capture` explicitly. It never prints the URI.

```powershell
node scripts/migrations/20261025-work-report-scope-index.mjs
node scripts/migrations/20261025-work-report-scope-index.mjs --apply --writes-paused
node scripts/migrations/20261025-work-report-scope-index.mjs
```

The first and last commands report the plan without writes. The last report should have `backfill: false`, `create: false`, and `drop: false`. Do not resume writes until the new index exists and the old index is gone.

Rollback after new Leader reports exist cannot recreate the old unique index while both scopes share a period. Revert the application only after checking those records and deciding how to retain or remove Leader reports. The backfilled `reportScope` field can remain in place.
