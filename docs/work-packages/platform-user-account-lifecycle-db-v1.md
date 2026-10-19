# Platform user account lifecycle — DB v1

## Scope

The IAM `users` schema already supports optional `avatarUrl`, `archivedAt`, and
`archivedBy` fields. Missing `archivedAt` means the account is not archived.
This work adds Platform user profile editing, archival, and safe restoration
against that existing schema. Restoration clears the archive markers and makes
the user visible in the directory as SUSPENDED; reactivation remains a separate
status operation.

Profile edits are limited to `fullName` and `avatarUrl`. Email, password
credentials, authentication factors, and memberships are outside the profile
mutation contract.

Archiving is a lifecycle transition, not deletion. The API sets `archivedAt`
and `archivedBy`, changes an eligible ACTIVE account to SUSPENDED, revokes its
refresh sessions, and records a Platform audit event in one MongoDB
transaction. User documents, memberships, and prior audit events remain. The
archive marker distinguishes an archived account from an ordinary suspended
account in list filtering and detail projections. Archived accounts cannot be
edited, reactivated, or archived again while archived. An authorized Platform
Operator may restore one to SUSPENDED, then use the separate Reactivate action
to return it to ACTIVE.

Both profile edits and account lifecycle changes require the current
`platform.users.account.manage` Platform assignment and an `updatedAt` compare-
and-set value. Audit writes are part of the same transaction. Self-archive and
archive/suspension of the last eligible Organization ADMIN are denied.

## Data and migration impact

The fields used by this work are already defined in the Mongoose schema on
`main`. This task adds no schema, collection, index, validator, or backfill
change and requires no migration. The work does not connect to or write to a
production or staging database. Mongo integration coverage uses an isolated,
disposable replica set with a randomized database name.

No database data change is required for deployment. If a later deployment
adds a database-level validator or query index for archive filtering, that
must be a separately reviewed additive migration with its own report-first
apply and rollback plan.

## Rollback

Rolling back the API code does not delete or clear archived user data. Since
this work does not deploy or mutate production/staging data, there is no data
rollback to run for this change. If restoration has been used after deployment,
rolling back the endpoint leaves those users unarchived and SUSPENDED; the
existing status operation can still be used by an authorized operator. Preserve
audit history and do not clear archive metadata with a bulk update.

## Verification

The Mongo integration tests cover profile field allowlisting, safe audit
projection, CAS conflicts including concurrent updates, current Platform
authority checks, archival retention, session revocation, last-admin/self
guards, and rollback when the required audit write fails. No migration is
applied as part of this work package.
