# Platform Incidents Storage V1

**Branch:** `feat/Thang-platform-operator-incidents-db`
**Base:** updated `origin/main` at `df87910c3fc8e85f11e50f105d1b4c772bba3887`
**Scope:** additive IAM collections and indexes for the Platform Incident
domain. This database work is coordinated with the separate backend
implementation branch.

## Storage contract

The IAM database adds three collections:

- `platform_incidents`: current incident state, severity, affected service,
  optimistic version and actor/timestamps.
- `platform_incident_history`: append-only state and note history, ordered by
  incident and occurrence time.
- `platform_incident_operations`: idempotency ledger keyed by actor and
  SHA-256 idempotency-key hash. The raw client key is never persisted.

The backend owns the allowed status transitions (`OPEN` → `ACKNOWLEDGED` →
`RESOLVED`) and severity/service validation. This migration creates no records
and does not infer status, severity, service ownership, or history for existing
data.

## Migration behavior

New file: `scripts/migrations/20261017-platform-incidents-storage.mjs`.
Planner and tests: `scripts/migrations/platform-incidents.plan.mjs` and
`platform-incidents.plan.test.mjs`.

The dry-run reports the fixed IAM database name, a credential-free target
fingerprint, collection types/counts, exact index actions, duplicate
idempotency tuples, issues and `reportSha256`. It blocks non-collection name
collisions, incompatible same-name/equivalent indexes, and duplicate tuples
before adding the unique actor/key index. Apply requires the hash from the
reviewed report and creates only the three collections and five named indexes.
It does not update or delete documents.

Example with explicit process variables (the script does not load `.env`):

```powershell
$env:MONGODB_URI = '<approved MongoDB URI>'
$env:INFRA_ENABLED = 'true'
$env:MONGODB_ENABLED = 'false'
npm run migrate:platform-incidents
```

After reviewing the target and clean report, apply only that report:

```powershell
$report = Get-Content -LiteralPath 'platform-incidents-dry-run.json' -Raw | ConvertFrom-Json
npm run migrate:platform-incidents -- --apply "--expected-report-sha256=$($report.reportSha256)"
```

Do not run migration apply as part of the code task. Shared-environment
application requires the DB owner to review the target-specific dry-run and
coordinate with the backend rollout.

## Rollback and operational impact

Rollback is index-only. First disable/roll back the incident API so writes stop,
then review a fresh `--rollback` report and pass its exact hash. The script
drops only the five named indexes; it preserves the collections and all
incident, history, and operation documents. Without the unique idempotency
index, concurrent duplicate commands are unsafe, so do not re-enable the API
until the indexes are restored and verified.

No live database was inspected or modified by this work package. No production
data, credentials, tenant content, or secrets are included in reports.

## Validation

- `node --test scripts/migrations/platform-incidents.plan.test.mjs`
- `node --check scripts/migrations/20261017-platform-incidents-storage.mjs`
- `npm run typecheck`

These checks validate the plan/schema code only. No migration apply or live
MongoDB rollout is claimed.
