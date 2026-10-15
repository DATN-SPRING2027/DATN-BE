# DATN-90 — Team runtime schema and index migration

This DB change adds the selected Team metadata/lifecycle validation, the durable
`team_operations` collection for the DATN-90 idempotency contract, and the
partial unique audit dedupe index used by the same-session Team mutation path.
The IAM database remains `continuum_iam`; IAM audit records remain in
`continuum_audit.audit_logs_iam`.

## Schema and indexes

- `teams`: explicit `status`, `version`, and archive metadata; canonical name,
  code, description, and archive validation. There are no inferred defaults.
- `teams`: unique `{ organizationId: 1, projectId: 1, code: 1 }`, including
  archived records.
- `team_operations`: unique `{ organizationId: 1, actorUserId: 1, keyHash: 1 }`
  and single-field TTL `{ expiresAt: 1 }` with `expireAfterSeconds: 0`. Expiry
  checks and slot replacement remain application logic; TTL is cleanup only.
- `audit_logs_iam`: partial unique
  `{ organizationId: 1, metadata.commandId: 1, action: 1, targetResourceId: 1 }`
  for Team events with a command ID. It adds no TTL and does not delete or
  rewrite existing audit records.

## Existing Team data

The migration never assumes a legacy Team is active, assigns version 1, fills
nullable metadata, normalizes a name/code, or fabricates archive metadata. If a
row lacks any required runtime value, a dry-run reports only its object ID and
field. An operator must provide a reviewed Extended JSON mapping with explicit
values for those rows. Mapped values are validated against the schema and
parent relationship before any write. Code collisions, duplicate command
scopes, index drift, non-collection namespace conflicts, and missing parents
stop the migration before it writes.

The mapping is local operator input and must not be committed if it contains
real record values. Each write uses the scanned Team values as a compare-and-set
filter and only sets explicitly mapped fields. The script does not delete rows,
drop indexes, rename fields, or cascade to memberships/content references.

## Commands

Dry-run only after an authorized database target has been separately selected:

```powershell
node scripts/migrations/20261015-team-foundation-runtime.mjs --dry-run --database continuum_iam --mapping-file=C:\path\to\reviewed-team-map.ejson
```

Apply requires the exact SHA-256 from the reviewed dry-run report. It rescans
and compares the report hash immediately before writing, then verifies the
result:

```powershell
node scripts/migrations/20261015-team-foundation-runtime.mjs --apply --database continuum_iam --mapping-file=C:\path\to\reviewed-team-map.ejson --expected-report-sha256=<reviewed-report-sha256>
```

The report contains counts, issue IDs/fields, index actions, and fingerprints;
it does not print credentials, Team names/descriptions, archive reasons, or
mapping values. The scan is bounded by the existing migration scan budget.
Migration updates are idempotent; if interrupted, take a new dry-run before
retrying. No shared, staging, or production database was accessed for this
change. The migration has not been applied.

## Checks and remaining rollout evidence

```powershell
node --test scripts/migrations/team-foundation-runtime.plan.test.mjs
node --test scripts/dev/initialize-service-owned-databases.test.mjs
npm run check
```

Schema and plan tests use synthetic data. They do not prove cross-database
transaction behavior, Team parent-writer coverage, admission freshness,
ambiguous-commit recovery, or external transport behavior. The mutation code
checks for these collections and indexes and fails closed when they are absent.
No role or permission grant is seeded by this DB change.
