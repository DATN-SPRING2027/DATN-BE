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

The invitation lifecycle follows the fail-closed gate mapping approved on
2026-10-23. IAM checks each required gate for new operations:

- Invite/resend: `A7_NOTIFICATION_CONTRACT_PROVIDER` and `A8_COORDINATED_CUTOVER`.
- Cancel: `A8_COORDINATED_CUTOVER`.
- Acceptance: `A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF` and
  `A8_COORDINATED_CUTOVER`.

IAM reads three deployment attestations. Each setting accepts the 64-character
hexadecimal SHA-256 digest of the corresponding approved evidence artifact.

| Gate | IAM environment variable | Optional key in the Helm IAM auth Secret |
| --- | --- | --- |
| A7 Notification contract and provider | `ORGANIZATION_INVITATION_A7_NOTIFICATION_EVIDENCE_SHA256` | `invitation-a7-notification-evidence-sha256` |
| A7 legacy or orphan rights activation proof | `ORGANIZATION_INVITATION_A7_LEGACY_RIGHTS_EVIDENCE_SHA256` | `invitation-a7-legacy-rights-evidence-sha256` |
| A8 coordinated cutover | `ORGANIZATION_INVITATION_A8_CUTOVER_EVIDENCE_SHA256` | `invitation-a8-cutover-evidence-sha256` |

The gate owners must verify and approve each artifact for the target environment
and rollout before the deployment owner sets its digest. A digest records the
deployment owner's attestation. IAM validates its format and does not retrieve
the artifact or independently certify the underlying provider, rights proof,
or cutover. Set these in trusted IAM deployment configuration only. For Compose,
the IAM service passes them through from the operator environment. Helm reads
the optional keys from the Secret named by `auth.existingSecretName`.

An unset or blank value keeps that gate closed, and a malformed nonblank value
fails runtime configuration validation. Missing required gates return 503 before
new lifecycle writes. Membership reads and suspension are independent of these
gates. Remove the affected digest and restart every IAM instance if its evidence
expires, is withdrawn, or no longer matches the deployment. No provider evidence
or cutover approval is supplied by these defaults.

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
