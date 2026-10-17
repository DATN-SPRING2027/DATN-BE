# Platform user account lifecycle — DB v1

## Scope

Add optional archive metadata to IAM `users` documents:

- `archivedAt`: when the account was archived.
- `archivedBy`: ObjectId of the operator who archived it.

An absent `archivedAt` means the account is not archived. Restore removes both
fields. Archive does not physically delete the user, memberships, audit events,
or related records. The backend lifecycle contract will suspend the account and
revoke its refresh sessions in the same transaction as archiving; restore clears
the archive marker but leaves the account suspended until a separately
authorized reactivation.

Profile edits and account status remain in their existing fields. Email,
password credentials, and authentication factors are outside this DB change.

## Data and migration impact

This is an additive Mongoose schema change. Both fields are optional, so existing
documents remain valid and no backfill is required. It creates no collections,
indexes, or database validators, and does not write to any environment. The
backend must not write these fields until this schema change is merged.

No migration command is required. If a later deployment adds a database-level
validator or query index for archive filtering, that must be a separately
reviewed additive migration with its own report-first apply and rollback plan.

## Rollback

Rollback is safe before the backend writes archive metadata. If the backend has
already archived accounts, first disable or roll back those API paths and
restore each archived account through the application so status, sessions, and
audit history remain consistent. Then confirm no `archivedAt` or `archivedBy`
values remain before reverting this schema change. Do not bulk-delete account
or lifecycle data as a schema rollback.

## Verification

The schema change is covered by repository lint, type-check, and build checks.
No migration is applied as part of this work package.
