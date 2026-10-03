# `capture_drafts` 30-day retention indexes

## MongoDB 7 semantics

The retention decision is approved: a draft is retained for 30 days from its
`lastSavedAt` value. MongoDB TTL indexes are single-field indexes. A TTL index
expires a document after the configured seconds have elapsed from the indexed
BSON Date; a missing field or a value that is not a Date does not expire. TTL
cleanup is asynchronous and does not guarantee deletion at the exact expiry
instant. A unique compound index prevents two documents from having the same
combination of indexed values. See the official [MongoDB 7 TTL index
documentation](https://www.mongodb.com/docs/v7.0/core/index-ttl/) and [unique
index documentation](https://www.mongodb.com/docs/v7.0/core/index-unique/).

The Mongoose schema already declares `lastSavedAt` as a required `Date`.
`capture_drafts` does not currently have a MongoDB collection validator, and
the repository has no application persistence operation that writes drafts.
The schema is therefore the current application-level type declaration; the
migration also inspects actual stored BSON types before enabling TTL.

## Index definitions

Current repository declaration before this package (a definition MongoDB 7
rejects with `CannotCreateIndex` / code 67):

```js
{ userId: 1, contextKey: 1 } // expireAfterSeconds: 0; not unique
```

If created without the rejected TTL option, the MongoDB-generated compound
name is `userId_1_contextKey_1`. The `lastSavedAt` field had no index. No
application code referenced either index by name.

Target definitions:

```js
{ userId: 1, contextKey: 1 }, { unique: true }
{ lastSavedAt: 1 }, { expireAfterSeconds: 2592000 }
```

No explicit index names are set; MongoDB generates `userId_1_contextKey_1` and
`lastSavedAt_1`.

## Existing database transition

`20261003-capture-drafts-ttl.mjs` is a separate, report-first index migration.
It is restricted to the legacy migration source database `continuum_db` or the
Capture owner database `continuum_capture`; the operator must set
`CAPTURE_DRAFTS_TTL_DATABASE` explicitly. It requires `MONGODB_URI`, disables
Mongoose auto-indexing, and prints the selected database and a credential-free
target fingerprint.

Run the read-only report and retain the JSON output:

```powershell
$env:CAPTURE_DRAFTS_TTL_DATABASE = 'continuum_db'
node scripts/migrations/20261003-capture-drafts-ttl.mjs > capture-drafts-ttl-dry-run.json
```

The report gives exact total, missing-`lastSavedAt`, non-Date, duplicate
`userId + contextKey`, and already-expired counts. It includes bounded examples
with document IDs and BSON timestamp types/dates; duplicate-pair examples also
include the indexed user/context values. It never emits draft content. An
already-expired Date is one for which `lastSavedAt + 2592000 seconds <=
reportAsOf`. Enabling TTL makes those drafts eligible for MongoDB cleanup, so
review the report examples/count before apply.

Apply is blocked if the collection is absent, any `lastSavedAt` is missing or
not a BSON Date, duplicate user/context pairs exist, the report hash changed,
or capture draft writes are not explicitly paused. Missing/non-Date records are
not rewritten, assigned a fallback time, or deleted. They require a separate
data decision and a new report before TTL can be enabled. The migration also
requires `--expired-drafts-reviewed` when the reviewed report finds existing
expired documents. Immediately before changing indexes, the apply function
rechecks collection data and index metadata against the reviewed report; any
change blocks apply and requires a fresh report.

After confirming the database, report hash, and write pause, apply only the
reviewed report:

```powershell
node scripts/migrations/20261003-capture-drafts-ttl.mjs `
  --apply `
  --capture-draft-writes-paused `
  --expired-drafts-reviewed `
  --expected-report-sha256=<reportSha256> `
  --report-as-of=<reportAsOf>
```

The script removes only an observed replaceable `userId + contextKey`
non-unique legacy index, creates/verifies the unique compound index, then
creates or converts the single-field `lastSavedAt` TTL index. Writers must stay
paused through post-apply verification. The script issues no document delete
or rewrite command. Once the TTL index is active, MongoDB itself can
asynchronously remove documents whose Date is beyond the approved retention
window, even if a later verification step fails. An apply can therefore leave
partially transitioned indexes; inspect the resulting index state, take a fresh
dry-run, and review its new hash before retrying. The TTL report/review is the
gate for MongoDB's policy-driven expiration.

Run separate reports for each database that actually contains this
collection. Never point this migration at production or a shared database as
part of this work package; no real database apply was run here.

## Disposable MongoDB 7 integration

This test requires the dedicated local fixture on port `27019`, replica set
`rs0`, and a marker in `admin`. It refuses non-loopback hosts, credentials,
other ports, wrong server versions, and missing markers. The test creates and
drops only `continuum_capture` on that fixture.

```powershell
docker run --detach --rm --name datn-capture-drafts-ttl-mongo7-disposable `
  --publish 127.0.0.1:27019:27019 mongo:7.0 `
  mongod --port 27019 --replSet rs0 --bind_ip_all `
  --setParameter ttlMonitorSleepSecs=1 --setParameter enableTestCommands=1
docker exec datn-capture-drafts-ttl-mongo7-disposable `
  mongosh 'mongodb://127.0.0.1:27019/admin' --quiet `
  --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27019'}]})"
docker exec datn-capture-drafts-ttl-mongo7-disposable `
  mongosh 'mongodb://127.0.0.1:27019/admin' --quiet `
  --eval "db.getSiblingDB('admin').getCollection('datn_migration_test_fixture').insertOne({_id:'datn-capture-drafts-ttl-mongo7-disposable'})"
$env:MONGODB_INTEGRATION = 'true'
$env:MONGODB_INTEGRATION_TARGET = 'datn-capture-drafts-ttl-mongo7-disposable'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27019/?replicaSet=rs0'
npm run test:capture-drafts-ttl:integration
docker rm --force datn-capture-drafts-ttl-mongo7-disposable
```

The integration verifies MongoDB 7 rejects the old compound TTL definition,
malformed-data preflight blocks before index changes, the closest compatible
legacy compound index transitions to the unique target, duplicate pairs are
rejected, TTL metadata is exact, expired data is eventually removed by
MongoDB, fresh and updated drafts remain, missing/non-Date values remain
unexpired, and an unrelated collection is unchanged.
