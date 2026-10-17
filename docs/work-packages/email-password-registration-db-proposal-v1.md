# Email/password registration storage proposal V1

**Status:** Approved by Thang on 2026-10-17; implementation in progress.
**Branch:** feat/Thang-auth-signup-db
**Base:** updated origin/main at 01f259720596119ec689d725f9a3796a78db2676
**Scope:** additive IAM storage for pending email/password registration; coordinated with separate BE and FE branches.

## Storage contract

Add one collection in continuum_iam:

- email_registration_outbox: one pending registration plus its durable verification-email intent, keyed by normalized email.

Proposed document fields:

- normalized email and fullName for pending registration;
- tokenHash (SHA-256 digest only) and expiresAt;
- deliveryStatus, encryptedPayload, attemptCount, nextAttemptAt, leaseId, leaseUntil, lastErrorCode, and sentAt for asynchronous delivery;
- `tokenClaimId` and `tokenClaimUntil` metadata used to serialize confirmation and allow retry after a worker/process interruption;
- timestamps.

The document contains no raw password and no raw verification token. User passwords are chosen only after the link is opened. The encrypted payload contains only the email recipient and verification URL. Clear the encrypted payload after successful send or terminal failure; retain the token digest until confirmation or expiry. Expired documents are removed by the TTL index.

For every syntactically valid request, persist a row so storage failure does not reveal whether the address is eligible. Ineligible addresses use `deliveryStatus: IGNORED`, no encrypted payload, and a random undelivered token digest; they never receive an email and cannot complete verification. Eligible new addresses and active Google-only accounts use `PENDING` and an encrypted payload.

Indexes proposed:

- unique normalized-email index: one current pending registration per address;
- unique token-digest index;
- TTL index on expiresAt;
- pending-delivery job index;
- expired-worker-lease index.

Existing users records are not rewritten. IAM creates a new User only after a valid confirmation, or adds a password hash to an existing ACTIVE Google-only User with the same normalized email. No Organization or membership data is part of this storage change.

## Migration behavior

Add a new guarded migration and planner; do not edit 20261014-password-reset-outbox or any other existing migration.

The migration dry-run should report the fixed IAM database name, credential-free target fingerprint, collection type/count, malformed or duplicate email/token records, exact index actions, issues, and a report hash. It must block a non-collection name collision, malformed existing documents, duplicate normalized email/token digests, and incompatible same-name/equivalent indexes before applying unique indexes.

Apply creates only the new collection and named indexes after the DB owner reviews the target-specific dry-run and supplies its exact report hash. Do not run migration apply as part of this code task.

## Data, security, and configuration impact

- No existing account data is migrated or altered.
- Unverified registrations temporarily store email and full name as ordinary IAM account PII; the existing users collection already stores these account fields. No password or raw token is persisted.
- The email payload is encrypted at rest. Proposed configuration is optional EMAIL_REGISTRATION_OUTBOX_KEY (at least 32 characters), with a purpose-specific key derived from JWT_SECRET when omitted, matching the existing reset-outbox key lifecycle. Keep the selected key stable while unexpired mail jobs exist.
- Runtime uses the existing SMTP settings and WEB_APP_URL. No live database was inspected or modified for this proposal.
- Registration documents expire after the 30-minute token lifetime. TTL deletion is asynchronous; token verification must still compare expiresAt in application logic.

## Rollback

Disable/roll back the BE registration routes and worker first. A reviewed rollback migration drops only the named indexes and preserves the collection and any remaining documents. Do not drop the collection or delete documents during routine rollback. Re-enable registration only after the exact indexes are restored and verified.

## Approval record

Thang approved the storage design and BE contract on 2026-10-17. The collection name, fields, uniqueness/TTL/delivery indexes, 30-minute retention, encrypted payload/key behavior, and index-only rollback are the implementation contract.
