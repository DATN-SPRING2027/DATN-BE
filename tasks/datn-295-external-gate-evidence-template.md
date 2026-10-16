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
| **Gate 2: Audit / Privacy / Legal** | Atomic three-assignment bundle + ledger + audit writes; retention policy | **PARTIAL / EXTERNAL APPROVAL REQUIRED** | Each operation now carries the fixed A-04 bundle and writes all assignment rows, ledger, and audit in one transaction. No 365-day expiry is set in runtime code; retention approval is still open. |
| **Gate 3: Permission Boundary** | Exactly the three A-04 permissions as one bundle | **IMPLEMENTED / POLICY INVENTORY OPEN** | The caller cannot select one permission. The fixed bundle remains the three entries in `authorization.policy.ts`. |
| **Gate 4: DB Reality (Local)** | Database inspection and migration state | **UNVERIFIED** | This change did not inspect or modify a live database. Use the target-specific dry-run reports below before any apply. |
| **Gate 4: DB Reality (Staging/Prod)** | Staging & Production cluster read-only inspection | **UNVERIFIED** | No environment was inspected or modified. Do not run or apply a migration until the external approval and target-specific read-only report are attached. |

---

## 2. Gate 1 — Security & IAM Verification

### 2.1 Principals & Two-Person Control (Dual Control)
- **Issuer and executor roles:** Not defined by DEC-ACCESS-09; do not treat role names in earlier drafts as approved identities.
- **Dual Control Enforcement:** The service checks `actorUserId !== issuerUserId`, but trusted issuer authorization is not implemented. The default policy denies all mutations until that workflow is approved and wired.
- **Anti-Self-Grant Enforcement:** For `BOOTSTRAP` and `REGRANT`, the service verifies `targetUserId !== actorUserId` and `targetUserId !== issuerUserId`. Self-granting platform operator privileges is unconditionally blocked.

### 2.2 Identity Verification & MFA Proof
- No trusted MFA proof or issuer authorization provider is currently implemented for this mutation workflow. `mfaVerified` and `twoFactorEnabled` are not accepted as proof; the default authorization policy returns HTTP 503 and does not call the repository.
- The repository verifies that actor and issuer accounts are active and that a grant target is active. Active-user flags do not substitute for issuer or MFA authorization.

### 2.3 Last-Operator Protection
- Revocation is blocked with HTTP 409 unless another `ACTIVE` user retains all three current, unexpired A-04 permissions.
- Every lifecycle action increments one shared lock record inside the MongoDB transaction, serializing changes across all three permissions.
- No break-glass path is implemented or approved. A command flag cannot bypass the invariant.

### 2.4 Legacy A-04 Record Protection
- **Preservation Invariant:** Existing standalone records in `platform_authority_assignments` are not adopted or rewritten. Any bundle without matching operation-ledger provenance fails with HTTP 409 (`LEGACY_ASSIGNMENT_CONFLICT`).
- **Duplicate Protection:** `BOOTSTRAP` refuses if any A-04 assignment already exists for the target. `REGRANT` and `REVOKE` require the complete three-row bundle and matching committed grant provenance.

---

## 3. Gate 2 — Audit, Privacy & Legal Verification

### 3.1 Required Audit Events & Schema
- **Audit Target Collection:** `continuum_audit.audit_logs_iam`
- **Actions:**
  - `platform.authority.granted` (on grant)
  - `platform.authority.revoked` (on revoke)
- **Target Resource:** Explicitly set to `'PLATFORM_AUTHORITY'` to satisfy the query boundary of `MongoPlatformAuditRepository`.
- **Payload & Actor Tracing:** The audit event stores `eventId`, `operationId`, actor/issuer/target IDs, action, all three permissions, all assignment IDs, scope, `metadata.before/after/reasonCode`, and `occurredAt`. The ledger stores the fixed permission bundle, `payloadHash`, and `auditEventId`.

