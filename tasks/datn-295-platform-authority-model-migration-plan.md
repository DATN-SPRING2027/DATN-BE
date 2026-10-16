# DATN-295 — PLATFORM_OPERATOR Authority Model & Migration Plan & Execution Record

## Objective and Readiness

Add additive persistence and controlled application service support for the controlled PO-AUTH-01
grant/revoke procedure, preserving the current A-04 assignment model and all existing standalone
assignment records. This task does not add a public API, seed, backfill, assignment rewrite, or
legacy-row adoption.

**Status: Fix implemented; local checks complete with E2E environment failures.**
The mutation workflow stays disabled until an approved issuer and trusted MFA policy are implemented. No local, staging, or production database apply is claimed. See the [external gate evidence packet](datn-295-external-gate-evidence-template.md) for current gates and environment-specific runbooks.

---

## Verified Repository Baseline

- `src/services/iam/infrastructure/mongodb/mongodb.schemas.ts`: Declares the A-04 assignments, operation ledger, and permission-lock schemas.
- `src/services/iam/infrastructure/persistence.ts`: Declares the assignment and ledger indexes, ledger TTL index, and unique `(permission, scope)` lock index.
- `scripts/migrations/20261005-platform-authority-assignments.mjs`: Untouched legacy migration.
- `scripts/migrations/20261016-platform-authority-change-operations.mjs`: New additive migration with pure planner and hash guard.
- `src/services/iam/application/platform/platform-authority-change.service.ts`: Internal service that requires an authorization policy; IAM currently registers a default-deny policy.
- `src/services/iam/infrastructure/mongodb/platform-authority-change.repository.ts`: Transactional assignment + ledger + audit implementation with per-permission serialization.

---

## Implementation Summary & Task Execution

### Task 1 — Operation Contract Frozen
- Field names: `operationId`, `payloadHash`, `actorUserId`, `issuerUserId`, `operationType`, `targetUserId`, `permission`, `scope`, `auditEventId`, `status`, `httpStatus`, `resultBody`, `committedAt`, `expiresAt`.
- Deterministic SHA-256 payload canonicalization implemented in `hashPlatformAuthorityChangePayload`.
- Canonical V1 permissions strictly enforced: only `organization.create`, `platform.health.read`, and `platform.audit.read` at `PLATFORM` scope.
- The service checks executor/issuer separation and anti-self-grant, but an approved issuer workflow and trusted MFA evidence provider are not configured; the default provider returns 503 before repository execution.

### Task 2 — Ledger Schema & Persistence Declaration Added
- Schema declared in `mongodb.schemas.ts`.
- Persistence mapping added in `persistence.ts` with four indexes:
  - `platform_authority_operation_id` (unique)
  - `platform_authority_operation_target` (for fast target lookup)
  - `platform_authority_operation_actor` (for actor tracking)
- `platform_authority_operation_expiry` (365-day TTL on `expiresAt`). The TTL index is provisioned by the separate hardening migration and is not considered applied until verified in each target environment.

### Task 3 — Controlled Transactional Procedure Implemented
- Single MongoDB session transaction (`withTransaction`) atomically mutates `platform_authority_assignments`, writes to `platform_authority_change_operations`, and commits audit record to `continuum_audit.audit_logs_iam`.
- The repository transaction preserves assignment + ledger + audit atomicity.
- Last-operator checks count active users and serialize changes through one lock per permission. There is no break-glass override.
- Duplicate active grant rejection and CAS mismatch remain enforced; verify the behavior with the focused tests before handoff.

### Task 4 — Additive Migration Prepared
- Existing ledger migration remains unchanged.
- Added `20261016-platform-authority-change-hardening.mjs` to add the TTL index and seed permission locks using a fresh target-bound dry-run hash.
- Follow-up migration is additive and must run after the ledger migration. Its plan, tests, and runbook are in the corresponding hardening files.

### Task 5 — Verification & Quality Checks
- Focused IAM unit/type/schema/replica-set tests: 35 passed.
- Migration planner suite: 139 passed.
- `npm run lint`, `npm run typecheck`, dev DB smoke safety (25 passed), and `npm run build`: passed.
- Full Jest unit suite: 66 suites passed, 661 tests passed, 11 suites / 86 tests skipped.
- E2E: 3 suites failed (4 tests failed, 70 passed, 4 skipped). Failures were the existing `JWT_SECRET` startup timeout and Redis/BullMQ closed connections in health/default-entrypoint suites. `npm run check` therefore does not pass; Jest also retained open handles after reporting results.
- Branch diff review and secret/debug scan: completed before handoff.
- External database state and migration apply: unverified and not performed.

---

## Rollback & Risk Controls

1. Do not drop the ledger or audit records as a routine rollback. Keep both migrations additive and coordinate any code rollback with the database owner.
2. The permission lock collection and TTL index are runtime dependencies once changes are enabled. Do not remove them while the service can execute authority changes.
