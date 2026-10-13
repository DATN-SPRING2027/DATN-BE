# Password reset contract

**Status:** Implementation contract pending explicit owner/product/security approval. The values below describe the behavior implemented in this PR; they are not a record that every policy choice has been approved.

## Proposed behavior

- `POST /api/v1/auth/password-reset/request` accepts an email address and always
  returns `202 { "status": "accepted" }` for valid input. The response does not
  reveal whether an account exists or whether email delivery succeeded.
- Only an ACTIVE account receives an email. An ACTIVE Google-only account may
  use the email link to set a local password. Missing and inactive accounts
  receive the same API acknowledgement.
- The request is rate-limited by trusted source IP and normalized email. The
  email and IP are SHA-256 digests in Redis rate-limit keys.
- The email contains a cryptographically random, single-use token with a
  30-minute lifetime. Redis stores only the token digest; issuing a newer token
  invalidates an older link for that account.
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
  revokes all refresh sessions in one MongoDB transaction, then clears the
  current browser's access, refresh, and CSRF cookies. Access JWTs in other
  browsers remain valid until their existing 15-minute expiry.
- Both endpoints return `Cache-Control: no-store` and `Referrer-Policy:
  no-referrer`. Tokens, email addresses, and SMTP errors are not logged. The FE
  also suppresses incoming-request logs on the reset page as defense in depth.

## Configuration

The IAM process uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_SECURE`, and `MAIL_FROM` to send reset email. `WEB_APP_URL` is the public
FE origin used to form the reset link. Production requires an HTTPS `WEB_APP_URL`.

## Failure behavior

- Invalid request fields return 422 without performing account lookup.
- Rate-limit failures return 429 without performing account lookup for a
  request operation.
- If email delivery fails, the issued token is discarded when possible and
  the API still returns the generic 202 acknowledgement.
- A database failure while confirming a token returns the normal server error;
  the token remains consumed, so the user can request another reset link.
