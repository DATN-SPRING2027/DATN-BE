# Project Access permission provisioning V1

- **Work item:** Jira `DATN-82` / Epic `DATN-73` / B-02
- **Status:** implementation package; environment apply requires a separately reviewed dry-run
- **Implementation branch:** `feat/B-02-project-access-permission-provisioning-v1`
- **Authority:** [Project Access & Visibility V1 decision](../decisions/project-access-visibility-v1.md)

## Purpose and boundaries

The accepted Project Access decision defines five V1 permissions but leaves
provisioning them into existing system Roles to a separate DB work package.
This package adds only missing approved codes to the existing `ADMIN` and
`TEAM_LEADER` records in the IAM database.

It does not change authorization policy or API behavior, create Roles, change
`project.read`, modify other Roles, add schema/indexes, rewrite malformed Role
data, or connect to a production database during implementation and testing.
The BE continues to deny an action if the current Role or permission evidence
is absent or invalid. No permission code is inferred from external research.

## Accepted mapping

| Existing Role | Required assignment scope | Codes added by this package                                             |
| ------------- | ------------------------- | ----------------------------------------------------------------------- |
| `ADMIN`       | Organization              | `project.visibility.manage`, `project.leader.manage`                    |
| `TEAM_LEADER` | Project                   | `project.members.list`, `project.members.add`, `project.members.remove` |

`project.members.role.change` is disabled and is never added. If a known
Project Access code is present on the wrong Role, or the disabled code is
already present on either target Role, preflight blocks. Operators must not
use this migration to move or delete existing permissions. Existing unrelated
permission values are preserved. The current `project.read` value on
`TEAM_LEADER` is preserved as well.

## Current implementation facts

- The authorization evaluator already recognizes the accepted V1 mapping and
  denies missing or unsupported evidence. This package does not change runtime
  code.
- The IAM `Role` schema stores `permissions` as strings with an empty-array
  default and `isSystem` as a Boolean. It has no permission-code enum or
  system-Role seeding path.
- IAM database selection follows `resolveIamDatabaseName`: shared MongoDB mode
  uses `MONGODB_DATABASE`; service-owned mode uses `continuum_iam` when
  `INFRA_ENABLED=true`; disabled persistence is refused.

## External practice (non-authoritative)

