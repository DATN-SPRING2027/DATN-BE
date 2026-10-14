# DATN-254 — selected Team metadata and read-only preflight

The [DATN-89 decision table](https://trankimthang0207.atlassian.net/browse/DATN-89)
on 2026-10-14 selects TQ-01–04 and the version contract in TQ-09, with the
remaining gates preserved by [Document PR #33](https://github.com/DATN-SPRING2027/Document/pull/33)
(merged `2b737e862e6eb4169d342750324bef15808128a2`). Exact field/lifecycle text is
in [R2 comment 10141](https://trankimthang0207.atlassian.net/browse/DATN-89?focusedCommentId=10141),
sections 3–4. This DB slice is based on BE main
`e6849212093b8ab38da63c0a43e5f50de4277d40` (PR #32).

## Persistence contract

Owner: IAM, logical database `continuum_iam`, collection `teams`.

- Immutable BSON ObjectId `organizationId` and `projectId`; immutable code,
  trimmed and ASCII uppercased, matching `^[A-Z][A-Z0-9_-]{1,31}$`.
- Required name, NFC + trim, 1–200 Unicode code points, no C0/DEL controls;
  names are not unique. Description is explicitly nullable (including an empty
  string), at most 2,000 code points, preserves whitespace, permits tab/LF,
  and rejects other C0/DEL.
- Required explicit `ACTIVE`/`ARCHIVED` and integer version >=1. There is no
  lifecycle/version default, including on hydration. Future create commands
  must explicitly supply ACTIVE/version 1 and convert omitted description to
  null; this change adds no create command.
- Explicit nullable `archivedAt`, `archivedBy`, and internal `archivedReason`.
  ARCHIVED requires date/actor and reason (trimmed, 1–500 code points, no
  C0/DEL); ACTIVE requires null archive metadata. Timestamp storage remains
  BSON Date under the existing Mongoose timestamps pattern.
- Preserve the existing full unique `(organizationId, projectId, code)` index,
  including archived records. No new query index or cardinality cap.

Document validation and Mongoose immutable fields are persistence safeguards;
they do not prove raw-writer coverage, cross-document parent checks, command
CAS, audit atomicity, or authorization. Query updates can strip immutable
fields; HTTP rejection/error semantics remain in the conditional API contract.

## Preflight, compatibility and recovery

`20261014-team-foundation-preflight.mjs` is a new, bounded, **read-only** data
script. Historical migrations are unchanged. It reads only Team metadata,
Organization IDs, Project IDs/Organization parents, and collection/index
inventory from IAM. It emits counts, issues, index drift and SHA-256 fingerprints
without names, descriptions, archive reasons, credentials or URIs.

It rejects missing/invalid state, version, nullable metadata, dates and IDs;
noncanonical values; missing/mismatched parents; stored or normalized code
collisions; views; non-simple collation; and absent/drifted full unique indexes.
It never backfills ACTIVE, normalizes, deduplicates, deletes or repairs indexes.
Even a clean report has `applySupported:false` and no proposed document writes.
Counts/fingerprints are an inventory across reads, **not** an atomic snapshot or
cutover/all-writer proof. Run with an explicitly authorized read-only target:

```sh
node scripts/migrations/20261014-team-foundation-preflight.mjs --dry-run --database continuum_iam
```

Supply `MONGODB_URI` through the authorized environment; no `.env` is loaded
implicitly. Exit 0: clean inventory; 2: conflicts/mapping required; 1: invalid
arguments, target, connection or scan failure. `--apply` fails before connection.
Do not run against a shared database without its separate authorization.

Legacy Teams may lack the new fields. Such records remain untouched and fail
the new document contract: rollout requires an owner-selected mapping/recovery
plan, reviewed clean inventory, verified backup and separately authorized
cutover. This branch supplies no guessed mapping or writable migration. Dry-run
is repeatable and needs no rollback because it changes neither data nor DDL.
Code rollback preserves stored data; do not use older validation to enable
unreviewed Team writes or erase archive/version fields.

## Verification and remaining dependencies

```sh
npm test -- --runInBand --runTestsByPath src/services/iam/infrastructure/mongodb/team-foundation.schema.spec.ts
node --test scripts/migrations/team-foundation.plan.test.mjs
npm run check
```

`team-foundation.mongodb.test.mjs` requires opt-in
`DATN254_MONGODB_TEST=true`, URI exactly
`mongodb://127.0.0.1:28954/?directConnection=true`, MongoDB 7, and a fresh
disposable `continuum_iam.__datn254_fixture` marker `{_id:'owner',token:...}`
matching `DATN254_FIXTURE_TOKEN`. Its setup/test writes and deliberate index
drift are confined to that fixture. It proves scoped uniqueness (including
archived conflicts), immutable-field preservation, repeatable clean/conflict
reports and unchanged documents/indexes after inspection. It tests no Team API,
transaction, audit, provider or parent revocation race.

No TeamMembership, admission/generation, Role/grant, command-result persistence,
audit event/index, Gateway/BFF, OpenAPI or frontend change is included. TQ-05,
06, 07, 08, 09 readiness and TQ-10 keep dependent APIs disabled. After this DB
PR is reviewed/merged, DATN-257 is next, subject to its exact read contract and
providers; mutations DATN-255/256/258 remain gated. DATN-92/91 retain their scope.

Pending team notification (prepare only):

```text
[DATABASE CHANGE]
Collection/Entity: continuum_iam.teams
Thay đổi: selected metadata validation, immutable parent/code, explicit lifecycle/version/archive metadata; existing unique index retained.
Ảnh hưởng dữ liệu: legacy missing/invalid fields block rollout; no inferred backfill, normalization or dedupe.
Migration: 20261014-team-foundation-preflight.mjs, read-only dry-run; mapping/apply/cutover deferred, no shared DB execution.
PR type: Database
PR: pending explicit requester instruction to create PR
```
