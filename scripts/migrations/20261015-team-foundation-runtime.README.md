# DATN-90 — Team metadata schema and migration

This database change adds the selected Team metadata and lifecycle validation
to the IAM-owned `continuum_iam.teams` collection, plus its scoped unique code
index. It does not create idempotency command-result storage or Team-specific
audit artifacts. TQ-09 command-result persistence remains gated on provider,
all-writer and ambiguous-commit recovery evidence; TQ-10 Team audit mapping,
deduplication and atomicity remain deferred. This migration does not connect to,
read, write, create collections in, or create indexes in `continuum_audit`.

## Schema and index

- `teams`: explicit `status`, `version`, and archive metadata; canonical name,
  code, description, and archive validation. No inferred defaults are added.
- `organizationId`, `projectId`, and `code` are immutable in persisted Mongoose
  documents and Mongoose updates. The migration may set explicitly reviewed
  legacy mappings before runtime writes are enabled.
- `teams`: unique `{ organizationId: 1, projectId: 1, code: 1 }`, including
  archived records.
- No `team_operations` collection, idempotency index/TTL, or Team audit event
  index is included in this slice.

## Existing Team data

The migration never assumes a legacy Team is active, assigns version 1, fills
nullable metadata, normalizes a name/code, or fabricates archive metadata. If a
row lacks any required runtime value, a dry-run reports only its object ID and
field. An operator must provide a reviewed Extended JSON mapping with explicit
values for those rows. Mapped values are validated against the schema and
parent relationship before any write. Code collisions, index drift,
non-collection namespace conflicts, and missing parents stop the migration
before it writes.

The mapping is local operator input and must not be committed if it contains
real record values. Each write uses the scanned Team values as a compare-and-set
filter and only sets explicitly mapped fields. The script does not delete rows,
drop indexes, rename fields, or cascade to memberships/content references.

## Commands

Run a dry-run only after the database target is separately authorized:

```powershell
node scripts/migrations/20261015-team-foundation-runtime.mjs --dry-run --database continuum_iam --mapping-file=C:\path\to\reviewed-team-map.ejson
```

Before every apply, a database operator must create a backup or PITR recovery
point for the exact `continuum_iam` target and verify that it can be restored to
an isolated environment. Record the target, recovery-point identifier/time,
restore verification, mapping hash, and reviewed dry-run hash in the change
record. Keep the reviewed mapping and report private when they contain real
record values. Do not apply while Team writers are active unless the writer
inventory and concurrency plan for that target have been verified.

Apply requires the exact SHA-256 from the reviewed dry-run report. The script
rescans and compares the report hash immediately before writing, then verifies
the result:

```powershell
node scripts/migrations/20261015-team-foundation-runtime.mjs --apply --database continuum_iam --mapping-file=C:\path\to\reviewed-team-map.ejson --expected-report-sha256=<reviewed-report-sha256>
```

The report contains counts, issue IDs/fields, Team index actions, and
fingerprints; it does not print credentials, Team names/descriptions, archive
reasons, or mapping values. The scan is bounded by the existing migration scan
budget. If interrupted or if a mapping is found to be wrong, do not blindly
retry the same mapping: stop Team writers, preserve the report and mapping hash,
restore the pre-apply recovery point into an isolated database, and use it to
derive and review corrected values. Then run a fresh dry-run against the target
and apply a reviewed forward correction with its new report hash before
resuming writers.

## Rollback and recovery impact

There is no automatic down migration. An apply may overwrite fields explicitly
listed in a mapping, create the `teams` collection, and create the scoped unique
index. The report intentionally does not retain previous field values, so it
cannot reconstruct them for an in-place rollback. Dropping the unique index
would remove the Team code invariant. Prefer an isolated PITR restore followed
by a reviewed forward correction; restoring over a live target can discard
writes made after the recovery point and requires a separate approved recovery
plan. This PR has not been applied to any shared, staging, or production
database.

## Checks and remaining rollout evidence

```powershell
node --test scripts/migrations/team-foundation-runtime.plan.test.mjs
node --test scripts/dev/initialize-service-owned-databases.test.mjs
npm run check
```

Schema and plan tests use synthetic data. They do not prove Team parent-writer
coverage, admission freshness, ambiguous-commit recovery, or external transport
behavior. No role or permission grant is seeded by this DB change.
