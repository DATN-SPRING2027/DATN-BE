# Password reset contract

**Status:** Owner has selected bcrypt and the durable email outbox behavior below. Other policy values such as token lifetime and rate limits remain subject to product/security approval.

## Proposed behavior

- `POST /api/v1/auth/password-reset/request` accepts an email address and
  returns `202 { "status": "accepted" }` for valid input when the durable
  request store is available. A persistence outage returns the same generic
  `503 PASSWORD_RESET_REQUEST_UNAVAILABLE` for all accounts. The response does
  not reveal whether an account exists or whether SMTP accepted the message.
- Only an ACTIVE account receives an email. An ACTIVE Google-only account may
  use the email link to set a local password. Missing and inactive accounts
  receive the same API acknowledgement. To keep persistence failures generic,
  those requests also write a short-lived `IGNORED` marker with a random scope
  digest; it contains no recipient address or email payload.
- The request is rate-limited by trusted source IP and normalized email. The
  email and IP are SHA-256 digests in Redis rate-limit keys.
- The email contains a cryptographically random, single-use token with a
  30-minute lifetime. MongoDB stores the token digest and the email outbox job
  in one atomic `password_reset_outbox` document; issuing a newer token
  invalidates an older link for that account. If a concurrent request finds
  an unexpired reset entry already persisted for the account, it coalesces
  onto that entry and returns the same generic acknowledgement. The recipient
  and reset URL are encrypted with AES-256-GCM. IAM uses
  `PASSWORD_RESET_OUTBOX_KEY` when set, or
  derives a purpose-specific key from `JWT_SECRET` with HKDF. The raw token is
  never stored.
- `POST /api/v1/auth/password-reset/confirm` accepts the token and a new
  password of 12–72 characters, limited to 72 UTF-8 bytes for bcrypt storage.
  Invalid, expired, superseded, and consumed
  tokens share `400 PASSWORD_RESET_TOKEN_INVALID`.
- The emailed reset URL carries the token in its URL fragment (`#token=...`),
  so browsers do not send the credential in the HTTP request URL. The FE reads
  it client-side and immediately removes it from the address bar and history.
- The API Gateway forwards both reset endpoints to IAM and signs the trusted
  source-IP proof required by IAM for internal authentication routes.
- A successful confirmation updates the password for an ACTIVE account and
  revokes all refresh sessions in one MongoDB transaction. The reset token is
  claimed before hashing, remains available if hashing or the MongoDB
  transaction fails, and is consumed only after the transaction completes (or
  the account is confirmed inactive). The claim expires with the token and
  blocks duplicate confirmation and replacement requests while in flight. The
  endpoint then clears the current browser's access, refresh, and CSRF cookies.
  Access JWTs in other browsers remain valid until their existing 15-minute
  expiry.
- Both endpoints return `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`. Tokens, email addresses, and SMTP errors are
  not logged. The FE also suppresses incoming-request logs on the reset page
  as defense in depth.

## Configuration

The IAM process uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_SECURE`, and `MAIL_FROM` to send reset email. `WEB_APP_URL` is the public
FE origin used to form the reset link. Production requires an HTTPS `WEB_APP_URL`.
`PASSWORD_RESET_OUTBOX_KEY` is an optional stable secret of at least 32
characters. If omitted, IAM derives a purpose-specific key from `JWT_SECRET`;
keep the selected key stable while unexpired outbox jobs exist.

## Failure behavior

- Invalid request fields return 422 without performing account lookup.
- Rate-limit failures return 429 without performing account lookup for a
  request operation.
- The API returns 202 after the token digest and encrypted email job have been
  saved together, or when an unexpired reset entry already exists and the
  request coalesces onto it. SMTP is processed asynchronously by an IAM worker
  using an atomic 60-second lease. It makes at most five attempts: the first
  immediately, then retries after 30, 60, 120, and 240 seconds. SMTP success
  clears the encrypted recipient and URL from the outbox document. After the
  fifth failure the job is marked FAILED and the encrypted payload is erased;
  the token is then unusable and the user can request another link.
- Delivery is at-least-once: if SMTP accepts a message and IAM stops before
  persisting SENT, the worker may send the same still-valid link again after
  the lease expires. A duplicate email is possible; the token remains
  single-use. SMTP acceptance does not prove inbox delivery.
- A Redis rate-limit, MongoDB lookup/write, or encryption-key failure returns
  generic `503 PASSWORD_RESET_REQUEST_UNAVAILABLE`; it does not return a false
  202.
- The outbox collection requires the guarded
  `20261014-password-reset-outbox` index migration because automatic MongoDB
  index creation is disabled by default. Rolling the migration back removes
  only the indexes; rollback of the feature requires stopping the new IAM code
  first. Existing outbox documents expire through the TTL index after the
  token's 30-minute expiry. IAM verifies the declared indexes before handling
  reset work and returns the generic 503 / keeps the worker idle when they are
  missing or incompatible.
- A password-hash or MongoDB transaction failure returns the normal server
  error and releases the claim while preserving the token until its original
  expiry, allowing the same link to be retried when claim release succeeds. If
  MongoDB cannot release the claim, it remains until token expiry. If MongoDB
  cannot finalize token consumption after the password transaction succeeds,
  the claim remains until token expiry to prevent replay. These recovery cases
  still need runtime validation.
