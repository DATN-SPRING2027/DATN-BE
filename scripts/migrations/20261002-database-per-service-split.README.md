# Database-per-service data split

The accepted topology stores each active bounded service in its own logical
MongoDB database on the existing cluster. The old `continuum_db` remains the
read-only source during copy and rollback verification. This migration never
updates or deletes source documents.

## Dry run

Set `MONGODB_URI` for the intended cluster. The script loads the local `.env`
when present and scans `continuum_db` plus all nine accepted target databases.
It outputs a deterministic report with every source record ID and content
digest, destination action, destination-only records, index differences,
unique-index collisions, unowned collections, and the target fingerprint.
The SHA-256 binds the full report, data digests, indexes, endpoint, and exact
runner/planner contents, but does not expose connection credentials.

```sh
node scripts/migrations/20261002-database-per-service-split.mjs > database-per-service-split-dry-run.json
```

`clean: false` exits with code 2. Do not apply while the report has unowned
collections, same-ID content conflicts, incompatible collection/index options,
unique-index collisions, or an index pattern the preflight cannot verify.
In particular, legacy `outbox_events` has no stored service owner and blocks
the split until an authoritative ownership/cutover decision resolves it.
Target-only records are reported and preserved; review them as existing data.

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

The mapping is restricted to the active BE/Helm service inventory recorded in
ADR-003/DEC-011. `continuum_task` and `continuum_ai_adapter` are not target
databases in this migration because their current service owners and runtime
deployment contracts are not implemented/reconciled in DATN-BE.

## ARCHITECTURE / INVENTORY RECONCILIATION — FOLLOW-UP

The current BE runtime includes `continuum_jira` while Product docs describe
Jira as historical. This migration keeps the runtime database mapping as-is; it
does not remove, rename, or reassign Jira data. Reconcile that inventory
separately before changing database ownership.
