# DATN-254 — proposed Team foundation preflight (read-only)

As of 2026-10-14, [DATN-89 comment 10151](https://trankimthang0207.atlassian.net/browse/DATN-89?focusedCommentId=10151) states that TQ-01–10 remain `PROPOSED`; no Team policy/implementation sign-off is recorded. `DATN-89` being Done and the merged [Document PR #33](https://github.com/DATN-SPRING2027/Document/pull/33) complete the decision-gap deliverable, not policy approval. This PR does not enable the proposed Team schema at runtime.

This slice keeps the existing Team Mongoose schema and adds a bounded, read-only inventory that compares existing IAM records with candidate metadata rules from [DATN-89 comment 10141, §§3–4](https://trankimthang0207.atlassian.net/browse/DATN-89?focusedCommentId=10141). The report is evidence for later owner review only. A clean report means the scanned data matches those candidate rules; it does **not** mean the rules are approved, the schema is enabled, or rollout is ready. The report includes `assessmentBasis.policyStatus: PROPOSED`, `runtimeSchemaEnforced: false`, `rolloutReady: false`, and `applySupported: false`.

## Candidate rules assessed by the report

These remain proposals pending approval by the appropriate owners:

- Organization and Project parents are BSON ObjectIds; each Team has one Project parent, and the Project belongs to the same Organization.
- Name is NFC + trimmed, 1–200 Unicode code points, with no C0/DEL controls. Name is not unique.
- Code is trimmed and ASCII uppercased, matches `^[A-Z][A-Z0-9_-]{1,31}$`, and is unique by `(organizationId, projectId, code)` including archived rows.
- Description is nullable, preserves whitespace, allows tab/LF, and is at most 2,000 Unicode code points.
- Candidate lifecycle is `ACTIVE`/`ARCHIVED`; candidate version is an explicit safe integer >=1. Archived rows require date, actor and a trimmed 1–500 code-point reason; active rows require explicit null archive metadata.

No Team schema, API, role/grant, membership, generation, command-result, audit, or production write behavior is added. The existing full unique code index remains defined in the IAM persistence inventory and is only observed by this preflight; the script does not create, repair, or drop indexes.

## Preflight and safety

`20261014-team-foundation-preflight.mjs` reads only Team metadata, Organization IDs, Project IDs/Organization parents, and collection/index inventory from `continuum_iam`. It reports counts, issue codes/IDs, index drift and SHA-256 fingerprints without names, descriptions, archive reasons, credentials or URIs. The scan is bounded to 100,000 documents, 64 MiB of scanned EJSON, 32 MiB of report output, and 512 MiB of V8 heap. Reads span multiple queries and are not an atomic snapshot or all-writer/cutover proof.

Run only against an explicitly authorized read-only target:

```sh
node scripts/migrations/20261014-team-foundation-preflight.mjs --dry-run --database continuum_iam
```

Supply `MONGODB_URI` through the authorized environment; no `.env` is loaded implicitly. Exit 0 means no conflicts against the candidate rules in this scan; exit 2 means conflicts/mapping evidence is present; exit 1 means invalid arguments, target, connection or scan failure. `--apply` fails before connection. Do not run against a shared database without separate authorization.

The preflight never backfills `ACTIVE`, normalizes, deduplicates, deletes or repairs indexes. Legacy Teams remain untouched. Any future schema enablement or data migration requires approved contract rules, owner-selected mapping/recovery, reviewed evidence, verified backup, and separately authorized rollout. This read-only change has no data/DDL impact and needs no rollback.

## Verification and remaining gates

```sh
node --test scripts/migrations/team-foundation.plan.test.mjs
npm run check
```

`team-foundation.mongodb.test.mjs` is opt-in through `DATN254_MONGODB_TEST=true`; it requires URI exactly `mongodb://127.0.0.1:28954/?directConnection=true`, MongoDB 7, and a fresh disposable `continuum_iam.__datn254_fixture` marker `{_id:'owner',token:...}` matching `DATN254_FIXTURE_TOKEN`. Fixture setup writes and deliberate index drift are confined to that disposable fixture. It verifies the preflight leaves rows/indexes unchanged, flags candidate-rule conflicts, and observes retained scoped uniqueness. It does not enable or test runtime Team schema/API behavior, transactions, audit, providers, or parent races.

TQ-01–10 remain proposed; dependent APIs and mutations stay gated on owner approval and their DB/provider/all-writer/audit/transport evidence. DATN-257 and DATN-255/256/258 are not enabled by this preflight. DATN-92 Membership BE and DATN-91 FE remain separate scopes. DATN-259 tests can continue independently.

Pending team notification (prepare only):

```text
[DATABASE CHANGE]
Collection/Entity: continuum_iam.teams
Thay đổi: read-only inventory against proposed Team Foundation metadata rules; runtime schema unchanged; no DDL or document writes.
Ảnh hưởng dữ liệu: none from this script; conflicts are reported without inferred backfill, normalization or dedupe.
Migration: 20261014-team-foundation-preflight.mjs, explicitly targeted dry-run only; no apply/shared DB execution.
PR type: Database preflight
PR: https://github.com/DATN-SPRING2027/DATN-BE/pull/33
```
