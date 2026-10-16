# DATN-295 — Platform Operator Authority Lifecycle

## Current Status

The working-tree follow-up addresses the remaining code-level findings for the
PO-AUTH-01 lifecycle. The workflow remains fail-closed until the external
Security/IAM and Audit/Privacy/Legal approvals are supplied and the required
read-only database evidence is reviewed. No live database was inspected or
changed.

The canonical external-gate record is
[`datn-295-external-gate-evidence-template.md`](datn-295-external-gate-evidence-template.md).

## Implemented Contract

- Every `BOOTSTRAP`, `REGRANT`, and `REVOKE` applies the complete A-04 bundle:
  `organization.create`, `platform.health.read`, and `platform.audit.read`.
- `operationId` must be a UUID. Each action has one fixed reason code, and the
  service rejects caller-selected single-permission or partial-bundle fields.
- The assignment rows, operation ledger entry, audit event, and shared lifecycle
  lock write occur in one MongoDB transaction. The lock serializes mutations
  across the entire bundle.
- Revocation requires another `ACTIVE` user to hold all three current,
  unexpired permissions. There is no break-glass bypass.
- Regrant and revoke require all three rows and matching committed grant
  provenance. Incomplete or legacy bundles fail closed and are not adopted or
  rewritten.
- Operation-ledger retention remains unapproved. Runtime and the current
  persistence declaration do not add a ledger TTL or expiry field. Assignment
  expiry remains a separate runtime permission boundary.

## Database Migration

The committed per-permission-lock/365-day-TTL migration is historical and must
not be run for the current contract. The additive
`20261016-platform-authority-change-v2-lifecycle.mjs` migration is dry-run by
default. It plans the shared lifecycle lock and current bundle lookup index,
redacts record identifiers in its report, and removes only the exact proposed
TTL index if an authorized database owner later applies it.

Do not run or apply any migration until the external approval gates and
target-specific read-only staging/production evidence in the canonical
contract are complete. Dropping a TTL index cannot restore documents already
expired by MongoDB; live retention and database state remain unverified.

## Validation for This Follow-up

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `node --check scripts/migrations/20261016-platform-authority-change-v2-lifecycle.mjs`:
  passed.
- `git diff --check`: passed; Git reported only existing CRLF-to-LF notices.
- Test suites, build, live database inspection, and migration apply were not
  run for this follow-up.

## Handoff

- Repository: `DATN_BE`
- Branch: `feat/Thang-DATN-295-platform-authority-be-db`
- Changes are recorded in the branch history.
- External blockers: signed Security/IAM and Audit/Privacy/Legal approvals plus
  read-only staging/production reports are still required before review or
  migration execution.
