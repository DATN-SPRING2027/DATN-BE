# Task deadline scan index

This additive migration creates only `tasks.deadline_scan_due_cursor` with key
`{ dueDate: 1, _id: 1 }` in `continuum_task`. It does not alter Task documents,
validators, collections, or existing indexes. It does not activate the
standalone Task runtime.

The migration requires an explicit `TASK_MONGODB_URI` in the invoking process
and never reads `.env`. Dry-run is read-only and prints a credential-free target
fingerprint, estimated task count, index conflict check, and report hash:

```powershell
$env:TASK_MONGODB_URI = '<approved Task database URI>'
npm run migrate:task-deadline-scan-index > task-deadline-scan-index-dry-run.json
$plan = Get-Content -LiteralPath 'task-deadline-scan-index-dry-run.json' -Raw | ConvertFrom-Json
```

Review the database target, count, clean status, and desired index action. Pause
Task writes before applying. Apply accepts only the exact reviewed report hash
and verifies the index after creation:

```powershell
npm run migrate:task-deadline-scan-index -- --apply --task-writes-paused "--expected-report-sha256=$($plan.reportSha256)"
```

The index is non-unique. MongoDB index builds can briefly hold collection locks
at the beginning and end and can affect write performance; choose a maintenance
window for write-heavy workloads. See [MongoDB 7 index builds](https://www.mongodb.com/docs/v7.0/core/index-creation/).
The migration does not delete or rewrite Task records. To reverse this
index-only change, a separately reviewed operation may drop
`deadline_scan_due_cursor` after confirming no deployed code depends on it.

Validate the pure migration plan with:

```powershell
npm run test:task-deadline-scan-index-plan
```
