# DATN-254 — proposed Team metadata preflight (read-only)

As of 2026-10-14, [DATN-89](https://trankimthang0207.atlassian.net/browse/DATN-89) contains a proposed disposition table: TQ-01–04 recommend `APPROVE`, TQ-05–08 recommend `AMEND`, TQ-09 recommends contract `APPROVE` with mutations `DEFER`, and TQ-10 recommends `DEFER`. Jira explicitly records TQ-01–10 as `PROPOSED`/`UNKNOWN` pending approval by an owner with authority and a recorded revision/evidence. These labels are recommendations, not approved policy. The merged [Document PR #33](https://github.com/DATN-SPRING2027/Document/pull/33) is the decision-gap deliverable; this PR compares metadata/lifecycle against the proposed rules only and does not enable the Team schema at runtime.

This slice leaves the existing Team Mongoose schema unchanged and adds a bounded, read-only inventory that compares IAM records with the proposed metadata/lifecycle rules. A clean report means only that the scanned data matches this proposal; it does **not** establish policy approval, enable the schema, or establish rollout readiness. The report records `assessmentBasis.decisionStatus: PROPOSED`, `authoritySignoff: PENDING`, `proposedDispositions`, `runtimeSchemaEnforced: false`, `rolloutReady: false`, and `applySupported: false`.

## Proposed dispositions and runtime gates

The DATN-89 proposal recommends the following dispositions; each remains pending authoritative sign-off:

- TQ-01–04: recommend `APPROVE` for fields/validation, retained `ACTIVE`/`ARCHIVED` lifecycle with version preconditions, the Team/Membership boundary, and one immutable Project parent without a cardinality cap.
- TQ-05: `AMEND`; no implicit grants. Defer mutations until IAM/Security confirms and provisions the exact `TEAM_LEADER` permissions.
- TQ-06: `AMEND`; stale/missing parent or admission proof denies, with no cascade. Defer generation implementation until owners, writer inventory, protocol, and race tests are available.
- TQ-07: `AMEND`; route ownership is selected, while Gateway/BFF/IAM must confirm trusted auth context, CSRF, and conditional/idempotency header forwarding before integration.
- TQ-08: `AMEND`; use the shared error contract and reconcile Team mapping with the owning ErrorResponse/PR32 contract.
- TQ-09: contract `APPROVE` for version, scoped idempotency key/fingerprint, and application expiry/CAS semantics; defer Team mutations until provider, all-writer coverage, and ambiguous-commit recovery are evidenced.
- TQ-10: `DEFER` pending a canonical ADR-003/SPEC-001 source or explicit Team mapping selection, plus audit atomicity evidence.

The read-only checks below compare data with the proposed TQ-01–04 metadata/lifecycle rules. The remaining proposed dispositions are recorded for context and are not implemented by this PR. No result from this preflight converts a proposal into an approved contract.

## Proposed metadata rules assessed by the report

- Organization and Project parents are BSON ObjectIds; each Team has one immutable Project parent, and the Project belongs to the same Organization.
- Name is NFC + trimmed, 1–200 Unicode code points, with no C0/DEL controls. Name is not unique.
- Code is trimmed and ASCII uppercased, matches `^[A-Z][A-Z0-9_-]{1,31}$`, and is unique by `(organizationId, projectId, code)` including archived rows.
- Description is nullable, preserves whitespace, allows tab/LF, and is at most 2,000 Unicode code points.
- Selected lifecycle is `ACTIVE`/`ARCHIVED`; version is an explicit safe integer >=1. Archived rows require date, actor and a trimmed 1–500 code-point reason; active rows require explicit null archive metadata.

No Team schema, API, role/grant, membership, generation, command-result, audit, or production write behavior is added. The existing full unique code index remains defined in the IAM persistence inventory and is only observed by this preflight; the script does not create, repair, or drop indexes.

## Preflight and safety

`20261014-team-foundation-preflight.mjs` reads only Team metadata, Organization IDs, Project IDs/Organization parents, and collection/index inventory from `continuum_iam`. It reports counts, issue codes/IDs, index drift and SHA-256 fingerprints without names, descriptions, archive reasons, credentials or URIs. The scan is bounded to 100,000 documents, 64 MiB of scanned EJSON, 32 MiB of report output, and 512 MiB of V8 heap. Reads span multiple queries and are not an atomic snapshot or all-writer/cutover proof.

Run only against an explicitly authorized read-only target:

```sh
node scripts/migrations/20261014-team-foundation-preflight.mjs --dry-run --database continuum_iam
```

Supply `MONGODB_URI` through the authorized environment; no `.env` is loaded implicitly. Exit 0 means no conflicts against the proposed rules in this scan; exit 2 means conflicts/mapping evidence is present; exit 1 means invalid arguments, target, connection or scan failure. `--apply` fails before connection. Do not run against a shared database without separate authorization.

The preflight never backfills `ACTIVE`, normalizes, deduplicates, deletes or repairs indexes. Legacy Teams remain untouched. Any future schema enablement or data migration requires approved contract rules, owner-selected mapping/recovery, reviewed evidence, verified backup, and separately authorized rollout. This read-only change has no data/DDL impact and needs no rollback.

## Verification and remaining gates

```sh
node --test scripts/migrations/team-foundation.plan.test.mjs
npm run check
```

`team-foundation.mongodb.test.mjs` is opt-in through `DATN254_MONGODB_TEST=true`; it requires URI exactly `mongodb://127.0.0.1:28954/?directConnection=true`, MongoDB 7, and a fresh disposable `continuum_iam.__datn254_fixture` marker `{_id:'owner',token:...}` matching `DATN254_FIXTURE_TOKEN`. Fixture setup writes and deliberate index drift are confined to that disposable fixture. It verifies the preflight leaves rows/indexes unchanged, flags conflicts with the proposal, and observes retained scoped uniqueness. It does not enable or test runtime Team schema/API behavior, transactions, audit, providers, or parent races.

Pull-request CI runs this opt-in test in a dedicated disposable MongoDB 7 container, separate from the other MongoDB integration suites.

The proposed decision table remains unapproved; dependent APIs and mutations stay gated on authoritative contract approval and the IAM/transport/provider/all-writer/audit evidence listed above. DATN-257 and DATN-255/256/258 are not enabled by this preflight. DATN-92 Membership BE and DATN-91 FE remain separate scopes. DATN-259 tests can continue independently when their contracts are available.

Pending team notification (prepare only):

```text
[DATABASE CHANGE]
Collection/Entity: continuum_iam.teams
Thay đổi: read-only inventory against proposed Team Foundation metadata/lifecycle rules; proposal is not an approved contract; runtime schema unchanged; no DDL or document writes.
Ảnh hưởng dữ liệu: none from this script; conflicts are reported without inferred backfill, normalization or dedupe.
Migration: 20261014-team-foundation-preflight.mjs, explicitly targeted dry-run only; no apply/shared DB execution.
PR type: Database preflight
PR: https://github.com/DATN-SPRING2027/DATN-BE/pull/33
```
