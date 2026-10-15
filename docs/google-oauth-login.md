# Google OAuth sign-in and signup

## Provider setup

Create a Google OAuth 2.0 Web application client and register the exact callback
URI used by this frontend deployment. For the local FE port 3000 example:

```text
http://localhost:3000/api/auth/google/callback
```

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in the
runtime environment used by the IAM service. Set all three or leave all three
blank. `.env.example` deliberately contains no credentials. Rotate the Google
client secret that was previously shared in chat before configuring this
feature; use only the replacement value in a local ignored environment.

OAuth is disabled until all three settings are configured. `JWT_SECRET` must
also be present and at least 32 characters because it derives the encryption
key for the short-lived state cookie. The callback URL must point to the FE BFF,
not directly to the Nest service or Gateway; production callback URLs must use
HTTPS.

Before enabling Google login against MongoDB, review and apply the additive
IAM unique sparse subject index. Runtime index creation defaults to disabled;
the preflight, apply, and rollback steps are in the DB work package on branch
`feat/Thang-account-onboarding-db`, at
`scripts/migrations/20261011-google-identity-index.README.md`.

## Browser flow

1. Sign-in and signup screens navigate to `/api/auth/google` on the FE BFF.
2. The BFF and Gateway preserve the provider 302, encrypted state cookie,
   no-store header, and no-referrer policy for the browser.
3. Google returns code and state to `/api/auth/google/callback`.
4. IAM verifies and links the identity, then issues an `ACCOUNT` session unless
   an Organization was explicitly requested and revalidated. The callback BFF
   relays session cookies and returns the browser to `/select-organization`.
5. The chooser lists every active Organization membership for all
   Organization roles. With no active Organization, it offers Organization
   creation. Selecting one uses the existing session and IAM rechecks the
   selected membership before issuing Organization-scoped cookies. No second
   Google exchange is required.

The browser receives the same access, refresh, and CSRF cookies as password
login. Google provider tokens never enter browser code or IAM persistence.

## Account behavior and limits

- A first-time Google identity is keyed by Google `sub`.
- The IAM User schema requires a non-empty `passwordHash` unless a Google
  subject is present. Password registration therefore retains its persistence
  validation; Google-only Users do not receive a fake password hash.
- A verified Google email matching an existing internal User links to that
  account. A different already-linked Google `sub` is rejected.
- A provider-only User has no password hash, so password login does not work
  until a separate password enrollment/recovery flow is implemented.
- Google registration does not create an Organization, membership, role, or
  platform authority. An account without an ACTIVE Organization Membership
  can create its own FREE Organization and become its first ADMIN, or accept an
  email-bound invitation after signing in. Membership and Organization access
  remain separate from authentication.
- Organization ADMINs can create, view and revoke pending invitations. An
  invitation lasts seven days and can be accepted only by an active account
  with the matching normalized email. Invitation creation is limited to 30 per
  Organization/admin per hour.
- No email delivery provider is configured. The UI confirms that the invite
  was recorded and tells the administrator to notify the recipient out of
  band; it does not claim to send email.
- Accounts with MFA enabled are rejected by this flow until MFA is integrated
  into the OAuth session journey.

## Debugging callback failures

The FE BFF creates an `x-request-id`; the Gateway forwards it to the IAM
callback. IAM writes one-line JSON events with `event`, `requestId`, `stage`,
`status`, and, on failure, a stable `errorCode`. Search the backend terminal for
`google_oauth.callback` and follow entries with the same request ID. The stages
include configuration, state validation, code exchange, ID-token verification,
email verification, account resolution/linking, user persistence, organization
resolution, refresh-session persistence, token signing, and cookie response.
The FE terminal uses the same request ID for `bff_callback_received`,
`bff_backend_response`, and `bff_session_cookie_relay`; its `httpStatus` helps
separate an upstream HTTP error from a missing session-cookie response.
Next development-server request logging ignores the Google callback path so its
automatic request line does not print the authorization code or state query.
The safe structured BFF events remain enabled for that path.

Logs deliberately omit callback query values, state-cookie contents, Google
tokens, session cookies, client secrets, email addresses, and user IDs. Provider
error messages are translated to allowlisted error codes. For example,
`MONGOOSE_VALIDATION_ERROR` at `user_persistence` means schema validation
rejected the new account before MongoDB inserted a document;
`GOOGLE_REDIRECT_URI_MISMATCH` at `token_exchange` means the callback URL sent
to Google differs from the URL used during token exchange; and
`GOOGLE_SESSION_PERSISTENCE_FAILED` means account resolution succeeded but the
refresh session could not be stored.

The IAM repository is wired to the `continuum_iam` database connection. The
Google user write is one Mongoose `create` operation and is not enclosed in a
multi-document transaction, so a schema validation error is not a transaction
rollback. A later refresh-session failure can leave the newly created account
without a login session; the distinct `user_persistence` and
`session_persistence` events show that case.

An unauthenticated `GET /api/backend/auth/me` returning 401 before the callback
has issued session cookies is expected. It is not evidence that Google's
callback failed. Diagnose a sign-in attempt by the callback events sharing its
request ID. The BE schema now supports passwordless Google Users and declares
the unique sparse `googleSubject` index. Runtime auto-indexing defaults to
disabled, so the separate additive DB migration must still pass a read-only
preflight and be applied to the intended `continuum_iam` database before relying
on database-level subject uniqueness in a shared environment. The migration
creates an index only; it does not rewrite User documents. No real-database
preflight or index operation is performed by this code change.
