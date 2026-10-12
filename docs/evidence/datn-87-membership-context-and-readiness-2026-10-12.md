# DATN-87 — persisted context checks and administration readiness

Date: 2026-10-12, Asia/Saigon. This is a **partial backend deliverable**;
Organization Membership administration is not complete. No new lifecycle policy
or administration API is accepted by this report or by passing its tests.

## Authority and current source

- [DATN-87](https://trankimthang0207.atlassian.net/browse/DATN-87) was read live,
  including description, acceptance criteria, dependency, comments and each of
  DATN-235–241. Parent and seven children were To Do; children had no separate
  description or comment. DATN-86 is Done; DATN-87 blocks DATN-88 (FE).
- [DATN-86](https://trankimthang0207.atlassian.net/browse/DATN-86), each child
  DATN-229–234, and linked [Document PR #23](https://github.com/DATN-SPRING2027/Document/pull/23)
  were checked against merged Document main `8ab9268523c3fb661008cd0b6715e0e1ca3cd79c`.
  R5's [working contract](https://github.com/DATN-SPRING2027/Document/blob/8ab9268523c3fb661008cd0b6715e0e1ca3cd79c/research-docs/Workspace/06-organization-membership-contract.md)
  and [worksheet](https://github.com/DATN-SPRING2027/Document/blob/8ab9268523c3fb661008cd0b6715e0e1ca3cd79c/research-docs/Workspace/07-organization-membership-review-worksheet.md)
  predate the requester's subsequent Leader decision evidence. Their blanket
  UNKNOWN statements are historical at the policy level; Done/merge alone does
  not select their proposed exact API/persistence details.
- Requester-relayed Leader D1–D6 were recorded on 2026-10-06 in local
  WORKING_CONTEXT section 35, with retained image evidence and explicit requester
  confirmation of the Leader's authority. They remain selected in this report.
  These local records are outside Git; no message URL or sender account is inferred.
- BE base: `e80617cde67fed146bab3ee874e68040ecf2caf3` (latest fetched origin/main).
  It includes [PR #22 / DATN-80](https://github.com/DATN-SPRING2027/DATN-BE/pull/22)
  and [PR #24 / account onboarding](https://github.com/DATN-SPRING2027/DATN-BE/pull/24).
  [DATN-79](https://trankimthang0207.atlassian.net/browse/DATN-79) and
  [DATN-80](https://trankimthang0207.atlassian.net/browse/DATN-80) were read live;
  both are Done. Their bootstrap implementation is reused, not rewritten.
- Applicable rules: root/repo AGENTS, Document AI_WORKFLOW and AGENTS, local
  AGENTDB, [DEC-016](../decisions/organization-membership-context.md),
  [authorization foundation](../authorization-foundation-scope.md),
  [OpenAPI](../openapi/iam-v1.openapi.json), and current IAM implementation/tests.
  Canonical ADR-003/SPEC-001 paths referenced by AGENTDB are not present in these
  repositories; preserve their documented atomicity invariant while obtaining
  exact owning authority/scope. Do not substitute eventual audit.

## D1–D6 reconciliation

| Decision | Selected rule | Detail still needing an exact accepted record |
|---|---|---|
| D1 | Invite an existing User by exact email; recipient authenticates and accepts through a limited context-free journey. | Eligible account lookup/selection, identity binding and final DTO. Current ACCOUNT authentication provides a reusable journey; it does not decide all invitation semantics. |
| D2 | Seven days, single use; resend invalidates old link; cancel PENDING_INVITE → REMOVED; expiry does not automatically change membership state; delivery failure never activates. | Credential/recipient transport, duplicate/replay/errors, resend/cancel persistence. Invitation status is separate from the four membership states. |
| D3 | Four states; ADMIN manages invite/suspend/remove/resume with reason; no self suspend/remove, no removal of last ADMIN; reinvite requires review and old-right invalidation. | Per-command permission evidence, peer constraints, source-state/repeat outcomes, atomic last-ADMIN concurrency and review evidence. |
| D4 | Normal remove follows handover; emergency suspend may precede handover; preserve data; deny Organization access at next check; resume reviews rights; rejoin does not restore Project/Team rights; no platform bypass of last ADMIN. | Handover/review application contract, descendant-right reconciliation, recovery, race/fence and any in-flight/cache guarantees. |
| D5 | Separate server-authorized commands, Idempotency-Key and version/ETag; accepted HTTP error family. | Exact paths/DTO/status/codes/precedence, read projection, key scope/TTL/replay, precondition transport and stale behavior. |
| D6 | Audit every membership mutation; mutation + audit atomic, audit failure rolls back; email after commit via outbox; no credentials/private content in audit. | Collection/action/payload, transaction/outbox ownership, delivery retry/dedup, rejected-attempt and retention policy. |

## Reuse and observed drift

- [Authentication repository](../../src/services/iam/infrastructure/mongodb/authentication.repository.ts)
  queries authenticated User + ACTIVE membership. The
  [resolver](../../src/services/iam/application/authentication/membership-organization-context.resolver.ts)
  selects eligible Organizations before loading roles. The
  [authentication service](../../src/services/iam/application/authentication/authentication.application.service.ts)
  rechecks persisted User/membership for Organization sessions; refresh resolves
  current context before rotation. No duplicate resolver/guard was introduced.
- [Provisioning repository](../../src/services/iam/infrastructure/mongodb/organization-provisioning.repository.ts)
  already commits Organization + ACTIVE first-ADMIN membership + assignment +
  `organization.create` audit in one MongoDB session. Existing DATN-80 integration
  proves duplicate/concurrent creation, rollback/retry and Role.permissions.
- [Invitation service](../../src/services/iam/application/organizations/organization-invitation.service.ts)
  and [repository](../../src/services/iam/infrastructure/mongodb/organization-invitation.repository.ts)
  already implement create/list/revoke/recipient accept, seven-day expiry,
  current ADMIN/context checks, single-use consumption and session-bound audit.
  These are reuse candidates, not proof of D1–D6 conformity.
- Current create can record an invitation without an existing User and creates
  no PENDING_INVITE membership. Accept creates/activates membership and assigns
  the selected role. Create/revoke lack reason/key/version and no email outbox
  or resend command is wired. Clarify the amendment/mapping before changing them.
  Current invitation `PENDING/ACCEPTED/REVOKED/EXPIRED` is a separate resource enum,
  not a new OrganizationMembership state.
- Invitation ADMIN lookup checks ACTIVE membership/User and org-scoped assignment
  roleCode, but does not resolve the Role record or documented action permissions.
  Exact evidence/fence contract is required; do not invent permission codes.
- [User directory](../../src/services/iam/infrastructure/mongodb/user-directory.repository.ts)
  lists ACTIVE Users and changes global account status. It is not a four-state
  membership listing or suspend/remove API. Its safeguards cannot be copied as
  the new membership contract. Generic audit adapter has no session parameter;
  use the accepted atomic transaction pattern after specific audit closure.

## Seven checkpoints

All statuses below are the live-read To Do snapshot. Suggestions reflect actual
work and remaining acceptance, not a claim that Jira has been changed.

| Jira checkpoint | Existing / added evidence | Still missing | Current → proposed |
|---|---|---|---|
| [DATN-235](https://trankimthang0207.atlassian.net/browse/DATN-235) List members | Existing ACTIVE User directory examined; distinguished from membership resource. | Accepted reader/PII/DTO/filter/sort/paging + membership list API/tests. | To Do → In Progress (source/contract investigation started) |
| [DATN-236](https://trankimthang0207.atlassian.net/browse/DATN-236) Invite | Existing invitation create + atomic audit examined; D1–D3/D5–D6 drift identified. | Existing-account constraint, pending/role mapping, reason, key/version, resend/cancel, outbox and accepted errors. | To Do → In Progress |
| [DATN-237](https://trankimthang0207.atlassian.net/browse/DATN-237) Activate | Context-free ACCOUNT identity and recipient accept found; bootstrap reused separately. | Accepted recipient/precondition/replay/role/reset contract and real write/audit integration. | To Do → In Progress |
| [DATN-238](https://trankimthang0207.atlassian.net/browse/DATN-238) Suspend/remove | D3/D4 settled rules preserved; no production commands found. | Exact command DTO/evidence/handover/rights/last-ADMIN concurrency and mutation tests. | To Do → In Progress |
| [DATN-239](https://trankimthang0207.atlassian.net/browse/DATN-239) Authorization | New real-Mongo HTTP tests prove ACTIVE context, role-only/other-User/cross-org denial, next-check denial, non-admin denial and inactive-account denial. | Complete administration command permission/fence/target evidence. | To Do → In Progress; partial, not Done |
| [DATN-240](https://trankimthang0207.atlassian.net/browse/DATN-240) Audit | Existing atomic provisioning + invitation adapters examined; provisioning audit/rollback suite rerun. | Membership action/payload/transaction/outbox contract and all new mutation rollback/retry tests. | To Do → In Progress |
| [DATN-241](https://trankimthang0207.atlassian.net/browse/DATN-241) Integration | New context suite explicitly selected in opt-in CI command; 14 new tests + 18 existing tests run on disposable replica set. | Accepted list/lifecycle/validation/idempotency/concurrency/rollback/audit integration for remaining operations. | To Do → In Progress; partial, not Done |

Parent DATN-87: To Do → **In Progress**, not In Review/Done. DATN-88 stays a
separate FE dependency; these checks do not establish FE readiness.

## Checks and limits

- New [MongoDB context suite](../../src/services/iam/infrastructure/mongodb/organization-membership-context.mongodb.spec.ts):
  14 tests passed on dedicated loopback MongoDB 7.0.41 replica set `datn87-rs`.
  Real HTTP controllers, authentication service, token signing/verification,
  resolver and MongoDB repositories; random `datn87_*` DB dropped in teardown.
  Tests use fixture state updates, not an implemented lifecycle mutation API.
  Redis revocation, credential/provider login and unrelated providers are stubbed;
  no claim of deployed full-flow, in-flight cancellation or cache propagation.
- The exact [CI command](../../.github/workflows/ci.yml) selects Project + DATN-80
  provisioning + new context suites with `MONGODB_INTEGRATION=true`: local
  **3 suites / 32 tests passed** (1 + 17 + 14). The opt-in suite is skipped in the
  normal unit job; a green unit job alone is not integration evidence. Actual
  remote CI execution remains pending a user-requested PR; workflow triggers on PR.
- `npm run check` with `INFRA_ENABLED=false` and default ts-node behavior passed:
  lint/typecheck/build, 25 smoke-safety, 377 unit tests (35 skipped, including the
  14 opt-in context tests), and 53 E2E tests (4 skipped). Existing duplicate-index
  warnings are outside this delta. No dependency or historical migration changed.
- Mutation experiment removed the ACTIVE predicate from the existing
  authentication membership query: **7 of the 14 context tests failed**, including
  stale-token and refresh denial. Source was restored byte-for-byte; the new suite
  then passed 14/14 again. This proves sensitivity to removal of the context gate,
  not coverage of unimplemented lifecycle commands.
- Final code-review-and-quality and handoff are recorded locally. No check result
  is inferred from Jira; readiness is limited to the partial delta above.

## Exact input needed to continue

1. Supply the accepted list reader/fields/PII/filter/sort/page DTO and every
   enabled command's method/path, body, response, reason constraints and exact
   errors/precedence. State per-operation ADMIN role/permission/deny evidence.
2. State Idempotency-Key scope/TTL, same-payload replay response, different-payload
   conflict, concurrent duplicate outcome, authorization recheck, audit count;
   version/ETag transport, missing/stale outcomes and write fencing.
3. State each enabled command's source state and repeated-request outcome; peer
   ADMIN handling and atomic last-ADMIN safety. Supply application proof/API for
   handover completion, rights review/invalidation and emergency suspension.
4. Supply membership audit collection/action/payload (reason/before-after/
   correlation), transaction boundary, rollback errors; outbox owner/payload/
   retry/dedup/retention. Preserve D6 atomicity and after-commit email.
5. Confirm any newer decision amending D1–D6 for PR #24's invitation behavior.
   Otherwise provide the accepted reuse/amendment mapping, especially existing
   recipient eligibility, PENDING_INVITE creation, role assignment and delivery.

No DB/schema/index/migration/dependency/production data change is in this delta.
Disposable test indexes are existing definitions, not a shared DB rollout.
If closure requires new DB version/idempotency/outbox fields/collections, use a
separate DB branch/PR and wait for its approved merge before dependent BE work;
never edit the committed 20261011 invitation migration. No Jira update, PR,
reviewer request, team notification, approval or merge is performed here.
