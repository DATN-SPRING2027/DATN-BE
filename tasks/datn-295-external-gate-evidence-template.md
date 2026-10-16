# DATN-295 — External Gate Evidence Packet & Verification Record

This packet records the evidence, engineering decisions, and verification state for:
**Jira:** DATN-295 — `[PLATFORM][DB] PLATFORM_OPERATOR Authority Model & Migration`
**Repository:** `DATN_BE`
**Branch:** `feat/Thang-DATN-295-platform-authority-be-db`
**Execution Owner:** Thang

---

## 1. Executive Summary & Gate Status Overview

| Gate | Scope | Status | Evidence / Reference |
|---|---|---|---|
| **Gate 1: Security / IAM** | Trusted issuer authorization, fresh MFA evidence, anti-self-grant, last-operator protection | **OPEN / FAIL-CLOSED** | No approved issuer/MFA policy is wired. The IAM provider denies changes with 503 until that policy is implemented. Last-operator revocation is serialized and has no break-glass bypass. |
| **Gate 2: Audit / Privacy / Legal** | Atomic assignment + ledger + audit writes and 365-day ledger retention | **PARTIAL** | Repository transaction and audit rollback behavior are implemented. The TTL index requires the follow-up hardening migration and is not claimed as applied to any environment. |
| **Gate 3: Permission Boundary** | Three A-04 permission allowlist | **IMPLEMENTED / POLICY INVENTORY OPEN** | Runtime allowlist is the three permissions in `authorization.policy.ts`. Additional permissions require a separate decision. |
| **Gate 4: DB Reality (Local)** | Database inspection and migration state | **UNVERIFIED** | This change did not inspect or modify a live database. Use the target-specific dry-run reports below before any apply. |
| **Gate 4: DB Reality (Staging/Prod)** | Staging & Production cluster read-only inspection | **UNVERIFIED** | No environment was inspected or modified. The packet provides target-specific dry-run and apply steps for an authorized IAM database owner. |

---

## 2. Gate 1 — Security & IAM Verification

### 2.1 Principals & Two-Person Control (Dual Control)
- **Issuer and executor roles:** Not defined by DEC-ACCESS-09; do not treat role names in earlier drafts as approved identities.
- **Dual Control Enforcement:** The service checks `actorUserId !== issuerUserId`, but trusted issuer authorization is not implemented. The default policy denies all mutations until that workflow is approved and wired.
- **Anti-Self-Grant Enforcement:** For `GRANT` operations, the service verifies `targetUserId !== actorUserId` and `targetUserId !== issuerUserId`. Self-granting platform operator privileges is unconditionally blocked.

### 2.2 Identity Verification & MFA Proof
- No trusted MFA proof or issuer authorization provider is currently implemented for this mutation workflow. `mfaVerified` and `twoFactorEnabled` are not accepted as proof; the default authorization policy returns HTTP 503 and does not call the repository.
- The repository verifies that actor and issuer accounts are active and that a grant target is active. Active-user flags do not substitute for issuer or MFA authorization.

### 2.3 Last-Operator Protection
- Revocation is blocked with HTTP 409 when it would leave no active user with that permission.
- Mutations for a permission increment the same lock record inside the MongoDB transaction, serializing the count-and-revoke sequence.
- No break-glass path is implemented or approved. A command flag cannot bypass the invariant.

### 2.4 Legacy A-04 Record Protection
- **Preservation Invariant:** All existing standalone records in `platform_authority_assignments` are preserved byte-for-byte.
- **Duplicate Protection:** Attempting to `GRANT` authority to a target who already possesses an `ACTIVE` assignment for `(subjectUserId, permission, scope)` immediately aborts with HTTP 409 Conflict (`AUTHORITY_ALREADY_ACTIVE`). No silent adoption or rewriting occurs.

---

## 3. Gate 2 — Audit, Privacy & Legal Verification

### 3.1 Required Audit Events & Schema
- **Audit Target Collection:** `continuum_audit.audit_logs_iam`
- **Actions:**
  - `platform.authority.granted` (on grant)
  - `platform.authority.revoked` (on revoke)
- **Target Resource:** Explicitly set to `'PLATFORM_AUTHORITY'` to satisfy the query boundary of `MongoPlatformAuditRepository`.
- **Payload & Actor Tracing:** The audit event stores `eventId`, `operationId`, actor/issuer/target IDs, action, permission, scope, `metadata.before/after/reasonCode`, and `occurredAt`. `payloadHash` and `auditEventId` are fields in the operation ledger; the ledger's `auditEventId` links to the audit event's `eventId`.

