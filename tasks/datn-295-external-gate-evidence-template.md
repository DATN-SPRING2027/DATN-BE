# DATN-295 — External Gate Evidence Packet & Verification Record

This packet records the evidence, engineering decisions, and verification state for:
**Jira:** DATN-295 — `[PLATFORM][DB] PLATFORM_OPERATOR Authority Model & Migration`  
**Repository:** `DATN_BE`  
**Branch:** `feat/Thang-DATN-295-platform-authority-db`  
**Execution Owner:** Thang  

---

## 1. Executive Summary & Gate Status Overview

| Gate | Scope | Status | Evidence / Reference |
|---|---|---|---|
| **Gate 1: Security / IAM** | Issuer/executor separation, anti-self-grant, MFA verification, last-operator protection, break-glass recovery | **CLOSED** | Implemented in `PlatformAuthorityChangeService` & `MongoPlatformAuthorityChangeRepository`; verified by 26 automated unit & replica-set tests. |
| **Gate 2: Audit / Privacy / Legal** | Atomic transaction across assignment + ledger + audit log, 365-day TTL retention, sensitive field redaction, audit-fail rollback | **CLOSED** | Implemented with atomic cross-collection session transaction to `continuum_audit.audit_logs_iam`; verified by test `rolls back entire transaction if audit log write fails`. |
| **Gate 3: Operation Disposition** | Canonical V1 3-permission catalog vs 37 non-active operations disposition | **CLOSED** | 40-operation inventory defined. 3 active permissions whitelisted; 37 operations categorized with rationales and runtime fail-closed enforcement (HTTP 422). |
| **Gate 4: DB Reality (Local)** | Local MongoDB environment inspection, schema, indexes, dry-run fingerprint | **CLOSED** | Inspected. Collection `platform_authority_change_operations` verified missing prior to migration; dry-run executed with plan SHA-256 `8d9eb3cc00f0df68cef68020ee4d40f927f496d30bb7d21c1a33eaedb6bf1879`. |
| **Gate 4: DB Reality (Staging/Prod)** | Staging & Production cluster read-only inspection | **UNVERIFIED (Gated for Ops)** | Technical access limitation documented with zero fabrication. Complete verification runbook and dry-run commands provided for IAM DB Owner. |

---

## 2. Gate 1 — Security & IAM Verification

### 2.1 Principals & Two-Person Control (Dual Control)
- **Issuer Principal:** `Platform Security Lead` / `IAM Custodian` role representing the authorizing authority.
- **Executor Principal:** `IAM Infrastructure Operator` / `System Administrator` role executing the command.
- **Dual Control Enforcement:** The service strictly asserts `actorUserId !== issuerUserId`. A single individual cannot both authorize and execute a platform authority change.
- **Anti-Self-Grant Enforcement:** For `GRANT` operations, the service verifies `targetUserId !== actorUserId` and `targetUserId !== issuerUserId`. Self-granting platform operator privileges is unconditionally blocked.

### 2.2 Identity Verification & MFA Proof
- **Identity Proof:** Principal identification relies on immutable IdP claims (`iss` + `sub` token binding).
- **MFA Requirement:** Commands require explicit proof of fresh multi-factor authentication:
  - `mfaVerified: true`
  - `mfaAuthTime` must be within a 15-minute window (`MAX_MFA_AGE_MS = 15 * 60 * 1000`).
  - Stale or missing MFA proofs reject with HTTP 403 Forbidden.
- **Active User Checks:** Both `actorUserId`, `issuerUserId`, and `targetUserId` must resolve to active users in `users` collection (`status: 'ACTIVE'`).

### 2.3 Last-Operator Protection & Break-Glass Recovery
- **Last-Operator Invariant:** A PLATFORM_OPERATOR revocation cannot leave the platform with zero active operators for a given permission and scope.
- **Sole Operator Protection:** If `activeAssignmentCount <= 1` for the target `(permission, scope)`, revocation is blocked with HTTP 409 Conflict (`LAST_OPERATOR_REVOCATION_PROHIBITED`).
- **Break-Glass Path:** In an emergency (e.g., operator credential compromise), revoking the sole operator is allowed **only** when `breakGlass: true` is explicitly provided alongside a mandatory `reason` citing an emergency incident ticket. This emits a high-severity audit log.

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
- **Payload & Actor Tracing:** Every audit document includes `auditEventId`, `action`, `actorUserId`, `issuerUserId`, `targetUserId`, `permission`, `scope`, `payloadHash`, `timestamp`, and `metadata` containing change rationale and incident references.

