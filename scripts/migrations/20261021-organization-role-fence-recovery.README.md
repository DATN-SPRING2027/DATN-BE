# ORG-08 missing role fence recovery — disposable MongoDB 8 validation

Scope authorized by Danh (Project Lead), 2026-10-21: a **new** DB recovery
change for missing `role_assignments.mutationFence`, tested on a disposable
restore. This is a narrow MongoDB 8 development-recovery validation; it does
not revise the backend guide's MongoDB 7 operational baseline or activate A7/A8.

## Data impact and compatibility

Before: existing Organization/Project assignments can have an absent
`mutationFence`. The current Organization membership reader refuses that shape.
After: only absent fences receive integer `0`. Existing valid fences, IDs,
role codes, subjects, Organization/Project scope, timestamps and unknown fields
are preserved. Invalid existing fences/metadata block the entire plan. No
catalog, permission, Membership, schema, validator, collection or index change
is performed by the recovery tool. Historical migrations are unchanged.

The CLI intentionally supports **authenticated, marked, loopback disposable
MongoDB 8 replica sets only**, database `continuum_iam`, replica-set prefix
`org08-mongo8-recovery-`. It does not load `.env`, accept SRV/remote URIs, use
the application's Mongo URI, or support running against development,
Staging or Production. An isolated-fixture owner creates the marker in
`admin.datn_migration_test_fixture`: `_id` equal to
`org08-mongo8-fence-recovery-disposable`, `environment: DISPOSABLE_LOCAL`,
and `replicaSet` equal to the actual owned replica-set name. This marker is a
fixture prerequisite, not an instruction to mark an existing database safe.

## Reproduce

```sh
node --test scripts/migrations/organization-role-fence-recovery.plan.test.mjs
node --test scripts/migrations/20261021-organization-role-fence-recovery.mongodb.test.mjs
```

The integration suite starts and disposes its own authenticated MongoDB
**8.0.17**. It does not use any application URI. It covers 12 missing fences
among 22 synthetic assignments, dry-run, exact metadata preservation,
idempotent replay, concurrent apply/replay, CAS after role/version drift,
stale plan rejection, server validation failure with transaction rollback,
offline snapshot restoration, invalid input, missing marker and plan tampering.

On a separately verified owned disposable restore, inject its local connection
through `ORG08_RECOVERY_MONGODB_URI` using a secret-safe mechanism. Never paste
credentials into commands, reports, tickets or PR descriptions.

```sh
# Dry-run; writes no document. Review target, counts, findings and planHash.
node scripts/migrations/20261021-organization-role-fence-recovery.mjs > reviewed-plan.json
# Only on the same disposable restore, after review and stopping its writers:
node scripts/migrations/20261021-organization-role-fence-recovery.mjs --apply --writers-paused --reviewed-plan=reviewed-plan.json
```

The report contains hashes/counts and sanitized finding fingerprints; it is
not a backup and its digest is not an approval. Bind it to the execution
record, target, code SHA and authorized reviewer. Scan budgets are reused from
the existing migration framework. All updates run in one snapshot transaction
with majority commit, matching the absent field and exact original document.
Any intervening document/scope/version change invalidates the reviewed plan.
A lost-response retry accepts only the exact predicted final snapshot and
reports `REPLAYED` with zero writes. Transaction failure leaves no partial
update. The operator must still quiesce every relevant writer; CAS is an
additional safeguard, not a substitute for that prerequisite.

## Recovery and release limits

The fixture proves failed-transaction rollback and a separate offline
before-image restore drill. This drill deliberately returns a disposable
database to its original legacy shape; it is **not** a live rollback command.
Do not unset/reset a valid fence after runtime usage: that can reopen stale
versions. Prefer reviewed forward recovery after inspecting the actual
transaction result. Before any future non-disposable recovery, obtain a
recoverable backup and validate source indexes/validators, writer controls,
version compatibility and a separate reviewed recovery procedure. This tool
does not authorize or provide that source-apply path.

The actual development export was MongoDB 8.0.34; fixture/restore testing on
8.0.17 proves tested MongoDB 8 behavior, not exact patch parity. Exported role
metadata is not a full source database backup; source validator/index parity
and runtime consumer readiness remain unverified. Production remains locked.

## Database change notification (draft; not sent)

```text
[DATABASE CHANGE]
Collection/Entity: role_assignments
Change: new disposable Mongo8 recovery tool for absent mutationFence -> 0.
Data impact: local disposable targets only; no source changes performed.
Migration: new 20261021-organization-role-fence-recovery.mjs; historical Mongo7 migration unchanged.
PR type: Database
PR: populated in the PR handoff after creation
```
