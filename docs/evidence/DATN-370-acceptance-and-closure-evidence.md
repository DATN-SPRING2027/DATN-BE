# DATN-370 — Acceptance and Closure Evidence

**Review date:** 2026-10-18 (Asia/Bangkok)
**Jira evidence:** read-only snapshot at 2026-10-18 00:26 ICT (2026-10-17 17:26 UTC), followed by successful transition `41` responses at 00:40:52, 00:40:55, and 00:40:58 ICT for DATN-371, DATN-372, and DATN-370 respectively. The snapshot preceded those transitions; no post-transition read-back is recorded here.
**Result:** The C-08 documentary acceptance branch is satisfied by the unresolved-blocker decision package. Transition responses reported Done for DATN-370 and its two evidence subtasks; no post-transition read-back is recorded. The leader's technical direction is explicit; no Product/Architecture/Security-IAM approval or runtime readiness is claimed.

## DATN-370 acceptance criteria

| Acceptance criterion | Evidence | Result |
|---|---|---|
| “A named revision is explicitly approved by the applicable authorities, or the decision record lists each unresolved question, authority role, required evidence, and dependent scope.” | The [leader decision record](DATN-370-c08-leader-decision-record.md#10-leader-decision-package-received-2026-10-18) links the exact R4 and C-04 revisions and records each unresolved authority question, evidence, affected operation, and dependency. The [baseline evidence report](DATN-370-c08-team-foundation-contract-gate.md) contains the source comparison and gap analysis. | **Met by blocker-record branch.** No R4 approval is asserted. |
| Reconcile R4 approval/readiness markers with Jira without claiming approval from DATN-90 Done, tests, or PRs. | R4 SHA `28ad1139ca72f27d7a9a5efe727c14fcf2e72e2c` marks `PROPOSED_NOT_APPROVED` / `NOT_READY`, with policy options unselected. DATN-90 Done, tests, and PR #36 are not treated as contract approval; the baseline report records the contract/runtime mismatch. | **Met.** Jira Done, merge, and tests are not approval evidence. |
| DATN-91 remains gated until an approved contract; do not change DATN-90/91 status. | The 00:26 ICT read-only snapshot showed DATN-91 In Progress with an `is blocked by` link to DATN-370 and DATN-90 Done. No transition was requested for DATN-90 or DATN-91. | **Met within scope.** The recorded transition responses target DATN-370/371/372 only; this evidence package does not claim a post-transition read-back of DATN-90/91. |
| No lifecycle, membership, or authorization behavior is added by this task. | This PR adds only evidence documents; R4, source code, routes, database schema/migrations, UI, and permission policy are unchanged. Jira transition evidence is described separately above. | **Met.** |

## Read-only Jira cross-check

At 2026-10-18 00:26 ICT, after recording the final C-08 disposition, the Atlassian Jira connector returned:

| Issue | Status at 00:26 ICT snapshot | Current evidence relevant to C-08 | Link/state implication |
|---|---|---|---|
| [DATN-370](https://trankimthang0207.atlassian.net/browse/DATN-370) | To Do | AC accepts an exact blocker-record alternative; the final leader package records decisions and residuals. | DATN-91 was In Progress and linked as blocked by DATN-370; no transition was requested for DATN-90/91. |
| [DATN-89](https://trankimthang0207.atlassian.net/browse/DATN-89) | Done | C-04 decision-gap deliverable; comment 10162 contains partial TQ dispositions, without established role authority or R4 binding. | Supports the gap analysis, not approval of R4. |
| [DATN-90](https://trankimthang0207.atlassian.net/browse/DATN-90) | Done (unchanged; updated 2026-10-17 18:04:06 ICT) | Its description makes implementation conditional on an approved contract and requires persistence/lifecycle to match it. R4 remains `PROPOSED_NOT_APPROVED`; PR #36 is merged but leaves Team runtime unwired. Six subtasks are Done. These facts do not demonstrate the parent AC's contract prerequisite. | Preserve Done unchanged as directed; record a status/evidence mismatch. No owner reply is needed to complete C-08's blocker-record branch, and Done is not approval evidence. |
| [DATN-91](https://trankimthang0207.atlassian.net/browse/DATN-91) | In Progress (unchanged; updated 2026-10-17 18:04:08 ICT) | No comments; acceptance requires the accepted API contract and no invented behavior. | Issue link still says blocked by DATN-370 and DATN-90; keep C-06 gated until contract approval and operation readiness evidence. |
| [DATN-371](https://trankimthang0207.atlassian.net/browse/DATN-371) | To Do | Each operation is marked `PROPOSED_NOT_APPROVED` with direct R4 source link; Jira workflow status is not approval evidence. | Reconciliation AC evidence was recorded. |
| [DATN-372](https://trankimthang0207.atlassian.net/browse/DATN-372) | To Do | Exact artifact SHA, authority roles, each blocker/evidence/dependent scope, and the DATN-91 gate are recorded. | Decision-record AC evidence was recorded; no authority approval is claimed. |
| [DATN-452](https://trankimthang0207.atlassian.net/browse/DATN-452) | To Do | Linked by DATN-370 as blocked by the contract gate. | Remains gated. |

The 00:26 ICT issue table is a read-only snapshot taken before the transitions. Later, transition `41` responses reported success to Done for DATN-371 at 00:40:52, DATN-372 at 00:40:55, and DATN-370 at 00:40:58 ICT, after workflow availability was checked. No post-transition read-back is recorded. No transition was requested for DATN-90 or DATN-91; their statuses in this evidence are from the earlier snapshot. No Jira comments, non-status fields, or links were edited.

## Exact evidence needed to remove the remaining gates

| Gate | Required evidence before closure | Dependent scope |
|---|---|---|
| Authority and exact revision (B1) | Role-attributed Product, Architecture, and Security/IAM dispositions against the same exact contract artifact SHA, with identity, authority basis/delegation, scope, rationale, exclusions, conditions, and human record. If one person covers multiple roles, document each authority basis. | DATN-370/372; any C-05/C-06 operation based on the revision. |
| Operation grants and Project/Team boundary (B2) | Approved operation × actor × resource-scope matrix; grant provisioning/change/revocation source; server-side ownership checks; deny-by-default and cross-org/project/team negative tests across every writer. | All six proposed operations; DATN-371/372/90/91/452. |
| Parent lifecycle and concurrency (B3) | Product lifecycle decisions; Architecture parent/Team owner and all-writer inventory; Security/IAM admission rule; missing/stale/archived parent, no-cascade, repeat and race tests. | Create/list and especially archive/restore; DATN-371/372/90/91. |
| Route and transport ownership (B4) | BFF/Gateway/IAM responsibility map; trusted principal propagation; DTO/query/header/CSRF/ETag/If-Match/Idempotency-Key forwarding and enforcement decisions; route-specific integration tests. | Each public operation and C-06 integration. |
| Error behavior (B5) | Shared `ErrorResponse` reconciliation; approved operation/status/code/precedence/disclosure table; tests for forbidden, concealed/missing resource, validation, conflict, precondition, replay, and safe server errors. | All six operations and FE error handling. |
| Mutation replay/recovery (B6) | Durable idempotency implementation or Architecture-approved equivalent; key scope/retention/fingerprint/replay semantics; all-writer, same/different payload, concurrency, lost response/ambiguous commit, authorization-on-replay and If-Match evidence. | Create/update/archive/restore only; no read gate implied. |
| Audit/atomicity (B7) | Approved canonical Team audit mapping and event fields/redaction; evidence for same-transaction delivery or justified outbox/alternative; failure, duplicate and recovery tests. | Mutations requiring audit. |
| Archive reason (B8) | Product purpose/visibility and Security/IAM exposure decision; consistent persistence, serializer, OpenAPI, retention and restore tests. | Archive/restore; R5 if a public field is approved. |
| DATN-90 status/AC discrepancy (B9) | Current issue evidence is sufficient to state the mismatch: parent AC requires an approved contract, but R4 is explicitly unapproved and runtime is unwired. Preserve the Jira status; no additional authority or owner response is required for C-08 closure. Any later status correction belongs to DATN-90's own workflow. | DATN-90/370/372/91. |

## Validation performed for this documentation-only result

- Inspected worktree branch/base and Git status before edits; preserved existing three untracked evidence artifacts and all tracked files.
- Compared the new decision package with the existing report, leader record, authority request, C-04, R4, governance evidence, Jira AC, and current DATN-90/91 issue state.
- Read the Jira snapshot at 00:26 ICT, then recorded successful transition responses for DATN-371, DATN-372, and DATN-370 at 00:40 ICT. No post-transition read-back is recorded; no transition was requested for DATN-90/91.
- No application tests, lint, typecheck, or build were run: no source/API/schema/UI code changed, and the task’s implementation scope is explicitly none. Markdown fence, trailing-whitespace, and local-link checks passed.

## Closure verdict

**C-08 documentary acceptance: SATISFIED via the explicit unresolved-blocker alternative.** Transition `41` responses reported Done for DATN-370, DATN-371, and DATN-372; the recorded evidence does not include a post-transition read-back. This is not a claim that Product/Architecture/Security/IAM has approved R4. DATN-90 was Done and DATN-91 was In Progress/blocked in the 00:26 ICT snapshot; Team runtime and C-06 remain gated.