MongoDB's [`$addToSet`](https://www.mongodb.com/docs/manual/reference/operator/update/addToSet/)
adds an array member only if it is absent, and `$each` applies it to several
values. It does not remove duplicates that already exist, so this package
blocks on duplicate or malformed permission arrays before writing. The
[OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
recommends deny-by-default authorization. That supports preserving the existing
fail-closed behavior; neither source determines DATN's role mapping. The
accepted DATN decision remains the only authority for the codes and placement.

## Report, apply, and recovery

The script reads `MONGODB_URI` from the process environment and does not load
`.env`. Its default mode is read-only. It reports the selected IAM database,
credential-free target fingerprint, each target Role identity, its existing
and missing permissions, preflight findings, and `reportSha256`.

Preflight blocks when the `roles` collection is absent or not a collection;
either target Role is missing or duplicated; an ID is not an ObjectId; a target
Role is not marked `isSystem`; the permission field is not an array of unique
strings; or a known Project Access permission is misplaced/disabled. A missing
`permissions` field is treated as an empty value because the Role schema
defaults it to an empty array; apply creates the field through `$addToSet`.
No normalization or cleanup is attempted.

From the repository root, set the same database-selection flags used by the
target IAM runtime and retain the complete dry-run report:

```powershell
$env:MONGODB_URI = '<approved MongoDB URI>'
$env:MONGODB_ENABLED = 'false'
$env:INFRA_ENABLED = 'true'
node scripts/migrations/20261012-project-access-permission-provisioning.mjs > project-access-permissions-before.json
$before = Get-Content -LiteralPath 'project-access-permissions-before.json' -Raw | ConvertFrom-Json
```

Review the database name, fingerprint, two Role IDs, exact additions, and empty
`issues` list. Apply requires the hash from that same report:

```powershell
node scripts/migrations/20261012-project-access-permission-provisioning.mjs --apply "--expected-report-sha256=$($before.reportSha256)" > project-access-permissions-apply.json
```

Immediately before each Role update, the migration matches its observed ID,
code, `isSystem`, and complete current permission array. It adds only the
reported codes with `$addToSet`/`$each`, then rereads and verifies both Roles.
If another writer changes a target Role after review, the report hash or guarded
update fails. Updates are individually guarded and idempotent; the two Role
updates are not a multi-document transaction. If interrupted between Roles,
run and review a new dry-run before retrying. The rerun adds only what remains
missing.

To roll back a completed apply, retain the original clean pre-apply JSON
report. First run a fresh dry-run after apply and review it; pass its new hash
and the saved original report:

```powershell
node scripts/migrations/20261012-project-access-permission-provisioning.mjs > project-access-permissions-after.json
$after = Get-Content -LiteralPath 'project-access-permissions-after.json' -Raw | ConvertFrom-Json
node scripts/migrations/20261012-project-access-permission-provisioning.mjs --rollback "--expected-report-sha256=$($after.reportSha256)" --rollback-from-report=project-access-permissions-before.json
```

Rollback checks that the saved report is unchanged, targets the same IAM
database, and identifies the same Role IDs. It removes only approved codes
that were missing in that saved pre-apply report; it preserves permissions
that were already present and all other Role values. If the Roles changed,
rollback fails closed and requires investigation rather than a blind delete.

No live or production database apply was part of B-02 implementation. A
database operator must use the environment's normal review and maintenance
process before applying an environment-specific report.

## Validation coverage

- Planner tests assert the exact accepted mapping, missing-code plan,
  idempotent `NOOP`, no duplicate permission values, Role placement,
  fail-closed malformed/missing/duplicate evidence, report binding, and
  constrained rollback.
- Disposable MongoDB integration asserts missing/duplicate Role and disabled
  permission preflights, stale-report refusal, exact `$addToSet` behavior,
  rerun idempotence, preservation of unrelated Roles/permissions, and rollback
  of only migration additions.
- Existing IAM Project Access policy and guard tests remain the regression
  checks for explicit scope and deny-by-default behavior.

For a local disposable MongoDB 7 replica set, reserve port `27019` and start
the fixture:

```powershell
docker run --detach --rm --name datn-project-access-permissions-mongo7 `
  --publish 127.0.0.1:27019:27019 mongo:7.0 `
  mongod --port 27019 --replSet rs0 --bind_ip_all
docker exec datn-project-access-permissions-mongo7 `
  mongosh 'mongodb://127.0.0.1:27019/admin' --quiet `
  --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27019'}]})"
docker exec datn-project-access-permissions-mongo7 `
  mongosh 'mongodb://127.0.0.1:27019/admin' --quiet `
  --eval "db.getSiblingDB('admin').getCollection('datn_migration_test_fixture').insertOne({_id:'datn-project-access-permission-provisioning-mongo7-disposable'})"
$env:MONGODB_INTEGRATION = 'true'
$env:MONGODB_INTEGRATION_TARGET = 'datn-project-access-permission-provisioning-mongo7-disposable'
$env:MONGODB_INTEGRATION_PORT = '27019'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27019/?replicaSet=rs0'
npm run test:project-access-permissions:integration
docker stop datn-project-access-permissions-mongo7
```

The integration refuses other hosts/ports, credentials, MongoDB versions,
replica-set configurations, and fixture markers. It creates and drops only
`continuum_iam_project_access_provisioning_integration` after confirming that
database did not exist before the test. CI uses its own ephemeral MongoDB
replica set and the same fixture marker.

## Traceability

`DATN-82` → [Project Access & Visibility V1](../decisions/project-access-visibility-v1.md)
→ this B-02 package → `20261012-project-access-permission-provisioning.mjs`
and its planner → planner/MongoDB tests → B-02 implementation PR.

The permission mapping above is an accepted **DECISION** from the linked
Project Access decision. The report-first migration and guarded additive update
are this package's **DESIGN**. External MongoDB and OWASP sources are
non-authoritative **RESEARCH**. No policy, API, or authorization behavior is
introduced by the migration.
