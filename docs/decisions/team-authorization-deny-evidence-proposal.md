# Team Authorization Deny Evidence — Decision Proposal

**Status:** `DECISION PROPOSAL / BLOCKED`; not approved and not an implementation authorization

**Reviewed:** 2026-10-18

**Contract under review:** C-05 Team Foundation OpenAPI R4, blob SHA `28ad1139ca72f27d7a9a5efe727c14fcf2e72e2c`

**Related evidence:** [DATN-370 C-08 decision record](https://trankimthang0207.atlassian.net/browse/DATN-370), [C-04 decision-gap report](https://github.com/DATN-SPRING2027/Document/blob/main/research-docs/Workspace/09-team-management-foundation-decision-gap-report.md), [R4 OpenAPI](https://github.com/DATN-SPRING2027/Document/blob/main/research-docs/Workspace/contracts/c-05-team-foundation-r4.openapi.json), [DATN-91 C-06](https://trankimthang0207.atlassian.net/browse/DATN-91)

This proposal records a concrete IAM design for authority review. It does not approve the R4 contract, change IAM semantics or schema, authorize a migration, or enable Team operations.

## 1. Current evidence

| Source | Verified state | Consequence |
|---|---|---|
| `role_assignments` | Organization/Project-scoped positive role assignment with `mutationFence`; no Team deny effect, expiry, revocation state, or revocation timestamp. | Current assignment presence and Role permissions cannot prove that no applicable Team deny exists or that a grant has not expired. |
| `roles.permissions` | Positive permission strings only. | A missing capability denies; there is no deny rule representation. |
| `organization_capability_grants` | Organization-scoped; the current capability enum covers `project.create`, not Team permissions. | It is not a valid Team grant or deny source. |
| `platform_authority_assignments` | Platform-scoped authority records. | Must not be reused for Organization/Project/Team authorization. |
| Accepted DEC-002 (`docs/decisions/decision-register.md`) | Default deny; an applicable explicit deny wins; missing, unknown, or invalid evidence denies. | The policy rule is accepted, but the Team deny source and Team grant lifecycle are not defined by it. |
| Team candidate provider | Current Mongo evidence has positive User, membership, Project, Role, and RoleAssignment facts but no deny source. | It returns `UNKNOWN`; the Team policy denies. No candidate operation can obtain runtime authorization from this evidence. |

The current provider does not query a real deny source and must not synthesize `CLEAR`. Existing generic Project/provider behavior is not evidence that Team has an applicable deny source.

## 2. Proposed IAM direction for decision

### 2.1 Positive grants

For the R4 proposal only, continue to resolve positive Team capabilities from a current Project-scoped RoleAssignment and its current Role permissions. Require the trusted User, active Organization and Project memberships, matching Organization/Project/actor scope, current role resolution, and the exact action capability plus `team.children.manage`. Role names alone never grant permission.

If authorities require per-assignment expiry or retained revocation evidence, extend the owning IAM grant lifecycle through a separately approved schema and migration. Proposed fields for review are `status` (`ACTIVE`/`REVOKED`), `validFrom`, nullable `expiresAt`, `revokedAt`, `revokedBy`, and a monotonically increasing revision/fence. Expiry is evaluated against server UTC time. Missing, malformed, stale, revoked, or expired grant evidence does not allow access.

### 2.2 Explicit deny source

Evaluate a dedicated IAM-owned `authorization_policy_rules` source in `continuum_iam`, separate from platform authority and Organization capability grants. A Team rule should bind an authenticated subject to Organization, Project, optional Team resource, and one exact action (or an explicitly approved action set); carry an explicit `DENY` effect and an auditable lifecycle. Product/Security/IAM must decide whether this source is deny-only or also owns positive Team grants before any implementation.

At minimum, the persistence contract must settle: stable rule ID; subject/principal type and ID; Organization/Project/Team scope; action; effect; active/revoked state; effective and expiry times; creator/revoker; reason; revision/fence; audit event; indexes; retention; and who can create or revoke a rule. No client-supplied identity or role claim is authoritative.

### 2.3 Evaluation semantics

| Assessment | Proposed meaning | Authorization result |
|---|---|---|
| `DENY` | A valid, current, in-scope explicit deny matches the trusted actor, Organization, Project, resource, and operation. | Deny even when positive grants match. |
| `CLEAR` | The authoritative deny source is available, valid, current, and completely evaluated for the full applicable scope; no active, unexpired matching deny exists. | Continue to positive-grant, membership, parent, and operation checks. `CLEAR` alone never grants access. |
| `UNKNOWN` | Source unavailable, query incomplete, invalid/ambiguous record, stale revision, unsupported scope, or evaluation error. | Deny; return the approved not-ready/unavailable error without disclosing protected resource details. |

Explicit deny has precedence over every positive grant. A missing grant is not `CLEAR`; it is a failed positive authorization requirement. A missing or unhealthy deny source is `UNKNOWN`, never `CLEAR`.

## 3. Proposed lifecycle and migration conditions

1. IAM must inventory every writer that creates, updates, expires, revokes, restores, or replaces RoleAssignments and policy rules. All applicable writers must participate in one revision/fence protocol before Team authorization relies on these records.
2. Grant and deny mutations must be auditable and concurrency-safe. Authorization must read current evidence and fence the relevant versions within the command transaction or use an Architecture-approved equivalent with demonstrated revocation ordering.
3. Any schema work must be a separate, forward-only, non-destructive migration. Before backfill, run a dry-run that reports missing IDs/timestamps, duplicate scopes, orphan references, expired records, and ambiguous legacy state. Preserve existing records; do not silently convert ambiguous assignments into active grants.
4. If existing assignments are backfilled as active/non-expiring, the IAM authority must explicitly approve that rule and its cutover date. No expiry is inferred from `createdAt`, and no deleted record is reconstructed as a grant.
5. Add indexes only after the approved query and uniqueness semantics are settled. Document deployment order, compatibility window, rollback/forward-recovery behavior, and how a failed or partial migration keeps Team operations denied.
6. Record sanitized grant/deny creation, change, revocation, and expiry evidence in the approved canonical IAM audit source. The exact event shape, atomicity, redaction, and recovery behavior require an accepted audit decision.

## 4. Minimum decisions requested

Product, Architecture, and Security/IAM authorities must record against the exact R4 SHA (or a later explicitly named candidate):

1. Whether the proposed Project Leader model and the five R4 Team capabilities are accepted, amended, or deferred; whether List/Detail are independently allowed.
2. Which IAM collection/service is authoritative for Team explicit denies and whether it is deny-only or also owns positive grants.
3. Exact matching scope, wildcard rules, deny precedence, and the conditions that permit `CLEAR`; define how stale/partial reads become `UNKNOWN`.
4. Positive grant source and lifecycle, including expiry, revocation, immediate effect, in-flight command ordering, and whether role assignment records may be retained as revoked.
5. Required schema/index and migration/backfill plan, all-writer inventory, transaction/fence protocol, audit contract, operational recovery, and test evidence.
6. Which operations remain gated until each decision and evidence item is complete. No Team read is implicitly approved because mutations are gated.

Each response must identify the authority role, disposition (`APPROVE`, `AMEND`, or `DEFER`), rationale, exact artifact revision, evidence, contract/schema impact, and operations affected. A task assignee, Jira status, PR review, passing test, or silence is not authority approval.

## 5. Implementation gate

Until these decisions are recorded and the approved source is implemented and verified:

- Team provider returns `UNKNOWN` for explicit-deny assessment and fails closed.
- List, Detail, Create, Update, Archive, and Restore remain gated; no operation is READY.
- Do not add the proposed collection/fields, migration, indexes, or runtime wiring.
- Test fixtures that inject `CLEAR` test policy logic only; they are not production authorization evidence.
- R4 remains `PROPOSED_NOT_APPROVED` / `NOT_READY`; do not create an authoritative R5 until decisions require contract changes.
