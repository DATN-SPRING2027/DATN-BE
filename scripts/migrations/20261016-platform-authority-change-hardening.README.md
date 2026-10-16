# Superseded platform authority hardening migration

This committed migration is retained as historical source and must not be run
for the current DATN-295 contract. It creates the proposed 365-day TTL index and
per-permission locks. The retention proposal is not approved, and per-permission
locks do not serialize lifecycle changes across the full A-04 bundle.

The report redacts assignment/operation identifiers, but that does not close the
external Security/IAM, Audit/Privacy/Legal, or staging/production DB-evidence
gates. Use the new
`20261016-platform-authority-change-v2-lifecycle.mjs` only after those gates
close. It creates the common lifecycle lock, adds the bundle lookup index, and
removes the exact proposed TTL index without deleting ledger records.

No migration has been applied or verified in a live environment by this change.