### 3.2 Transactional Atomicity Invariant
- **Atomic Boundary:** The following three writes execute within a single MongoDB client session transaction (`withTransaction`):
  1. `platform_authority_assignments` (state creation or update)
  2. `platform_authority_change_operations` (idempotency ledger record)
  3. `continuum_audit.audit_logs_iam` (audit log entry)
- **Rollback Behavior:** If the audit write fails or is rejected, the entire transaction rolls back immediately. The assignment change is aborted, no ledger entry is committed, and HTTP 500 is returned.
- **Test Evidence:** Verified by test case `rolls back entire transaction if audit log write fails` in `platform-authority-change.mongodb.spec.ts`.

### 3.3 Privacy & Data Redaction Policy
- **Sensitive Data Exclusion:** The operation ledger and audit events store only opaque identifiers (`userId`), permission strings, timestamps, and SHA-256 payload hashes. No passwords, tokens, private session cookies, or PII are written to the database.
- **Retention Schedule:** `platform_authority_change_operations` defines a 365-day TTL index on `expiresAt` (`{ expireAfterSeconds: 0 }`), ensuring automatic lifecycle cleanup compliant with data minimization policies.

---

## 4. Gate 3 — Operation Disposition (40-Operation Catalog)

Per canonical scope, the runtime permission catalog for V1 is strictly limited to the 3 A-04 permissions. The remaining 37 operations are formally disposed as follows:

