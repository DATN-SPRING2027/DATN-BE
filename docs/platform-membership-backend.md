# Platform Membership backend

## Scope and contract

Backend only: global Organization Membership directory, Organization-scoped
invitations (create, resend, cancel), and membership suspension. The contract is
`docs/openapi/iam-v1.openapi.json`; implementation reuses IAM membership state
machines and persistence. No endpoint, request schema, permission bundle,
database schema, index, migration, or frontend is added.

All paths below are relative to `/api/v1/iam/platform`.

| Method and path | Exact PLATFORM permission |
| --- | --- |
| GET `/memberships` | `platform.memberships.membership.read` |
| GET `/memberships/{membershipId}` | `platform.memberships.membership.read` |
| GET `/organizations/{organizationId}/memberships` | `platform.memberships.membership.read` |
| GET `/organizations/{organizationId}/invitations` | `platform.memberships.membership.read` |
| POST `/organizations/{organizationId}/invitations` | `platform.memberships.invitation.manage` |
| POST `/organizations/{organizationId}/invitations/{invitationId}/resend` | `platform.memberships.invitation.manage` |
| POST `/organizations/{organizationId}/invitations/{invitationId}/cancel` | `platform.memberships.invitation.manage` |
| POST `/organizations/{organizationId}/memberships/{membershipId}/suspend` | `platform.memberships.lifecycle.manage` |

Admin is the display label for Platform authority (`PLATFORM_OPERATOR`), not the
Organization `ADMIN` role (Manager). A role label or client header does not grant
access. Read, invitation and lifecycle permissions are independent. Platform
commands recheck the ACTIVE actor and current non-self-granted assignment inside
the transaction. This Platform override does not require the operator to join
the target Organization; it resolves persisted Organization/resource ownership.
The Organization Manager endpoints retain their separate membership checks.

## Requests and lifecycle

- Directory filters: `page` (default 1), `pageSize` (default 20, maximum 100),
  `search` (literal, maximum 100 characters), `organizationId`, `status`,
  `roleCode`. Results expose bounded safe identity and Organization-role metadata.
- Browser mutations require a matching `__Host-csrf` cookie / `X-CSRF-Token`
  header and an `Idempotency-Key` (16–128 allowlisted characters).
- Invite body: `{ "email": "member@example.test", "reasonCode": "ACCESS_REQUEST" }`.
  `ACCESS_REVIEW` is also allowed. Target must be an existing ACTIVE account.
  Unknown/inactive targets share the generic eligibility error. An invitation
  creates no membership and grants no role before acceptance.
- Resend/cancel bodies contain `expectedMembershipVersion`,
  `expectedInvitationVersion`, and `reasonCode`. For an invitation with no
  membership, the membership version is `0`. Resend reasons match invite;
  cancel requires `INVITATION_CANCELLED`. Resend supersedes the prior token;
  cancel invalidates the pending invitation and queued delivery.
- Suspend body contains the current `expectedMembershipVersion` and reason
  `ACCESS_REVIEW` or `SECURITY_INCIDENT`. Self-action, last eligible Manager,
  active Project Leadership and cross-Organization targets remain protected.
- CAS failures and conflicting key reuse return conflicts. Exact retry replays
  the stored result only after fresh authorization. Logically expired receipts
  are removed transactionally before key reuse; Mongo TTL cleanup need not have
  run. Business mutation, operation receipt, audit and delivery intent commit
  together. Audit failure aborts all writes.
- Platform suspension audit explicitly includes `scope: PLATFORM` and
  `result: SUCCESS`, preserving its visibility in Platform audit queries.

## Readiness and operational prerequisite

On 2026-10-23 the user chose the OpenAPI fail-closed behavior when no readiness
adapter is configured. `UnconfiguredOrganizationInvitationReadiness` returns
false. This also restores the shared Organization invitation/acceptance gates:

- Invite/resend: `A7_NOTIFICATION_CONTRACT_PROVIDER` and `A8_COORDINATED_CUTOVER`.
- Cancel: `A8_COORDINATED_CUTOVER`.
- Acceptance: `A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF` and
  `A8_COORDINATED_CUTOVER`.

A reviewed runtime adapter supplying actual evidence is still required before
these operations can run in an environment; unconfigured requests return 503.
Do not replace readiness evidence with a hardcoded true value. Membership reads
and suspension are independent of these invitation gates. No authority is
assigned and no live invitation/email or deployed data mutation is performed by
this change.

## Verification

Regression tests exercise MongoDB 7 replica sets created and stopped by tests:
invite → resend → cancel, exact replay, expired receipt reuse before TTL cleanup,
revoked/expired/missing/wrong-scope/self-granted authority, inactive actors,
foreign Organization targets, stale versions, concurrent resend/cancel,
eligibility concealment, readiness denial and audit rollback. HTTP coverage
uses real authentication/Platform guards and CSRF handling with application
service doubles; it does not send mail or assert production delivery.

Run `npm run check` for lint, TypeScript, safety tests, unit/Mongo tests, E2E
and build. The separate explicitly marked Mongo integration suites remain
opt-in; the new Platform invitation suite runs in the default unit command.

Local verification on 2026-10-23, branch
`feat/Tien-platform-membership-be-api`, base `origin/main` = `c01a483`:

| Check | Result |
| --- | --- |
| `npm run check` | Passed lint, typecheck, safety tests, unit, E2E, build |
| Unit/Mongo | 132 suites passed, 14 skipped; 1,323 tests passed, 135 skipped |
| E2E | 14 suites passed, 2 skipped; 89 tests passed, 4 skipped |
| New Platform invitation Mongo suite after mutation restoration | 13 tests passed |
| Platform login/membership HTTP suite after fixture cleanup | 34 tests passed |
| Deliberately inverted expired-receipt deletion predicate | Regression test failed as expected; original source restored |
| `git diff --check` | Passed |

These are local test results, not deployed readiness evidence or proof of live
email delivery. Changes are left uncommitted; no push or merge is performed.
