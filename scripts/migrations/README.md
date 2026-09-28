# Organization Membership legacy backfill

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

The report lists every proposed record, users and organizations with no
organization-level legacy relationship, duplicate legacy assignments, invalid
or dangling relationships, and conflicts with existing memberships. A duplicate
legacy pair is informational because the mapping is unambiguous. `clean` is
false for invalid/dangling records or conflicting/duplicate existing
memberships; dry-run exits with code 2 then. Unmatched users or organizations
are reported and are never given an inferred membership.

Only after reviewing a clean report and checking that it targets the intended
database, stop all writers to legacy `role_assignments` and
`organization_memberships` for the duration of apply. The repository currently
has no application writer for either collection; external scripts or operators
must also be quiescent. Apply with the reported `reportSha256` and both explicit
quiescence assertions. The hash includes a fingerprint
of the exact MongoDB URI and database name without printing credentials:

```sh
node scripts/migrations/20260928-organization-memberships.mjs --apply --legacy-writes-paused --membership-writes-paused --expected-report-sha256=<reportSha256>
```

Apply rereads all source data and refuses to write if the report changed or is
not clean. It first creates the unique `(organizationId, userId)` index, then
rechecks the source before each `$setOnInsert` upsert. The source recheck is an
additional guard; it does not replace stopping concurrent legacy writers.
It reads each membership after upsert and fails if its status is not `ACTIVE`;
this check does not replace stopping concurrent membership writers.
Repeated runs do not duplicate memberships or
reactivate an existing non-`ACTIVE` membership. If an apply stops partway,
rerun dry-run and review the new hash before retrying. Keep the saved report as
migration evidence. Do not deploy Organization Context lookup until the
backfill has completed and been verified.