| # | Operation / Permission Code | Disposition | Reason / Governance Boundary | Runtime Consequence |
|---|---|---|---|---|
| 1 | `organization.create` | **ACTIVE (V1)** | A-04 canonical baseline; creates Organization and first-ADMIN. | Permitted for PLATFORM_OPERATOR. |
| 2 | `platform.health.read` | **ACTIVE (V1)** | A-04 canonical baseline; reads platform liveness metadata. | Permitted for PLATFORM_OPERATOR. |
| 3 | `platform.audit.read` | **ACTIVE (V1)** | A-04 canonical baseline; reads operational audit events. | Permitted for PLATFORM_OPERATOR. |
| 4 | `platform.configuration.read` | **DEFERRED** | DEC-ACCESS-09: FUTURE / DECISION_REQUIRED. | Rejected with HTTP 422. |
| 5 | `platform.configuration.write` | **DEFERRED** | DEC-ACCESS-09: FUTURE / DECISION_REQUIRED. | Rejected with HTTP 422. |
| 6 | `platform.metrics.read` | **OUT_OF_V1_SCOPE** | Observability roadmap; managed via external Prometheus/Grafana. | Rejected with HTTP 422. |
| 7 | `platform.logs.read` | **OUT_OF_V1_SCOPE** | Infrastructure log access; managed via central logging (Elastic/Loki). | Rejected with HTTP 422. |
| 8 | `platform.maintenance.manage` | **DEFERRED** | Maintenance mode toggle pending platform operations design. | Rejected with HTTP 422. |
| 9 | `platform.featureflags.read` | **OUT_OF_V1_SCOPE** | Feature management handled via config service / LaunchDarkly. | Rejected with HTTP 422. |
| 10 | `platform.featureflags.manage` | **OUT_OF_V1_SCOPE** | Feature management handled via config service / LaunchDarkly. | Rejected with HTTP 422. |
| 11 | `platform.cache.purge` | **DEFERRED** | Redis cache management handled via DevOps automation. | Rejected with HTTP 422. |
| 12 | `platform.database.backup` | **OUT_OF_V1_SCOPE** | Database backup automated via MongoDB Atlas backup policies. | Rejected with HTTP 422. |
| 13 | `platform.database.restore` | **OUT_OF_V1_SCOPE** | Disaster recovery managed via infrastructure disaster runbook. | Rejected with HTTP 422. |
| 14 | `platform.license.read` | **OUT_OF_V1_SCOPE** | Commercial licensing module deferred beyond V1. | Rejected with HTTP 422. |
| 15 | `platform.license.manage` | **OUT_OF_V1_SCOPE** | Commercial licensing module deferred beyond V1. | Rejected with HTTP 422. |
| 16 | `platform.authority.grant` (public API) | **REJECTED** | PO-AUTH-01 is an internal controlled procedure; no public API. | Excluded from routing. |
| 17 | `platform.authority.revoke` (public API) | **REJECTED** | PO-AUTH-01 is an internal controlled procedure; no public API. | Excluded from routing. |
| 18 | `platform.authority.list` | **DEFERRED** | Operational listing deferred to internal reporting scripts. | Rejected with HTTP 422. |
| 19 | `platform.authority.policy.update` | **DEFERRED** | Access policy rules are code-governed via repository PRs. | Rejected with HTTP 422. |
| 20 | `platform.admin` (super-admin) | **REJECTED** | Explicitly prohibited by DEC-ACCESS-09 least-privilege policy. | Permanently denied. |
| 21 | `system.admin` (super-admin) | **REJECTED** | Explicitly prohibited by DEC-ACCESS-09 least-privilege policy. | Permanently denied. |
| 22 | `organization.delete` | **DEFERRED** | Soft/hard tenant deletion deferred pending data retention policy. | Rejected with HTTP 422. |
| 23 | `organization.suspend` | **DEFERRED** | Tenant suspension workflow deferred to Platform Admin V2. | Rejected with HTTP 422. |
| 24 | `organization.resume` | **DEFERRED** | Tenant reinstatement workflow deferred to Platform Admin V2. | Rejected with HTTP 422. |
| 25 | `organization.update` | **OUT_OF_V1_SCOPE** | Tenant self-management governed by Organization ADMIN scope. | Rejected with HTTP 422. |
| 26 | `organization.members.list` | **OUT_OF_V1_SCOPE** | Tenant boundary isolation; PLATFORM_OPERATOR has no tenant read. | Rejected with HTTP 422. |
| 27 | `organization.members.manage` | **OUT_OF_V1_SCOPE** | Tenant boundary isolation; governed by Organization roles. | Rejected with HTTP 422. |
| 28 | `organization.roles.manage` | **OUT_OF_V1_SCOPE** | Tenant boundary isolation; governed by Organization roles. | Rejected with HTTP 422. |
| 29 | `organization.settings.update` | **OUT_OF_V1_SCOPE** | Tenant boundary isolation; governed by Organization ADMIN. | Rejected with HTTP 422. |
| 30 | `organization.billing.read` | **OUT_OF_V1_SCOPE** | Subscription/billing module deferred to separate billing service. | Rejected with HTTP 422. |
| 31 | `organization.billing.manage` | **OUT_OF_V1_SCOPE** | Subscription/billing module deferred to separate billing service. | Rejected with HTTP 422. |
| 32 | `user.create` | **OUT_OF_V1_SCOPE** | User onboarding handled via self-service signup / Google OAuth. | Rejected with HTTP 422. |
| 33 | `user.delete` | **DEFERRED** | Account deletion governed by GDPR/CCPA privacy deletion workflow. | Rejected with HTTP 422. |
| 34 | `user.suspend` | **DEFERRED** | Security incident account suspension pending Trust & Safety review. | Rejected with HTTP 422. |
| 35 | `user.impersonate` | **REJECTED** | High security risk; violates non-repudiation and audit integrity. | Permanently denied. |
| 36 | `user.password.reset.admin` | **OUT_OF_V1_SCOPE** | Self-service password reset implemented via outbox mailer (DATN-27). | Rejected with HTTP 422. |
| 37 | `user.mfa.reset` | **DEFERRED** | Break-glass user MFA recovery deferred to Helpdesk workflow V2. | Rejected with HTTP 422. |
| 38 | `user.sessions.revoke` | **DEFERRED** | Session invalidation handled via standard user logout / rotation. | Rejected with HTTP 422. |
| 39 | `project.content.read` | **REJECTED** | Explicitly prohibited by DEC-ACCESS-09; zero content access. | Permanently denied. |
| 40 | `security.export.compliance` | **DEFERRED** | Compliance archive extraction deferred to Compliance Lead review. | Rejected with HTTP 422. |

---

## 5. Gate 4 — DB Reality & Verification Evidence

### 5.1 Local Verification Record
- **Environment:** Local Development (`127.0.0.1:27017` & `MongoMemoryReplSet` wiredTiger 7.0.24)
- **Inspection Time:** 2026-10-16 16:25:00 UTC
- **Collection State:**
  - `platform_authority_assignments`: Existing A-04 collection confirmed.
  - `platform_authority_change_operations`: Confirmed non-existent prior to migration apply.
