# Password reset outbox indexes

This migration creates the `continuum_iam.password_reset_outbox` collection and
the indexes required for current-token uniqueness, one-time token lookup,
expiry cleanup, due-message polling, and expired-lease recovery. It does not
modify account data or existing collections. IAM has automatic index creation
disabled by default, so apply this migration before enabling the revised IAM
code in an environment with persistent data.

The migration has a guarded dry-run/apply/rollback flow. It does not read `.env`
files. Supply the same `MONGODB_URI` used by IAM, review the dry-run report and
target fingerprint, then pass the report SHA-256 when applying:

```powershell
$env:MONGODB_URI = 'mongodb://...'
npm run migrate:password-reset-outbox
npm run migrate:password-reset-outbox -- --apply --expected-report-sha256=<reviewed-sha256>
```

Rollback removes only indexes whose definitions exactly match this migration.
It leaves the collection and any documents intact. Stop the revised IAM code
before rollback; that code requires these indexes for single-current-token
semantics and multi-instance worker leases.

The collection has a TTL index on `expiresAt`; MongoDB removes each token and
outbox record after its 30-minute validity window. SMTP success clears the
encrypted email payload earlier. The migration does not send or persist test
emails and must not be run against production without a reviewed dry-run.