### 3.2 Transactional Atomicity Invariant
- **Atomic Boundary:** The following writes execute within one snapshot-read, majority-commit MongoDB session transaction: all three `platform_authority_assignments` rows, one `platform_authority_change_operations` ledger row, and one `continuum_audit.audit_logs_iam` event.
- **Rollback Behavior:** If the audit write fails or is rejected, the entire transaction rolls back immediately. The assignment change is aborted, no ledger entry is committed, and HTTP 500 is returned.
- **Test Evidence:** The repository has a rollback integration case in `platform-authority-change.mongodb.spec.ts`; this follow-up change has not been validated against a live database.

### 3.3 Privacy & Data Redaction Policy
- **Sensitive Data Exclusion:** The operation ledger and audit events store user identifiers, permission strings, timestamps, and SHA-256 payload hashes. They do not store email addresses, passwords, access tokens, or session cookies; user identifiers remain pseudonymous personal data.
- **Retention Schedule:** No retention period is approved. Runtime code no longer sets ledger expiry or declares a TTL index. Existing database state is UNVERIFIED; the additive `20261016-platform-authority-change-v2-lifecycle.mjs` report must be reviewed by the DB owner before any apply.

---

## 4. Gate 3 — Runtime Permission Boundary

The fixed bundle is exactly `organization.create`, `platform.health.read`, and `platform.audit.read`. PO-AUTH-01 cannot accept a caller-selected permission or partial bundle. The earlier 37-entry draft catalog remains excluded.

## 5. Gate 4 — DB Reality & Verification Evidence

### 5.1 Local Verification Record
- **Status:** No live database inspection or migration apply is claimed by this change. Migration and runtime changes remain pending the external gates in the canonical contract.
- The replica-set integration test uses a disposable in-memory MongoDB and verifies transaction behavior only. It does not establish the state of a developer, staging, or production database.
- The operations-ledger, shared-lock, and retention-suspension migrations require approval and a fresh redacted, target-specific report/hash before an authorized DB owner may apply them.

### 5.2 Staging and Production
- **Status:** **UNVERIFIED**. No staging or production database was inspected or changed.
- An authorized IAM database owner must first supply the signed Security/IAM and Audit/Privacy/Legal approvals and a read-only staging/production report. Only then may the owner review the redacted migration plan and decide whether an apply is authorized.
- Do not reuse a hash across environments or after the database state changes.

```powershell
# After external approvals and read-only DB evidence, the authorized DB owner
# decides which target-specific dry-run and apply commands are appropriate.
# Do not execute migration commands while any approval gate remains open.
```

Run each dry-run and apply separately. Review the report and obtain the required operational authorization before applying to a shared environment.

---

## 6. Implementation Architecture & Invariants

### 6.1 Idempotency & CAS Specification
- **Idempotency Key:** `operationId` (UUID string), indexed uniquely.
- **Canonical Payload Hashing:** `actorUserId`, `issuerUserId`, `operationType`, `targetUserId`, the fixed three-permission bundle, `scope`, `expectedCurrentStatus`, `expiresAt`, and fixed action-specific `reasonCode` are canonicalized and hashed with SHA-256. Caller-supplied permission selections, MFA, or break-glass flags are not part of the command contract.
- **Replay Semantics:**
  - Same `operationId` + same `payloadHash`: Returns previously committed result (`status: 'COMMITTED'`, same HTTP status and body). No re-execution, no duplicate writes.
  - Same `operationId` + different `payloadHash`: Throws HTTP 409 Conflict (`IDEMPOTENCY_KEY_REUSED`).
- **Compare-And-Set (CAS):** `expectedCurrentStatus` applies to the complete permission bundle; stale or partial state aborts with HTTP 409.

### 6.2 Rollback Plan
- Keep the ledger and audit records; do not delete committed audit evidence.
- Keep the operation ledger and audit records. Retention remains undecided; do not add a TTL index until the required policy is signed. The lifecycle lock collection is required before any enabled mutation.
- The mutation workflow currently remains disabled until its issuer and MFA authorization policy is approved and implemented.
