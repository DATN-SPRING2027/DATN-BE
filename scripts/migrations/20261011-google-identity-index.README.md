# Google identity subject index

The IAM `users` collection declares a unique sparse index on `googleSubject`.
Runtime automatic index creation is disabled by default, so apply this additive
index explicitly before enabling Google sign-in in a shared environment.

The migration does not load `.env` files. Set `MONGODB_URI` in the invoking
process or shell, then run a read-only preflight and save the JSON report:

```powershell
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017'
node scripts/migrations/20261011-google-identity-index.mjs > google-identity-index-dry-run.json
```

The report identifies the fixed `continuum_iam.users` target by a credential-
free fingerprint, counts Users and duplicate Google subject groups, reports
whether the exact index can be created, and includes `reportSha256`. It never
prints an email or Google subject. Review that the target is correct and that
`duplicateSubjectGroups` is zero before apply. Pass the hash from that report
so the migration refuses a changed database target or state:

```powershell
$report = Get-Content -LiteralPath 'google-identity-index-dry-run.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261011-google-identity-index.mjs --apply "--expected-report-sha256=$($report.reportSha256)"
```

Apply refuses a duplicate subject, a non-collection object named `users`, or an
incompatible existing index, then verifies the index and unchanged User count.
Resolve reported conflicts separately; the script does not merge or modify
User documents. The operation is idempotent.

For rollback, first run and review a fresh dry-run, then pass its
`reportSha256`. Rollback drops only the exact `googleSubject_1` unique sparse
index. It does not delete the `googleSubject` field or any User data:

```powershell
$report = Get-Content -LiteralPath 'google-identity-index-dry-run.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261011-google-identity-index.mjs --rollback "--expected-report-sha256=$($report.reportSha256)"
```

Rollback disables the database uniqueness guard while the application can
still write Google identities. Coordinate the rollback with the code rollback
and stop OAuth writes first. Re-run the dry-run after any partial failure and
review current state before retrying.
