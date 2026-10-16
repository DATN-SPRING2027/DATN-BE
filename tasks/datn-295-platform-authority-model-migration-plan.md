# DATN-295 — PLATFORM_OPERATOR Authority Model & Migration Plan & Execution Record

## Objective and Readiness

Add additive persistence and controlled application service support for the controlled PO-AUTH-01
grant/revoke procedure, preserving the current A-04 assignment model and all existing standalone
assignment records. This task does not add a public API, seed, backfill, assignment rewrite, or
legacy-row adoption.

**Status: IMPLEMENTATION & VERIFICATION COMPLETE.**  
All 4 Gates have been addressed, implemented, and verified locally on MongoDB WiredTiger replica set.
Remote staging and production environments are documented in the [external gate evidence packet](datn-295-external-gate-evidence-template.md) with exact read-only inspection queries and dry-run execution runbooks.

---

## Verified Repository Baseline

- `src/services/iam/infrastructure/mongodb/mongodb.schemas.ts`: Declares `platform_authority_assignments` with only `organization.create`, `platform.health.read`, and `platform.audit.read` at `PLATFORM` scope, plus new additive schema `platform_authority_change_operations`.
- `src/services/iam/infrastructure/persistence.ts`: Declares the unique `(subjectUserId, permission, scope)` index and the new unique `operationId` index for `platform_authority_change_operations`.
- `scripts/migrations/20261005-platform-authority-assignments.mjs`: Untouched legacy migration.
- `scripts/migrations/20261016-platform-authority-change-operations.mjs`: New additive migration with pure planner and hash guard.
- `src/services/iam/application/platform/platform-authority-change.service.ts`: Controlled PO-AUTH-01 internal service.
- `src/services/iam/infrastructure/mongodb/platform-authority-change.repository.ts`: MongoDB transactional implementation ensuring assignment + ledger + audit atomicity.

---

## Implementation Summary & Task Execution

### Task 1 — Operation Contract Frozen
- Field names: `operationId`, `payloadHash`, `actorUserId`, `issuerUserId`, `operationType`, `targetUserId`, `permission`, `scope`, `auditEventId`, `status`, `httpStatus`, `resultBody`, `committedAt`, `expiresAt`.
- Deterministic SHA-256 payload canonicalization implemented in `hashPlatformAuthorityChangePayload`.
- Canonical V1 permissions strictly enforced: only `organization.create`, `platform.health.read`, `platform.audit.read` at `PLATFORM` scope. All other 37 operations fail closed with HTTP 422.
- Dual control (`actorUserId !== issuerUserId`) and anti-self-grant enforced.

### Task 2 — Ledger Schema & Persistence Declaration Added
- Schema declared in `mongodb.schemas.ts`.
- Persistence mapping added in `persistence.ts` with 3 indexes:
  - `platform_authority_operation_id` (unique)
  - `platform_authority_operation_target` (for fast target lookup)
  - `platform_authority_operation_actor` (for actor tracking)
- 365-day TTL index on `expiresAt`.

### Task 3 — Controlled Transactional Procedure Implemented
- Single MongoDB session transaction (`withTransaction`) atomically mutates `platform_authority_assignments`, writes to `platform_authority_change_operations`, and commits audit record to `continuum_audit.audit_logs_iam`.
- Verified rollback on audit failure.
- Verified CAS status mismatch rejection with HTTP 409.
- Verified last-operator protection and break-glass override.
- Verified duplicate active grant rejection with HTTP 409 (legacy row preservation).

### Task 4 — Additive Migration Prepared
- Pure planner implemented in `platform-authority-change-operations.plan.mjs`.
- 6 planner tests in `platform-authority-change-operations.plan.test.mjs` verifying clean creation, NOOP, duplicate keys, conflicting indexes, and malformed rows.
- Migration runner with `--dry-run` and `--apply --expected-report-sha256` in `20261016-platform-authority-change-operations.mjs`.
- Runbook and rollback instructions in `20261016-platform-authority-change-operations.README.md`.

### Task 5 — Verification & Quality Checks
- Unit test suite: 18/18 tests pass in `platform-authority-change.service.spec.ts`.
- Schema test suite: 4/4 tests pass in `platform-authority-change.schema.spec.ts`.
- Migration planner suite: 133/133 tests pass in `npm run test:migrations:plan`.
- Transaction integration suite: 8/8 tests pass on WiredTiger replica set in `platform-authority-change.mongodb.spec.ts`.
- Typecheck: `npm run typecheck` passes with 0 errors.

---

## Rollback & Risk Controls

1. **Empty Ledger Rollback:** If migration was applied but no operations committed, run `db.platform_authority_change_operations.drop()`.
2. **Post-Use Invariant:** If committed records exist, the ledger and audit logs are never dropped. Operational errors are remediated by issuing a compensating `REVOKED` operation with explicit audit attribution.
