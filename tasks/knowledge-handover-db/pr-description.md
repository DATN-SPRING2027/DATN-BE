# feat(handover): add versioned handover database contract

Handover storage currently requires a successor on each legacy item and cannot
represent waiting for a successor, version-bound acknowledgement, evidence
review or independently tracked knowledge gaps. Add explicit V2 storage while
preserving legacy records and their original verification semantics.

## Scope

- One canonical physical contract for Mongoose and a new additive migration:
  three existing collections gain separate V2 models, six collections are new,
  and 18 indexes support scoped listing, revision identity and durable operations.
- Nullable single successor; distinct aggregate/draft/assignment/content versions;
  published snapshots, recipient-bound history, evidence/reviews and follow-ups.
- Read-only inventory detects invalid rows, duplicate unique keys, local orphan
  references and conflicting validators/indexes. Apply requires paused writers
  and an exact reviewed report hash; no document rewrite, deletion or index drop.
- DB-only deliverable. No Handover business route, Task assignment, SAG generation,
  FE behavior or permissions are activated by this change.

## Validation

- `npm ci --ignore-scripts` completed against the existing lockfile.
- Focused Mongoose tests: 5 passed; migration planner tests: 5 passed.
- Disposable MongoDB 7.0.24/CLI tests: 3 passed, including no-op retry, legacy
  preservation, duplicate preflight with zero DDL, strict bindings, evidence
  bounds, safe receipts and snapshot BSON bounds.
- Real Mongoose serialization e2e: passed, including nested provenance and timestamps.
- `npm run test:migrations:plan`: 248 passed.
- Full final `npm run check`: exit 0, including lint/typecheck, existing safety
  tests, 1,504 unit tests, 169 e2e tests and build. Repository opt-in suites
  skipped 135 unit and 4 e2e cases; these are not claimed as verified.
- Built CJS asset loads with all nine collection definitions; `git diff --check` passed.

## Database/configuration/security impact

Only `continuum_handover` is targeted. Legacy absent/1 schema versions are
accepted only in the three pre-existing collections; no backfill promotes old
verification into V2 acknowledgement. Existing responsibilities/interviews,
IAM, Capture, Task, SAG and audit/outbox storage are unchanged.

Migration uses explicit `HANDOVER_MONGODB_URI` and never reads `.env`. Remote
targets require an explicit flag plus database confirmation. Output omits
document bodies/User IDs/credentials and suppresses raw driver errors. V2 models
disable automatic collection/index creation. No credentials or new dependency
versions are included.

## Risks and rollback

DDL is additive but not one transaction. On infrastructure failure, keep writers
paused, review a fresh report and resume. Existing unfamiliar validators/index
options block apply for owner reconciliation. Large inventories require a
maintenance window. No shared/production database was modified by these tests.

Rollback disables/quiesces V2 writers and retains all V2 data, receipts, indexes
and validators. Do not run legacy writers against V2 records or delete history.
Runtime ACLs, append-only writes, completion guards and external Task/SAG results
remain application responsibilities; schema tests do not prove those features.

PR base: `main`. Human review/CI/merge required before dependent BE/FE work,
as explicitly confirmed by Thang. Thang explicitly authorized publishing this
branch and opening the PR. Approval and merge remain human actions.
