# A-02 refresh rotation backend status

The A-01 contract remains authoritative: [auth-session-contract-a-01.md](decisions/auth-session-contract-a-01.md).

## Implemented internal boundary

- `AuthenticationApplicationService.refresh` compares the supplied CSRF cookie and header values before persistence access. It accepts only a 32-byte base64url opaque refresh credential, hashes presented and replacement credentials with SHA-256, and returns credentials only after repository rotation commits.
- `AuthenticationRepository.rotateRefreshSession` uses a MongoDB transaction to consume the old row and insert the replacement row. It checks `expiresAt` on use, including transaction retries. A known revoked row causes user-wide active refresh-session invalidation in the transaction. Unknown, expired, and unverifiable legacy rows create no replacement.
- A transaction error propagates without returning credentials. No raw refresh credential is stored or logged by this implementation.

## HTTP boundary blocked by A-01 TBDs

No `POST /api/v1/auth/refresh` controller route or browser cookie issuance is added in this slice. The refresh success status/body, CSRF cookie name, CSRF failure status/body, and transaction failure status/body remain TBD. Thus HTTP assertions for those responses are blocked. Login still issues only an access cookie, so the internal rotation method is not yet a complete browser refresh flow. A-03 browser recovery is outside this branch.

## Validation

- MongoDB 7.0.43 `rs0` integration test: rotation, replay invalidation, user isolation, expiry, invalid legacy row, unknown token, and transaction rollback passed in a disposable test database.
- Focused service tests cover hash-only repository arguments, seven-day expiry, malformed credentials, failure without issuance, and CSRF rejection without token-state access.
- Lint, typecheck, build, and the full unit suite passed (`246 passed, 3 skipped`). `npm run check` did not pass: existing E2E suites report Redis/BullMQ `Connection is closed` and `iam-secret.e2e-spec.ts` exceeded its 5-second timeout. No A-02 HTTP refresh test was run because the HTTP contract is still TBD.
