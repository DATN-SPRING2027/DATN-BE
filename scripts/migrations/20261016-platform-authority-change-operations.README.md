# Platform authority change operations collection and indexes

This migration describes the additive persistence support for PO-AUTH-01 by
creating the `platform_authority_change_operations` collection and its declared
indexes in `continuum_iam`. Its dry-run output contains counts and redacted
reasons only; it does not print document IDs or operation IDs. It does not mutate
or rewrite existing assignments.

Runtime `MONGODB_AUTO_INDEX` defaults to false, so the schema declaration alone
does not create the collection or its indexes on live environments.
The committed base migration's historical target index includes the former
single-permission field. The V2 lifecycle migration adds the current
`(targetUserId, committedAt)` index and preserves the older index; do not edit or
replay this migration after the external gates close.

## Dry-run inspection

Run a read-only dry-run against the configured target database:

```sh
node scripts/migrations/20261016-platform-authority-change-operations.mjs > platform-authority-change-operations-dry-run.json
```

Run this only after the external Security/IAM, Audit/Privacy/Legal, and DB
evidence gates are closed. Verify that `clean` is `true` and the target
fingerprint matches the reviewed target. The redacted report intentionally does
not identify individual records; any non-zero duplicate or invalid count blocks
apply and requires a separately authorized reconciliation process.

## Apply migration

Apply only the exact reviewed dry-run report SHA-256:

```sh
node scripts/migrations/20261016-platform-authority-change-operations.mjs --apply --expected-report-sha256=<reportSha256>
```

Apply creates the collection if absent, creates missing indexes, rereads the
database, and verifies that the exact declared indexes exist and document count did
not decrease.

## Rollback instructions

- **Before first use (empty collection):**
  If rollback is required before any operation has been committed to the ledger, drop
  the newly created empty collection after verifying the exact target:
  ```sh
  node -e "const m = require('mongoose'); m.connect(process.env.MONGODB_URI, { dbName: 'continuum_iam' }).then(async () => { const count = await m.connection.db.collection('platform_authority_change_operations').countDocuments(); if (count === 0) { await m.connection.db.collection('platform_authority_change_operations').drop(); console.log('Dropped empty collection'); } else { console.error('Cannot drop collection with committed operations'); } return m.disconnect(); });"
  ```
- **After committed operations exist:**
  Do NOT drop the collection or audit records. Disable procedure execution and use a
  forward fix or restore plan.
