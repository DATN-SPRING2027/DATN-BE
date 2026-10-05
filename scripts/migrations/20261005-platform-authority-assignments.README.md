# Platform authority assignment collection and indexes

The A-04 IAM schema declares a separate `platform_authority_assignments`
collection in `continuum_iam`. Runtime `MONGODB_AUTO_INDEX` defaults to false,
so the schema declaration alone does not create the collection or its unique
assignment index. This migration creates only that collection and the declared
indexes. It never inserts, updates, or deletes assignment or user data.

Run a dry-run against the same configured IAM target used by the service, save
the report, and review its database name, target fingerprint, duplicate keys,
invalid rows, existing indexes, and proposed action:

```sh
node scripts/migrations/20261005-platform-authority-assignments.mjs > platform-authority-dry-run.json
```

Apply only the exact clean reviewed report:

```sh
node scripts/migrations/20261005-platform-authority-assignments.mjs --apply --expected-report-sha256=<reportSha256>
```

Apply creates the collection if absent, creates missing schema-declared
indexes, then rereads the database and verifies the exact indexes and that the
record count did not decrease. Duplicate subject/permission/scope records,
malformed assignments, a conflicting index, or a collection name occupied by a
non-collection block apply. Resolve those cases with a separately reviewed
operational plan; this migration never repairs them automatically.

The unique index allows at most one assignment record for a User, permission,
and PLATFORM scope. Revocation and expiry are evaluated from the current record
on every authorization request. Initial assignment remains a controlled
operational/bootstrap follow-up; this migration is not a grant/revoke workflow.

The MongoDB integration test creates and drops only a randomly named test
database:

```sh
$env:MONGODB_INTEGRATION='true'; npm test -- --runInBand services/iam/infrastructure/mongodb/platform-operator.mongodb.spec.ts
```
