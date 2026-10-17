# Email registration outbox indexes

This additive migration creates `continuum_iam.email_registration_outbox` and
the indexes for one current registration per normalized email, one-time token
lookup, expiry cleanup, due-email polling, and expired-worker-lease recovery.
It does not modify user records or any existing collection. IAM disables
automatic index creation in persistent environments, so apply the reviewed
migration before enabling registration routes or the delivery worker.

The migration defaults to a read-only dry-run. It does not load `.env` files.
The report includes the fixed database name, credential-free target
fingerprint, collection type and count, malformed/duplicate record counts,
index actions, and a report hash. Apply or rollback requires the exact reviewed
hash:

```powershell
$env:MONGODB_URI = 'mongodb://...'
npm run migrate:email-registration-outbox
npm run migrate:email-registration-outbox -- --apply --expected-report-sha256=<reviewed-sha256>
```

Rollback drops only indexes whose names and definitions exactly match this
migration. It preserves the collection and all documents. Stop the BE
registration routes and worker before rollback; never drop the collection as
part of routine rollback.

The TTL index uses `expiresAt` with zero delay; MongoDB cleanup is asynchronous,
so token verification must check `expiresAt` in application logic. The
30-minute expiration is independent of TTL cleanup timing.

Every required index uses explicit `simple` collation so normalized emails and
opaque token hashes keep exact-match semantics. Preflight records the
collection's default collation and blocks apply or rollback when it is not
`simple`; a new collection is created with `simple` as its default. Rollback
compares the index collation and the existing index options before dropping it.
