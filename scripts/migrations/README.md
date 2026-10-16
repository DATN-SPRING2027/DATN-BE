# Organization Membership legacy backfill

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

The A-04 platform authority assignment collection and index migration is
documented in [20261005-platform-authority-assignments.README.md](20261005-platform-authority-assignments.README.md).
The additive platform authority change operations ledger collection and index migration is
documented in [20261016-platform-authority-change-operations.README.md](20261016-platform-authority-change-operations.README.md).
The follow-up TTL and permission-lock migration is documented in
[20261016-platform-authority-change-hardening.README.md](20261016-platform-authority-change-hardening.README.md).

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
