# Organization Membership legacy backfill

The A-04 platform authority assignment collection and index migration is
documented in [20261005-platform-authority-assignments.README.md](20261005-platform-authority-assignments.README.md).

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
