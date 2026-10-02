# Database-per-service data split

The accepted topology stores each active bounded service in its own logical
MongoDB database on the existing cluster. The old `continuum_db` remains the
read-only source during copy and rollback verification. This migration never
updates or deletes source documents.

## Dry run

Set `MONGODB_URI` for the intended cluster. The script loads the local `.env`
when present and scans `continuum_db` plus all nine accepted target databases.
It outputs a deterministic report with every source record ID and content
digest, destination action, `targetOnlyCollections`, target-only records,
index differences, unique-index collisions, unowned collections, and the
target fingerprint. `targetOnlyCollections` lists every destination collection
without a corresponding mapped source collection and makes the report unclean,
including collections whose names exist in the inventory but are absent from
the current source. Target-only documents inside a source-mapped collection are
reported and preserved but do not alone make the report unclean. The SHA-256
binds the full report, data digests, indexes, endpoint, and exact runner/planner
contents, but does not expose connection credentials.

```sh
node scripts/migrations/20261002-database-per-service-split.mjs > database-per-service-split-dry-run.json
```

`clean: false` exits with code 2. Do not apply while the report has target-only
collections, unowned source collections, same-ID content conflicts,
incompatible collection/index options, unique-index collisions, or an index
pattern the preflight cannot verify. In particular, legacy `outbox_events` has
no stored service owner and blocks the split until an authoritative
ownership/cutover decision resolves it. Target-only documents in mapped
collections are reported and preserved; review them as existing data.

Unique-index preflight uses effective collation: explicit index collation,
otherwise collection default collation, otherwise simple collation. Non-simple
unique-index collation is reported as unverifiable and blocks apply rather than
approximating MongoDB collation behavior. An equivalent target index with a
different name blocks preflight; the runner never renames or drops indexes.
Same-key indexes with distinct collations and MongoDB-supported option variants
such as sparse versus non-sparse can coexist. Same-key/same-collation indexes
with conflicting TTL settings are blocked because MongoDB rejects them.

## Apply gate

This code change does not apply data. Before an environment cutover, take and
verify a backup, review a clean dry run, pause every writer to both source and
target databases, and coordinate the cutover separately. Then use the exact
reviewed report hash:

```sh
node scripts/migrations/20261002-database-per-service-split.mjs --apply --source-writes-paused --target-writes-paused --backup-verified --cutover-authorized --expected-report-sha256=<reviewed-reportSha256>
```

Apply rescans and rejects a changed report, creates only missing destination
collections/indexes, inserts only missing `_id` records with idempotent
upserts, and verifies every copied source record. Existing target records with
matching IDs and digests are no-ops. Conflicts stop the operation. Any
mid-copy failure leaves `continuum_db` intact; produce and review a fresh dry
run before retrying. The source remains available for rollback until a
separate cutover/retention decision authorizes otherwise.

The runner is not transactional. A failure after document copying can leave a
partial target. Recovery is a new dry-run, review of the resulting report, and
retry using that exact hash after resolving any blocking target state. The
source remains unchanged by the runner.

## Isolated MongoDB integration test

`20261002-database-per-service-split.integration.test.mjs` invokes the real
runner against a disposable local MongoDB 7 replica set. It requires a
loopback MongoDB instance on port 27018, no URI credentials, replica set `rs0`,
MongoDB test commands enabled, and the marker document in `admin` described
below. The test drops only the fixed source and service database names on that
fixture; never aim it at a shared or live database. It covers successful apply
and retry, deterministic index-creation failure after copying and recovery,
both P1 preflight blocks, allowed same-key index variants, destination-only
collection blocking, source preservation, and post-apply verification.

Create the disposable fixture:

```powershell
docker run --detach --name datn-pr13-mongo7-disposable --publish 127.0.0.1:27018:27018 mongo:7.0 mongod --port 27018 --replSet rs0 --bind_ip_all --setParameter enableTestCommands=1
docker exec datn-pr13-mongo7-disposable mongosh 'mongodb://127.0.0.1:27018/admin' --quiet --eval "rs.initiate({_id: 'rs0', members: [{_id: 0, host: '127.0.0.1:27018'}]})"
docker exec datn-pr13-mongo7-disposable mongosh 'mongodb://127.0.0.1:27018/admin' --quiet --eval "db.getSiblingDB('admin').getCollection('datn_migration_test_fixture').insertOne({_id: 'datn-pr13-mongo7-disposable'})"
```

After the replica set becomes primary, run:

```powershell
$env:MONGODB_INTEGRATION = 'true'
$env:MONGODB_INTEGRATION_TARGET = 'datn-pr13-mongo7-disposable'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27018/?replicaSet=rs0'
npm run test:migrations:integration
```

Remove the fixture afterward with `docker rm --force datn-pr13-mongo7-disposable`.

The mapping is restricted to the active BE/Helm service inventory recorded in
ADR-003/DEC-011. `continuum_task` and `continuum_ai_adapter` are not target
databases in this migration because their current service owners and runtime
deployment contracts are not implemented/reconciled in DATN-BE.

## ARCHITECTURE / INVENTORY RECONCILIATION — FOLLOW-UP

The current BE runtime includes `continuum_jira` while Product docs describe
Jira as historical. This migration keeps the runtime database mapping as-is; it
does not remove, rename, or reassign Jira data. Reconcile that inventory
separately before changing database ownership.
