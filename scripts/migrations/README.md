# Task lifecycle contract

## Work Note workflow indexes

The `migrate:work-note-workflows` command uses the idempotent
`20261024-work-note-workflows-v2.mjs` migration. It only targets
`continuum_capture`, checks all required unique indexes for duplicate keys
before creating any missing index, and recognizes an equivalent index even if
MongoDB assigned a different name during development bootstrap. Conflicting
keys or index options stop the migration. The migration does not rewrite or
delete documents.

The Capture persistence contract requires `taskId` on new `TASK_NOTE` records.
The migration intentionally leaves existing `work_notes` documents unchanged;
legacy unlinked records remain stored for recovery and classification, and are
excluded from the three-type Work Note API. They must be reviewed before a
separate data conversion because the old fields do not reliably identify a
Task Note, Project Document, or Periodic Work Report.

The default run is a dry run. Applying against a non-loopback MongoDB target
requires `--allow-shared-database` and setting
`WORK_NOTE_MIGRATION_CONFIRM_DATABASE=continuum_capture` in the invoking
process after the database target has been reviewed:

```powershell
$env:SERVICE_DATABASE = 'continuum_capture'
$env:MONGODB_URI = '<approved Capture database URI>'
npm run migrate:work-note-workflows
# Loopback-only apply; non-loopback apply uses the explicit command below.
npm run migrate:work-note-workflows -- --apply
```

For a reviewed non-loopback target, use the explicit shared-database apply command:

```powershell
$env:WORK_NOTE_MIGRATION_CONFIRM_DATABASE = 'continuum_capture'
npm run migrate:work-note-workflows -- --apply --allow-shared-database
```

Apply is additive and repeatable. Rollback leaves the added indexes and data in
place; remove an index only after verifying it is not used by the running
workflow and planning a maintenance window.

