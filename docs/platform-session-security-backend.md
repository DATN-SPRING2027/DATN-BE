# Platform user session security — backend verification

Date: 2026-10-26. Scope: IAM backend only; no frontend, schema, migration,
permission provisioning, or live-data changes.

## Contract and implementation

The existing canonical contract is `docs/openapi/iam-v1.openapi.json`.
The older Platform Operator v1 proposal marked sessions deferred; the current
Platform user-management decision and implemented IAM OpenAPI supersede that
historical status. This change hardens and verifies existing APIs rather than
introducing another session model.

All paths below start with `/api/v1/iam/platform/users/{userId}`:

| Method | Path | Required current PLATFORM permission |
| --- | --- | --- |
| GET | `/sessions` | `platform.sessions.session.read` |
| GET | `/sessions/{sessionId}` | `platform.sessions.session.read` |
| POST | `/sessions/{sessionId}/revoke` | `platform.sessions.session.manage` |
| POST | `/sessions/revoke-bulk` | `platform.sessions.session.manage` |
| POST | `/sessions/revoke-all` | `platform.sessions.session.manage` |

An organization ADMIN role or account-management permission is insufficient.
The authenticated server identity supplies the actor; client actor headers do
not grant authority. Cookie-authenticated mutations require a matching CSRF
cookie/header pair. Responses use `Cache-Control: no-store`.

List accepts bounded `page`, `pageSize` (maximum 100), and optional `status`
(`ACTIVE`, `EXPIRED`, `REVOKED`). A row represents a refresh-session family,
including rotated credentials, rather than an individual token record.
Projection contains only id, userId, context, organizationId, status, createdAt,
updatedAt, expiresAt; it excludes token hashes, IP address and user agent.

Single revoke requires `expectedUpdatedAt` from the returned row and a
`reasonCode` of `ACCESS_REVIEW` or `SECURITY_INCIDENT`. Bulk revoke requires
1–100 distinct entries in `sessions`, each with `sessionId` and
`expectedUpdatedAt`, plus the reason code. Timestamps use the canonical UTC ISO
format specified by OpenAPI. Revoke-all requires the reason code.

Wrong-owner/missing session returns scoped 404. Invalid payload returns 422;
stale session version returns 409 (`SESSION_VERSION_STALE`). Revoke operations
recheck current operator authority within the transaction. Bulk changes and
audit inserts are atomic; an audit failure rolls the mutation back. Repeating
single-family revocation is idempotent and does not duplicate the audit event.

Revoking one family invalidates every refresh credential in that family.
Authenticated requests also check the family, so an otherwise unexpired access
JWT is rejected on subsequent authorization. Revoke-all advances the user's
`mutationFence`, rejecting access/refresh credentials from the previous epoch.
It does not cancel an already executing request. Bulk `revokedCount` counts
changed families; revoke-all `revokedCount` counts changed credential records,
as specified by the existing contract.

## Changes in this branch

- Validate single-revoke `expectedUpdatedAt` again at the application boundary,
  including missing, non-Date and invalid-Date values.
- Reject null/non-object bulk entries with 422 instead of an internal TypeError.
- Add dedicated application, HTTP and MongoDB regression suites, plus an access
  token regression for the revoke-all fence.

The new application tests first reproduced the validation defects (6 failures)
and passed after the fix. No dependency or API-contract changes are required.

## Verification and limits

- Application boundary: 16 new tests.
- HTTP boundary: 22 new cases using real Nest controller, authorization guard,
  policy and application service. Authentication identity and persistence are
  explicit test doubles; this is not a live signed-JWT deployment test.
- MongoDB: 9 new integration tests using real IAM repositories on a disposable
  MongoDB 7.0.24 replica set. They cover family grouping, pagination, safe output,
  ownership, CAS rollback, audit rollback, concurrent repeat revocation,
  transactional authority checks and revoke-all fencing.
- Authentication: regression verifies an old access token is rejected after
  the user fence changes, even if a refresh credential remains present.

Final `npm run check` passed: lint, typecheck, safety checks, 1,483
unit/integration tests, 130 E2E tests and build. There were 135 skipped
unit/integration tests and 4 skipped E2E tests; these are not counted as verified.
The first full run had one intermittent Capture failure (`does not assign
periods ending before a member joined`, expected at most 3 work reports,
received 4). That test passed both in isolation and in the final full run;
its root cause was not established and no Capture source was changed.
No live user sessions were revoked.

The security review follows the server-side invalidation guidance in the
[OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and the [OWASP logout testing guide](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/06-Logout_Functionality/).
The transaction and authorization claims above are backed by repository tests;
production correctness still depends on the documented MongoDB transaction
support and existing authority provisioning being configured correctly.
