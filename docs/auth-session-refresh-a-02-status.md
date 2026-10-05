# A-02 refresh rotation backend status

The A-01 contract remains authoritative: [auth-session-contract-a-01.md](decisions/auth-session-contract-a-01.md).

## Implemented backend boundary

- `AuthenticationApplicationService.refresh` compares the supplied CSRF cookie and header values before persistence access. It accepts only a 32-byte base64url opaque refresh credential, looks up the persisted owner, checks account and organization eligibility, and signs the access token before committing rotation. Eligibility, lookup, or signing failure leaves the presented session untouched.
- `AuthenticationRepository.rotateRefreshSession` uses a MongoDB transaction to consume the old row and insert the replacement row. It checks `expiresAt` on use, including transaction retries. A known revoked row causes user-wide active refresh-session invalidation in the transaction. Unknown, expired, and unverifiable legacy rows create no replacement.
- A transaction error propagates without returning credentials. No raw refresh credential is stored or logged by this implementation.
- Successful Login persists the initial refresh-session hash before issuing access, refresh, and independent readable CSRF cookies. A failed persistence write issues no credentials.
- The `__Secure-refresh` cookie uses `Path=/api/v1/auth`, so both refresh and logout receive it. Logout revokes the presented refresh session by SHA-256 hash and clears the access and refresh cookies at their issued paths. The legacy `continuum_refresh` cookie name remains accepted for revocation during transition.
- `POST /api/v1/auth/refresh` returns `200 {"status":"refreshed"}` and two separate replacement cookies after commit. Invalid refresh returns generic `401 AUTH_REFRESH_INVALID`; CSRF failure returns `403 AUTH_CSRF_INVALID`; unexpected persistence/transaction failure returns `500 AUTH_REFRESH_FAILED`. All responses use the existing structured JSON error format; no raw credential enters JSON.

## Companion BFF boundary and remaining scope

The [dated amendment](decisions/auth-session-contract-a-01.md#2026-10-05-amendment--a-02-refresh-http-contract-closure) records the decisions that supersede the historical A-01 refresh HTTP TBDs; its cookie path is further clarified in the review follow-up below. The browser-facing Next.js BFF route and `X-CSRF-Token` forwarding are implemented in a separate DATN-FE change. A-03 browser recovery and programmatic token acquisition remain outside this branch. No full browser journey is claimed by backend tests alone.

## Validation

- MongoDB 7.0.43 `rs0` integration test: rotation, replay invalidation, user isolation, expiry, invalid legacy row, unknown token, and transaction rollback passed in a disposable test database.
- Focused service tests cover hash-only repository arguments, seven-day expiry, malformed credentials, failure without issuance, and CSRF rejection without token-state access.
- Focused controller and OpenAPI tests assert the decided HTTP status/body, cookie attributes, no-store response, generic error codes, and no replacement cookies on failure.
- `npm run check` had previously failed in existing E2E suites with Redis/BullMQ `Connection is closed` and `iam-secret.e2e-spec.ts` timeout. Re-run validation results for this extension are reported in PR #19.