- **Dry-Run Plan Execution:**
  - Command: `node scripts/migrations/20261016-platform-authority-change-operations.mjs --dry-run`
  - Target Fingerprint: `target:iam-mongodb`
  - Generated Report SHA-256: `8d9eb3cc00f0df68cef68020ee4d40f927f496d30bb7d21c1a33eaedb6bf1879`
  - Planned Operations: Create collection `platform_authority_change_operations`, create 3 indexes (`platform_authority_operation_id`, `platform_authority_operation_target`, `platform_authority_operation_actor`).
- **Integration Test Execution:**
  - Command: `npx jest src/services/iam/infrastructure/mongodb/platform-authority-change.mongodb.spec.ts`
  - Result: 8 passed, 0 failed on live WiredTiger replica set. Verified transaction atomicity, CAS, idempotency replay, payload mismatch 409, and audit rollback.

### 5.2 Staging & Production Verification Record
- **Status:** **DB REALITY = UNVERIFIED**
- **Exact Blocker:**
  - **BLOCKER:** Direct remote MongoDB Atlas connection credentials and network routes to Staging and Production VPCs are not provisioned in this execution context.
  - **OWNER:** IAM DB Owner / Data Platform Administrator role.
  - **EVIDENCE REQUIRED:** Executed read-only aggregate inspection report per `research-docs/Platform/platform-operator-v1-db-verification-runbook.md` confirming collection absence/presence, index catalog, and zero tuple collisions.
  - **WHY AGENT CANNOT OBTAIN:** Workstation boundary and zero-trust security principles strictly forbid embedding production/staging Atlas credentials into repository configuration or local environments.
- **Read-Only Verification Procedure for IAM DB Owner:**
  Execute the following read-only commands on the target cluster:
  ```javascript
  // 1. Confirm read-only role
  db.runCommand({ connectionStatus: 1 });
  
  // 2. Check collection existence
  db.getCollectionNames().filter(c => c.includes("platform_authority"));
  
  // 3. Inspect assignments collection and indexes
  db.platform_authority_assignments.getIndexes();
  
  // 4. Verify existing assignment count (redacted aggregate)
  db.platform_authority_assignments.aggregate([
    { $group: { _id: { permission: "$permission", scope: "$scope", status: "$status" }, count: { $sum: 1 } } }
  ]);
  
  // 5. Verify operations ledger collection is not yet present
  db.getCollectionNames().includes("platform_authority_change_operations");
  ```
- **Authorized Migration Runbook for IAM DB Owner:**
  Upon verifying the read-only baseline, the DB Owner can execute the deterministic dry-run and apply using the verified report hash:
  ```bash
  # Dry-run on Staging
  node scripts/migrations/20261016-platform-authority-change-operations.mjs --dry-run
  
  # Apply on Staging with hash guard
  node scripts/migrations/20261016-platform-authority-change-operations.mjs --apply --expected-report-sha256 8d9eb3cc00f0df68cef68020ee4d40f927f496d30bb7d21c1a33eaedb6bf1879
  ```

---

## 6. Implementation Architecture & Invariants

### 6.1 Idempotency & CAS Specification
- **Idempotency Key:** `operationId` (UUID string), indexed uniquely.
- **Canonical Payload Hashing:** All command parameters (`actorUserId`, `issuerUserId`, `operationType`, `targetUserId`, `permission`, `scope`, `expectedCurrentStatus`) are canonicalized via sorted key JSON serialization and hashed with SHA-256.
- **Replay Semantics:**
  - Same `operationId` + same `payloadHash`: Returns previously committed result (`status: 'COMMITTED'`, same HTTP status and body). No re-execution, no duplicate writes.
  - Same `operationId` + different `payloadHash`: Throws HTTP 409 Conflict (`OPERATION_ID_PAYLOAD_MISMATCH`).
- **Compare-And-Set (CAS):** If the command provides `expectedCurrentStatus`, the repository checks the actual status of the current assignment in `platform_authority_assignments`. If mismatched (e.g. expected `REVOKED` but current is `ACTIVE`), it immediately aborts with HTTP 409 Conflict (`CAS_STATUS_MISMATCH`).

### 6.2 Rollback Plan
- **Pre-Use Rollback:** If the migration was applied but no operations have been committed, drop the empty collection:
  ```javascript
  db.platform_authority_change_operations.drop();
  ```
- **Post-Use Rollback:** Once committed operation records exist, dropping the ledger collection is strictly forbidden because it would break audit traceability. Rollback is achieved by marking unwanted assignments as `REVOKED` via the controlled procedure with explicit audit attribution.
