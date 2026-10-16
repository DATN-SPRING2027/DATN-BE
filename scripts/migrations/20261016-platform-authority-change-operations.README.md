# Platform authority change operations collection and indexes

This migration provides the additive persistence support for the controlled PO-AUTH-01
procedure by creating the `platform_authority_change_operations` collection and its
declared indexes in `continuum_iam`. It does not mutate or rewrite existing
`platform_authority_assignments` or standalone legacy assignments.

Runtime `MONGODB_AUTO_INDEX` defaults to false, so the schema declaration alone
does not create the collection or its indexes on live environments.

## Dry-run inspection

Run a read-only dry-run against the configured target database:

```sh
node scripts/migrations/20261016-platform-authority-change-operations.mjs > platform-authority-change-operations-dry-run.json
```

Verify that `clean` is `true`, no duplicate operations or invalid records exist,
and the target fingerprint matches the reviewed target.

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
