# Email/password registration with email verification link

**Status:** Approved by Thang on 2026-10-17; implementation in progress.
**Scope selected by Thang:** email verification link, with FE, BE and DB delivered on separate branches/PRs.
**Authority:** the approved account-onboarding decision allows a future email/password self-registration flow and requires an account-only identity. It does not specify the verification protocol. This proposal completes that missing contract; it does not amend unrelated Organization or Platform authorization rules.

## User flow

1. The signup page collects a name and email, then requests registration. It does not collect or transmit a password yet.
2. IAM records a short-lived pending registration and sends a one-time verification link. The response is generic and does not reveal whether the address already has an account or whether email delivery succeeded.
3. The email link opens the FE verification page with the token in the URL fragment. The page removes the fragment from browser history immediately and asks the user to choose a password.
4. The FE posts the token and password to IAM. After successful verification, the user signs in normally. Login creates an ACCOUNT session; the flow creates no Organization, membership, role, or Platform authority.

The password is selected after the email link is opened. This avoids storing a password before ownership of the email address is proven and prevents an unverified registration request from reserving an account with a password chosen by someone else.

## Proposed OpenAPI contract

### POST /api/v1/auth/registrations

Public request to start or restart registration.

Request body, JSON, additionalProperties false:

    { "fullName": "Thang Nguyen", "email": "thang@example.com" }

- fullName: required string, 1–160 characters after trimming.
- email: required email string, maximum 320 characters; normalize with trim + lowercase.
- This endpoint does not accept a password.

Responses:

- 202 { "status": "accepted" } for every valid request. The body and headers are the same whether the email is new, already belongs to a password account, is ineligible, or the SMTP provider later accepts/rejects delivery. Do not set authentication cookies.
- 422 VALIDATION_FAILED for malformed fields.
- 429 TOO_MANY_REQUESTS for request limits, with Retry-After.
- 503 EMAIL_REGISTRATION_UNAVAILABLE when IAM cannot durably save the pending registration or encrypted mail intent. Do not falsely return 202 if storage failed.
- All responses use Cache-Control: no-store and Referrer-Policy: no-referrer.

A repeated valid request for an eligible pending address replaces the pending name and token, invalidating the previous link. Rate limiting applies by trusted source IP and normalized email. Proposed initial limits match the current password-reset implementation: 20 requests per source IP and 3 per normalized email per 15 minutes.

### POST /api/v1/auth/registrations/verify

Completes registration after the recipient opens the link and chooses a password.

Request body, JSON, additionalProperties false:

    { "token": "43-character-base64url-token", "password": "a password of at least 12 characters" }

- token: required, exactly 43 base64url characters, write-only.
- password: required, 12–72 characters and no more than 72 UTF-8 bytes, write-only; match the existing password-reset credential policy.
- The FE also asks the user to confirm the password locally; the confirmation value is not sent.

Responses:

- 204 after the account change and one-time token consumption commit. Do not issue a session cookie; the FE directs the user to sign in.
- 400 EMAIL_REGISTRATION_TOKEN_INVALID for missing, expired, superseded, or already-used tokens, using one generic response.
- 422 VALIDATION_FAILED for malformed fields or password policy violations.
- 429 TOO_MANY_REQUESTS for confirmation limits, with Retry-After.
- 503 EMAIL_REGISTRATION_VERIFICATION_UNAVAILABLE if the account transaction or token store is unavailable; preserve the token for a safe retry when the transaction did not commit.
- All responses use Cache-Control: no-store and Referrer-Policy: no-referrer.

### Email identity and existing accounts

- If no normalized email exists at confirmation, create one ACTIVE User with the submitted fullName and password hash.
- If the address belongs to an ACTIVE Google-only User, add the password credential to that same User. Preserve its Google subject and existing profile name.
- Never create a duplicate User for a normalized email.
- Existing password accounts and ineligible accounts receive no registration email and are not changed; the request still gets the same generic 202. The user can use normal sign-in or password reset.
- Registration verification never activates or changes a suspended/ineligible account.

## Token, email and logging rules

- Generate a 256-bit cryptographically random token; store only its SHA-256 digest.
- Token lifetime: 30 minutes; single-use. Issuing a replacement invalidates the earlier token.
- Put the token in the fragment of a same-origin FE URL, for example /verify-email#token=...; never put it in a query string or server request path.
- The FE removes the fragment before displaying the page and only submits verification after the user explicitly chooses a password and confirms.
- Store the mail payload encrypted and send it asynchronously through the existing SMTP configuration and durable-outbox pattern. SMTP acceptance is not represented as proof of inbox delivery.
- Do not log the token, password, email body, or SMTP credentials. Apply the existing FE request-log suppression pattern to /verify-email.
- The BFF forwards the new POST endpoints to the Gateway; the Gateway forwards trusted source-IP proof to IAM, consistent with password-reset routes.

## Database and rollout dependency

The pending-registration/outbox collection and its indexes are specified in the separate DB work package email-password-registration-db-proposal-v1.md. The BE implementation must not ship until the DB migration is reviewed and applied in the intended environment. No existing migration may be edited.

## Acceptance behavior

- A valid request never authenticates the caller and never creates a User before token confirmation.
- Invalid/expired/replayed tokens do not create or mutate a User.
- Confirmation creates a verified password account or adds a password to the matching active Google-only User, without creating organization authority.
- Existing password accounts and ineligible users cannot be taken over through this flow.
- No password or verification token is sent in a URL, stored in browser storage, or returned in a response.
- User-enumeration behavior is the same for every syntactically valid registration request.

## Approval record

Thang approved this proposal on 2026-10-17. The request/response/error shapes, password-after-link sequence, Google-only account-linking behavior, 30-minute token lifetime, and rate-limit policy are the implementation contract.
