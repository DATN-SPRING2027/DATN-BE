# Platform authority change hardening migration

This additive migration adds the 365-day TTL index to the existing operation
ledger and provisions one transaction lock record for each supported A-04
permission. The lock records serialize grant/revoke transactions that update the
same permission, so the last-operator check cannot pass concurrently twice.
It does not change assignments, ledger documents, or audit records.

Run `20261016-platform-authority-change-operations.mjs` first. This migration
blocks if `platform_authority_change_operations` does not already exist. It is
dry-run by default and reports the exact target fingerprint, index actions,
lock records, and report hash:

```powershell
node scripts/migrations/20261016-platform-authority-change-hardening.mjs > platform-authority-change-hardening-dry-run.json
$report = Get-Content -LiteralPath 'platform-authority-change-hardening-dry-run.json' -Raw | ConvertFrom-Json
$report
```

Review `clean: true`, the intended database and target fingerprint, and the
planned TTL index and three lock rows. Apply only that report:

```powershell
node scripts/migrations/20261016-platform-authority-change-hardening.mjs --apply "--expected-report-sha256=$($report.reportSha256)"
```

Generate a new report and hash for each environment. The report hash is bound to
the target database and current database state; do not copy a staging hash to
production. Apply creates only the TTL index, lock collection/index, and missing
lock records. It preserves existing lock versions and all authority data.

Rollback is forward-only after runtime use. Do not drop the lock collection or
TTL index while the application can execute authority changes. If this
migration must be reversed before the service is enabled, coordinate code
rollback and retain the operation ledger; no assignment or ledger documents
should be deleted.