### 3.2 Transactional Atomicity Invariant
- **Atomic Boundary:** The following three writes execute within a single MongoDB client session transaction (`withTransaction`):
  1. `platform_authority_assignments` (state creation or update)
  2. `platform_authority_change_operations` (idempotency ledger record)
  3. `continuum_audit.audit_logs_iam` (audit log entry)
- **Rollback Behavior:** If the audit write fails or is rejected, the entire transaction rolls back immediately. The assignment change is aborted, no ledger entry is committed, and HTTP 500 is returned.
- **Test Evidence:** Verified by test case `rolls back entire transaction if audit log write fails` in `platform-authority-change.mongodb.spec.ts`.

### 3.3 Privacy & Data Redaction Policy
- **Sensitive Data Exclusion:** The operation ledger and audit events store user identifiers, permission strings, timestamps, and SHA-256 payload hashes. They do not store email addresses, passwords, access tokens, or session cookies; user identifiers remain pseudonymous personal data.
- **Retention Schedule:** The application sets ledger `expiresAt` to 365 days after commit. The TTL index is added by `20261016-platform-authority-change-hardening.mjs`; retention is not active in an environment until that migration is applied and verified.

---

## 4. Gate 3 — Runtime Permission Boundary

Only `organization.create`, `platform.health.read`, and `platform.audit.read` are in the current runtime allowlist. The earlier 37-entry draft catalog was removed because its dispositions were not approved by DEC-ACCESS-09. The current service rejects permissions outside the allowlist with HTTP 403. Add further permissions only after a separate decision.

## 5. Gate 4 — DB Reality & Verification Evidence

### 5.1 Local Verification Record
- **Status:** No live database inspection or migration apply is claimed by this change.
- The replica-set integration test uses a disposable in-memory MongoDB and verifies transaction behavior only. It does not establish the state of a developer, staging, or production database.
- The operations-ledger migration and the follow-up hardening migration each require a fresh dry-run report and target-specific SHA-256 before apply.

### 5.2 Staging and Production
- **Status:** **UNVERIFIED**. No staging or production database was inspected or changed.
- An authorized IAM database owner should run both migrations in order, review the database name, target fingerprint, duplicate/invalid record findings, and index plan, then apply only with the hash from that same environment's dry-run report.
- Do not reuse a hash across environments or after the database state changes.

```powershell
# First provision the operation ledger if it is not already present.
node scripts/migrations/20261016-platform-authority-change-operations.mjs > platform-authority-operations-dry-run.json
$operations = Get-Content -LiteralPath 'platform-authority-operations-dry-run.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261016-platform-authority-change-operations.mjs --apply "--expected-report-sha256=$($operations.reportSha256)"

# Then add ledger TTL and the per-permission transaction locks.
node scripts/migrations/20261016-platform-authority-change-hardening.mjs > platform-authority-hardening-dry-run.json
$hardening = Get-Content -LiteralPath 'platform-authority-hardening-dry-run.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261016-platform-authority-change-hardening.mjs --apply "--expected-report-sha256=$($hardening.reportSha256)"
```

Run each dry-run and apply separately. Review the report and obtain the required operational authorization before applying to a shared environment.

---

## 6. Implementation Architecture & Invariants

### 6.1 Idempotency & CAS Specification
- **Idempotency Key:** `operationId` (UUID string), indexed uniquely.
- **Canonical Payload Hashing:** `actorUserId`, `issuerUserId`, `operationType`, `targetUserId`, `permission`, `scope`, `expectedCurrentStatus`, `expiresAt`, and `reasonCode` are canonicalized and hashed with SHA-256. Caller-supplied MFA or break-glass flags are not part of the command contract.
- **Replay Semantics:**
  - Same `operationId` + same `payloadHash`: Returns previously committed result (`status: 'COMMITTED'`, same HTTP status and body). No re-execution, no duplicate writes.
  - Same `operationId` + different `payloadHash`: Throws HTTP 409 Conflict (`OPERATION_ID_PAYLOAD_MISMATCH`).
- **Compare-And-Set (CAS):** If the command provides `expectedCurrentStatus`, the repository checks the actual status of the current assignment in `platform_authority_assignments`. If mismatched (e.g. expected `REVOKED` but current is `ACTIVE`), it immediately aborts with HTTP 409 Conflict (`CAS_STATUS_MISMATCH`).

### 6.2 Rollback Plan
- Keep the ledger and audit records; do not delete committed audit evidence.
- Treat the TTL index and permission lock collection as runtime dependencies after enabling the workflow. Coordinate any code rollback with the database owner and do not remove these dependencies while mutations can run.
- The mutation workflow currently remains disabled until its issuer and MFA authorization policy is approved and implemented.