DATN-100 adds the approved D-08 lifecycle fields and status-history contract to
the dormant Task data foundation. The [D-13-R6 approval record (Document PR #48)](https://github.com/DATN-SPRING2027/Document/pull/48/files)
scopes the five statuses, transition matrix, guards, version behavior, event,
and idempotency choices. This migration does not register or activate the Task
runtime.

The new Task creation primitive writes `status: TODO`, `assigneeId: null`, and
`completedAt: null`. Existing seven-field Task documents receive those values
only where the lifecycle fields are missing. Any Task, event, or operation
document that fails the target validator, duplicate version events, duplicate
operation keys, or an incompatible index blocks apply. Task documents,
creation history, and other collections are never deleted. D-03 `TASK_CREATED`
events retain their exact P3 schema; status transitions use a separate strict
event shape scoped by `projectId`. The event does not persist `organizationId`,
which is outside the approved DATN-100 scope. The new `task_operations`
collection stores only bounded status-command idempotency records and expires
them after their configured 24-hour window.

The migration requires an explicit `TASK_MONGODB_URI`, targets only
`continuum_task`, and never loads `.env`. It refuses to create the existing
`tasks` or `task_events` collections; it may create the new `task_operations`
collection. Dry-run is read-only and prints a credential-free target
fingerprint, preflight counts, planned index changes, and `reportSha256`:

```powershell
$env:TASK_MONGODB_URI = '<approved Task database URI>'
npm run migrate:task-lifecycle-contract > task-lifecycle-dry-run.json
$report = Get-Content -LiteralPath 'task-lifecycle-dry-run.json' -Raw | ConvertFrom-Json
```

Review the database target, backfill counts, and clean status first. Task writes
must remain paused while apply temporarily installs a compatibility validator,
backfills existing documents, and installs the final strict validator. Apply
requires an explicit `--task-writes-paused` assertion and the exact reviewed
report:

```powershell
npm run migrate:task-lifecycle-contract -- --apply --task-writes-paused "--expected-report-sha256=$($report.reportSha256)"
```

Apply is additive and idempotent. The migration-time compatibility validator
accepts the legacy seven-field shape only long enough to backfill it. The final
validator requires `status`, `assigneeId`, and `completedAt` on every Task and
enforces their lifecycle invariants. After apply, an older D-03 writer that
omits these fields is incompatible; keep Task dormant until a lifecycle-aware
release is ready. For rollback, disable Task writes and keep the database
expansion and backfilled data. Do not remove lifecycle fields, status events,
the operation collection, or its TTL index. No shared or production database
was modified by the DATN-100 change.

Validation commands include `npm run test:migrations:plan` for report and
idempotency planning. The marked MongoDB 7 replica-set integration suite is
opt-in through `MONGODB_INTEGRATION=true` and a loopback `MONGODB_URI`; it must
never be pointed at a shared database.

## Organization Membership legacy backfill

DATN-87 adds a separate [lifecycle tracking/operation-cache DB work package](../../docs/work-packages/organization-membership-lifecycle-db-v1.md)
and new `20261012-organization-membership-lifecycle.mjs`. Its metadata/permission
migration does not rerun this historical membership backfill or enable C-02 APIs.

## Google identity subject index

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
`duplicateSubjectGroups` is zero before apply. The script requires the hash
from that exact dry-run:

```powershell
$report = Get-Content -LiteralPath 'google-identity-index-dry-run.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261011-google-identity-index.mjs --apply "--expected-report-sha256=$($report.reportSha256)"
```

Apply refuses a duplicate subject, a non-collection object named `users`, or
an incompatible existing index, then verifies the index and unchanged User
count. The operation is idempotent.

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

## Email/password registration outbox

The registration pending-email collection and its unique token/email, TTL,
worker-polling, and lease-recovery indexes are defined in the approved
[email/password registration DB work package](../../docs/work-packages/email-password-registration-db-proposal-v1.md).
The report-first migration is documented in
[20261018-email-registration-outbox.README.md](20261018-email-registration-outbox.README.md).
Apply its reviewed dry-run before enabling the BE routes or mail worker. The
migration preserves all documents on rollback; stop registration writes and
the worker before dropping its indexes. It has not been applied by this code
change.

The A-04 platform authority assignment collection and index migration is
documented in [20261005-platform-authority-assignments.README.md](20261005-platform-authority-assignments.README.md).
The additive platform authority change operations ledger collection and index migration is
documented in [20261016-platform-authority-change-operations.README.md](20261016-platform-authority-change-operations.README.md).
The committed per-permission/TTL hardening migration is superseded; see
[20261016-platform-authority-change-hardening.README.md](20261016-platform-authority-change-hardening.README.md).
The report-first V2 script for the shared lifecycle lock, bundle index, and
removal of the unapproved TTL index is documented in
[20261016-platform-authority-change-v2-lifecycle.README.md](20261016-platform-authority-change-v2-lifecycle.README.md).

## Organization invitations

`20261011-organization-invitations.mjs` creates the new invitation collection's
unique pending `(organizationId, email)` index and its account/Organization
lookup indexes. It is additive: it does not create Users, memberships, roles,
or invitation records. It reports duplicate pending pairs and incompatible
indexes before changing anything. It does not load `.env`; provide `MONGODB_URI`
and the runtime `MONGODB_ENABLED`, `INFRA_ENABLED`, and, in shared mode,
`MONGODB_DATABASE` variables in the command environment.

Run a dry report and retain its SHA-256 for review:

```powershell
$env:MONGODB_URI = '<approved MongoDB URI>'
$env:INFRA_ENABLED = 'true'
$env:MONGODB_ENABLED = 'false'
node scripts/migrations/20261011-organization-invitations.mjs
```

Apply only the exact reviewed report:

```powershell
node scripts/migrations/20261011-organization-invitations.mjs --apply --expected-report-sha256=<reportSha256>
```

Apply creates only the collection and three named indexes. The pending unique
index is partial on `status: PENDING`; old accepted, revoked, and expired
records remain queryable. No TTL index is used because invitation lifecycle
records are retained for audit. Runtime auto-indexing remains governed by the
existing IAM setting.

Rollback requires a fresh reviewed report and refuses while unexpired pending
invitations exist:

```powershell
node scripts/migrations/20261011-organization-invitations.mjs --rollback --expected-report-sha256=<reportSha256>
```

Rollback drops only the three named indexes. It preserves the collection and
all invitation records so an application rollback cannot erase audit history.
Resolve or allow pending invitations to expire before rollback; retain the
report and coordinate API rollback with the backend release.

### Email-bound invitation token hash index

`20261020-organization-invitation-token-index.mjs` adds the unique partial
`invitation_token_hash_unique_v3` index on `organization_invitations.tokenHash`.
It requires the existing collection, checks for duplicate/malformed hashes and
V3 records missing their required hash without printing token values, and makes
no document or account changes.
The partial index excludes legacy V1/V2 invitations that have no token hash.
The script does not load `.env`; use the same explicitly reviewed IAM target
environment values described above.

Run the dry-run and retain its credential-free report and SHA-256:

```powershell
npm run migrate:organization-invitation-token-index
```

Apply only the exact reviewed report:

```powershell
npm run migrate:organization-invitation-token-index -- --apply --expected-report-sha256=<reportSha256>
```

Rollback preserves invitation documents and refuses while any V3 invitation
record exists, including accepted/expired history. Stop V3 invitation writes and
review a fresh report before dropping only the named token hash index:

```powershell
npm run migrate:organization-invitation-token-index -- --rollback --expected-report-sha256=<reportSha256>
```

## Organization Membership Admin permissions

`20261019-organization-membership-admin-permissions.mjs` adds only
`organization.memberships.read` and `organization.memberships.manage` to the
existing system `ADMIN` Role in the IAM database. It does not change schema,
RoleAssignments, memberships, or any non-ADMIN Role. The dry-run and apply use
the same database selection as IAM: shared MongoDB mode uses
`MONGODB_DATABASE`; service-owned mode uses `continuum_iam` when
`INFRA_ENABLED=true`; disabled persistence is refused. The package script loads
`.env`; verify that its `MONGODB_URI` and mode flags match the target runtime.

Run and retain the read-only report first:

```powershell
node --env-file=.env scripts/migrations/20261019-organization-membership-admin-permissions.mjs > organization-membership-admin-permissions-before.json
$before = Get-Content -LiteralPath 'organization-membership-admin-permissions-before.json' -Raw | ConvertFrom-Json
```

Confirm `databaseName`, `targetFingerprint`, the single system `ADMIN` Role ID,
the exact missing permissions, and an empty `issues` list before applying that
report:

```powershell
node --env-file=.env scripts/migrations/20261019-organization-membership-admin-permissions.mjs --apply "--expected-report-sha256=$($before.reportSha256)"
```

Apply is idempotent and preserves existing permission values. This is a data
change: every Organization-level assignment resolving to this system `ADMIN`
Role gains the membership read and management capabilities. Rollback requires
a fresh reviewed dry-run for the current state and the saved clean pre-apply
report; it removes only the approved permissions that report identified as
missing. Before rollback, confirm no later Role change independently relies on
those permissions, and coordinate it with rolling back the UI/API change.

```powershell
node --env-file=.env scripts/migrations/20261019-organization-membership-admin-permissions.mjs > organization-membership-admin-permissions-current.json
$current = Get-Content -LiteralPath 'organization-membership-admin-permissions-current.json' -Raw | ConvertFrom-Json
node --env-file=.env scripts/migrations/20261019-organization-membership-admin-permissions.mjs --rollback "--expected-report-sha256=$($current.reportSha256)" --rollback-from-report=organization-membership-admin-permissions-before.json
```

## Project Access permission provisioning

`20261012-project-access-permission-provisioning.mjs` is the additive DB
work package for [Project Access & Visibility V1](../../docs/decisions/project-access-visibility-v1.md).
It adds only the accepted permission codes to existing system `ADMIN` and
`TEAM_LEADER` Roles in the IAM database. The full target mapping, report-first
apply and rollback procedure, MongoDB behavior, and test evidence are in
[`docs/work-packages/project-access-permission-provisioning-v1.md`](../../docs/work-packages/project-access-permission-provisioning-v1.md).

The script is dry-run by default. It does not load `.env`, create Roles, alter
other permission values, or apply data as part of this work package.

`20260928-organization-memberships.mjs` reports the exact `ACTIVE` memberships
proposed from organization-level `role_assignments`. It reads only rows with a
null or absent `projectId` and valid `userId` and `organizationId`. Multiple
assignments for the same pair yield one membership. Project-scoped assignments
are excluded. Existing role assignments are never changed.

Set `MONGODB_URI` and the same `MONGODB_ENABLED`/`INFRA_ENABLED` flags as the
runtime being migrated. In shared mode (`MONGODB_ENABLED=true`), the script
uses `MONGODB_DATABASE`; in dedicated IAM mode (`INFRA_ENABLED=true` and
`MONGODB_ENABLED=false`), it uses `continuum_iam`, matching IAM persistence.
It refuses to run when IAM persistence is disabled. The script loads local
`.env` when present. Confirm the database name before
running. Save and review the complete read-only report:

```sh
node scripts/migrations/20260928-organization-memberships.mjs > organization-membership-dry-run.json
```

The report lists every proposed record and its source User account status,
every organization-level legacy pair and its User account status, and each
excluded project-scoped User/Organization pair with assignment IDs and whether
another organization-level source or `ACTIVE` membership exists. It also lists
users and organizations with no organization-level legacy relationship,
duplicate legacy assignments, invalid or dangling relationships, and conflicts
with existing memberships. The historical backfill deliberately creates an
`ACTIVE` membership from every eligible organization-level legacy pair even if
the User account is `SUSPENDED` or `PENDING_INVITE`: the User account status is
reported for review, while login eligibility is enforced separately. A duplicate
legacy pair is informational because the mapping is unambiguous. `clean` is
false for invalid/dangling records or conflicting/duplicate existing
memberships; dry-run exits with code 2 then. Unmatched users or organizations
are reported and are never given an inferred membership.

Only after reviewing a clean report and checking that it targets the intended
database, stop all writers to legacy `role_assignments` and
`organization_memberships` for the duration of apply. The repository currently
has no application writer for either collection; external scripts or operators
must also be quiescent. Apply with the reported `reportSha256` and both explicit
quiescence assertions. The hash includes a fingerprint of the URI scheme,
endpoint, routing options and database name. It excludes URI credentials and
authentication options; changing credentials alone does not invalidate a
reviewed target report:

```sh
node scripts/migrations/20260928-organization-memberships.mjs --apply --legacy-writes-paused --membership-writes-paused --expected-report-sha256=<reportSha256>
```

Apply rereads all source data and refuses to write if the report changed or is
not clean. It first creates the unique `(organizationId, userId)` index and the
`(userId, status, organizationId)` lookup index, then
rechecks the source before each `$setOnInsert` upsert. The source recheck is an
additional guard; it does not replace stopping concurrent legacy writers.
It reads each membership after upsert and fails if its status is not `ACTIVE`;
this check does not replace stopping concurrent membership writers.
Repeated runs do not duplicate memberships or
reactivate an existing non-`ACTIVE` membership. If an apply stops partway,
rerun dry-run and review the new hash before retrying. Keep the saved report as
migration evidence. Do not deploy Organization Context lookup until the
backfill has completed and been verified.

## Impact and recovery

The migration only inserts missing `organization_memberships` rows with
`status=ACTIVE` for eligible legacy pairs and creates the unique pair and
lookup indexes. It
never updates or deletes `role_assignments` or pre-existing memberships. The
production-like shared `continuum_db` used for this work package already
received five such records; the post-apply report found five existing records
and zero further inserts. The lookup index was added to the script after this
historical apply and must be created with a newly reviewed apply before scaling
the membership lookup; the runtime defaults `MONGODB_AUTO_INDEX` to false.
This historical apply used an earlier report hash
that did not bind the database target. A later read-only report and live-state
verification confirmed the five pairs and index; they cannot retroactively
strengthen the earlier apply.

If apply stops partway, keep the inserted memberships, fix the cause, run and
review a new dry-run, then rerun apply; the unique pair index and upsert make
this forward recovery idempotent. If an incorrect target was used, do not run a
blind delete or rollback. Preserve the report and audit the exact inserted
membership IDs, their legacy sources, and any subsequent membership changes;
obtain an environment-specific correction plan before modifying data. Rolling
back BE code alone is unsafe once organization access depends on memberships;
restore the previous code only with an explicit access and data plan.

## Project visibility and Project Membership uniqueness

`20260930-project-visibility-membership-index.mjs` is a read-only report by
default. It lists every existing Project whose `visibility` field would be set
to `PRIVATE`, rejects unexpected visibility values or missing Organization
scope, reports duplicate or malformed Project Membership pairs, and reports
scope mismatches, unknown membership statuses, and whether the unique
`(projectId, userId)` index is present, would be created, or is blocked. It
never infers or creates Project Membership records from existing user or role
data.

Run and save the dry-run report before any apply:

```sh
node scripts/migrations/20260930-project-visibility-membership-index.mjs > project-foundation-dry-run.json
```

Review all listed Project IDs and membership conflicts. A clean report may
include known Projects that need the default `PRIVATE` value; `clean: false`
means invalid Project data, malformed or cross-Organization membership,
duplicate membership pairs, or a conflicting index needs a separate reviewed
correction. This migration does not delete or merge duplicate memberships.

Only after a clean report is reviewed and both Project and Project Membership
writers are paused, an operator may apply that exact report:

```sh
node scripts/migrations/20260930-project-visibility-membership-index.mjs --apply --project-writes-paused --project-membership-writes-paused --expected-report-sha256=<reportSha256>
```

Apply sets only missing `projects.visibility` values to `PRIVATE`, creates the
existing schema-declared unique `(projectId, userId)` index when absent, and
verifies both conditions afterward. It is idempotent and does not change
existing `PRIVATE`/`PUBLIC` values, Project Membership records, or role
assignments. It binds the reviewed hash to the target endpoint and database,
without printing connection credentials. Do not apply it as part of this code
review; the migration PR must first be reviewed and the environment's dry-run
report must be clean.

## Platform incidents

The additive Platform incident storage is documented in
[`../../docs/work-packages/platform-incidents-storage-db-v1.md`](../../docs/work-packages/platform-incidents-storage-db-v1.md).
The report-first migration creates `platform_incidents`,
`platform_incident_history`, and `platform_incident_operations` with their
approved indexes. It does not migrate or delete existing records. The
idempotency key index is unique; the dry-run blocks duplicate key tuples and
incompatible collection/index objects.

Do not load `.env` for this migration. Provide the Mongo variables in the
invoking process, review the dry-run report and target fingerprint, then pass
the exact `reportSha256` to `--apply`. Rollback drops only the named incident
indexes and preserves every collection and record; stop or roll back the
incident API first so writes do not resume without their concurrency/index
guards.

## Platform user account lifecycle

The additive optional `archivedAt` and `archivedBy` fields on IAM `users` are
documented in
[`../../docs/work-packages/platform-user-account-lifecycle-db-v1.md`](../../docs/work-packages/platform-user-account-lifecycle-db-v1.md).
Existing documents remain valid, so this schema-only change needs no data
migration, index creation, or database apply. The backend must wait for this
schema branch to merge before writing archive metadata. Rollback requires
disabling the archive API and restoring archived users through the application
before removing the schema fields.

## Platform request trace lookup

`20261017-platform-request-trace-index.mjs` adds exact `requestId` and
`correlationId` lookup indexes to the existing `continuum_audit.audit_logs_iam`
collection. It refuses a missing or non-collection audit owner and never
creates the audit collection, changes validators, rewrites events, or drops
documents. Its report is target-bound and hash-bound; rollback drops only the
two exact named indexes.

```sh
npm run migrate:platform-request-trace-index
```

Review a clean report before applying its exact `reportSha256`:

```sh
npm run migrate:platform-request-trace-index -- --apply --expected-report-sha256=<reportSha256>
```

Rollback requires stopping the trace API first, then the reviewed rollback
report hash:

```sh
npm run migrate:platform-request-trace-index -- --rollback --expected-report-sha256=<reportSha256>
```

## Platform session fence and V2 authority schema

The additive Mongoose schema changes for optional refresh-session `sessionId`
and `userFence`, plus V1/V2 authority-operation validation, are documented in
[`../../docs/work-packages/platform-session-fence-and-v2-authority-schema-db-v1.md`](../../docs/work-packages/platform-session-fence-and-v2-authority-schema-db-v1.md).
They require no data migration or index command. Merge the DB schema branch
before enabling backend writes of V2 expansion records or session-fence fields.

## Project creator Team Leader bootstrap

The current creator bootstrap policy is documented in
[`../docs/decisions/project-creator-team-leader-bootstrap-v1.md`](../docs/decisions/project-creator-team-leader-bootstrap-v1.md).
Project creation assigns the creator the current project-scoped `TEAM_LEADER`
Role. The data migration promotes eligible existing creator assignments from
`MEMBER` to `TEAM_LEADER`; it changes no schema, indexes, collections, or
Project Membership records. The migration requires the current `TEAM_LEADER`
Role to provide `project.read`, `project.members.list`, `project.members.add`,
and `project.members.remove`.

First run a dry run against one explicitly selected Project in the intended
environment and save the complete JSON report:

```sh
node --env-file=.env scripts/migrations/20261019-project-creator-leader.mjs --project-id=<projectId> > project-creator-leader-dry-run.json
```

Review `databaseName`, `targetFingerprint`, `isSafe`, `plannedPromotions`,
`alreadyCompliant`, and `skippedProjects`. Apply only when the report is safe,
the target and planned RoleAssignment IDs are expected, and the current Role
has the required permissions. Pass the exact report hash and same Project ID:

```sh
npm run migrate:project-creator-leader -- --apply --project-id=<projectId> --expected-report-sha256=<reportSha256>
```

The apply mode refuses a missing or changed report hash, an unsafe plan, a
changed RoleAssignment, or a skipped Project. All planned RoleAssignment
updates run in one MongoDB transaction; a failed update aborts the transaction.
Use a MongoDB deployment that supports transactions. The script has no
automatic rollback mode. A successful promotion can be reverted only through
a separately reviewed, targeted operation using the exact prior Role IDs and
RoleAssignment IDs; do not infer rollback data from the role code alone. This
review did not execute the data migration.

## Project Settings Leader permissions

`20261019-project-settings-leader-permissions.mjs` provisions the missing
project settings permissions (`project.update`, `project.visibility.manage`) to
the system `TEAM_LEADER` Role in the IAM database.

The migration preserves existing permissions (`project.read`,
`project.members.list`, `project.members.add`, `project.members.remove`). It
makes no changes to users, projects, role assignments, role identity
(`code`, `name`, `isSystem`), collections, schemas, or indexes.

Database resolution strictly uses the canonical IAM resolver
(`resolveIamDatabaseName`). An explicit `--database` override must exactly
match that resolver's result. Shared mode resolves to `MONGODB_DATABASE`;
dedicated mode resolves to `continuum_iam`.

Dry-run is read-only and prints a credential-free target fingerprint, preflight
counts, planned permission additions, and `reportSha256`:

```powershell
node --env-file=.env scripts/migrations/20261019-project-settings-leader-permissions.mjs > 20261019-project-settings-leader-permissions-before.json
$before = Get-Content -LiteralPath '20261019-project-settings-leader-permissions-before.json' -Raw | ConvertFrom-Json
```

Confirm `databaseName`, `targetFingerprint`, the single system `TEAM_LEADER`
Role ID, the exact missing permissions, and an empty `issues` list before
applying that report:

```powershell
$receiptBytes = New-Object byte[] 32
$receiptRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$receiptRng.GetBytes($receiptBytes)
$env:PROJECT_SETTINGS_RECEIPT_KEY = [Convert]::ToBase64String($receiptBytes)
$receiptRng.Dispose()
node --env-file=.env scripts/migrations/20261019-project-settings-leader-permissions.mjs --apply "--expected-report-sha256=$($before.reportSha256)" > 20261019-project-settings-leader-permissions-applied.json
$applied = Get-Content -LiteralPath '20261019-project-settings-leader-permissions-applied.json' -Raw | ConvertFrom-Json
```

Apply is additive and idempotent. A successful `APPLIED` result includes an
`applyReceipt` containing the exact permission additions and the verified
post-apply permission snapshot, authenticated with an HMAC. Apply and rollback
require the same `PROJECT_SETTINGS_RECEIPT_KEY` (at least 32 bytes). Keep it in
an approved secret store or the same protected shell session; never put it in
the report or commit it.

For rollback, run and review a fresh dry-run for the current state. Rollback
requires the saved successful apply report and its separately reviewed receipt
HMAC. It verifies that the Role identity (`code`, `name`, `isSystem`) and full
permission list still match the post-apply snapshot before removing only the
permissions recorded as added by that apply. A forged report without the
receipt key, or any later Role identity or permission change, makes rollback
fail before the write:

```powershell
node --env-file=.env scripts/migrations/20261019-project-settings-leader-permissions.mjs > 20261019-project-settings-leader-permissions-current.json
$current = Get-Content -LiteralPath '20261019-project-settings-leader-permissions-current.json' -Raw | ConvertFrom-Json
node --env-file=.env scripts/migrations/20261019-project-settings-leader-permissions.mjs --rollback "--expected-report-sha256=$($current.reportSha256)" "--expected-apply-receipt-hmac=$($applied.result.applyReceipt.receiptHmac)" --rollback-from-report=20261019-project-settings-leader-permissions-applied.json
```

If the apply report or receipt is unavailable, or the Role permissions changed
after apply, the script refuses rollback; use a separately reviewed targeted
recovery procedure.
