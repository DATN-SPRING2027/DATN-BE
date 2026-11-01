# Task Note assessment — private persistence and absolute retention

Owner: DanhDEV. DB branch `feat/DanhDEV-worknote-task-assessment-db`.
Implementation authority: user authorized plan v2 and autonomous implementation
on 2026-10-29, including local integration before DB merge. No independent team
approval, merge or production deployment is claimed. No Atlas execution is part
of this package's agent scope.

## Additive storage contract

`continuum_capture.work_note_agent_drafts.state` remains Mixed. An optional
`state.assessment` contains `task-note-assessment/v1` private state, including
source catalog, answers/gaps, corrections, optional feedback and metadata trace.
Only Task Note drafts may contain it. Old drafts without assessment remain valid.
No new collection, index, canonical field or durable history is introduced.

The Mongoose storage guard validates the assessment envelope, version/revisions,
private expiry and metadata-only trace allowlist. Runtime uses raw Mongo writes,
so full API validation, current permission and read/write expiry enforcement stay
mandatory in BE; Mongoose validation is not a server-side Mongo validator or an
independent semantic evaluator. Existing exact expiresAt TTL indexes remain the
cleanup mechanism, not proof of the application's lifetime policy.

Assessment/raw source/answer/chat lifetime is at most24h from the original
draft.createdAt, not a sliding inactivity window. BE must clamp every successful
mutation and reject expired reads independently of asynchronous TTL cleanup.
Save/Discard removes assessment and source-bearing transient results with the
draft; content-free replay receipts follow their separate bounded24h policy.
Canonical title/body/version/history is unchanged. Prior contracts describing
inactivity expiry are historical for this newly authorized private-state policy.

## New migration only

`20261029-work-note-assessment.mjs` is an expiry-only, bounded migration:

- Default invocation is offline and performs zero network calls.
- Explicit inspect/apply accepts only a single loopback Mongo URI targeting
  continuum_capture; no dotenv or application URI fallback, no production mode.
- Scans at most10,000 total draft plus operation rows by default (exported engine
  accepts an explicit budget1..100,000). All candidates are validated before writes.
- Caps existing draft.expiresAt and optional assessment.expiresAt to the original
  draft deadline; never extends an expiry, edits text or fabricates creation time.
- Caps operation expiry to its own creation deadline and associated draft deadline
  when available. Legacy raw receipts frequently lack createdAt. Associated draft
  creation is a valid upper bound; orphan operations with no trustworthy creation
  time expire at migration time. This fail-closed legacy policy was explicitly
  accepted for the package. It can shorten replay availability; it cannot alter
  canonical data.
- Invalid draft/explicit operation timestamps or an unsupported assessment clock
  fail before any data write. Exact existing TTL key/name/expireAfterSeconds=0
  readiness is verified; conflicting TTL definitions require reviewed repair,
  never automatic drop/replacement. Missing canonical TTL definitions are created.
- Uses transaction/CAS for expiry patches and is idempotent. A concurrent expiry
  change aborts patches; retry a fresh inventory. It touches only the two private
  collections. It does not call old migration engines or backfill canonical notes.

```powershell
node scripts/migrations/20261029-work-note-assessment.mjs
# For an explicitly supplied disposable loopback replica set only:
$env:WORKNOTE_MIGRATION_URI = '<loopback URI>/continuum_capture'
node scripts/migrations/20261029-work-note-assessment.mjs --inspect
node scripts/migrations/20261029-work-note-assessment.mjs --apply
```

Do not invoke the local tool against Atlas or wrap it with an unreviewed shared
URI bypass. Any future shared execution needs a separately scoped target/inventory
and backup/recovery assessment, then a reviewed operator path.

## Verification and rollback

Tests use newly created MongoMemoryReplSet instances, not an application database.
Run `node --test scripts/migrations/work-note-assessment.mongodb.test.mjs` and
the assessment/legacy schema Jest suites. Coverage includes no-network default,
target guards, scan bound before writes, dry-run preservation, repeated apply,
old drafts, orphan receipt policy, exact TTL readiness and canonical preservation.

Disabling the assessment entrypoint rolls back the feature. Do not drop canonical
content or history. An expiry-only migration cannot restore deleted private data;
TTL may delete records after the new deadline. Source-bearing private data must
not be restored beyond the newly agreed24h lifetime. Retain metadata-only execution
counts and inspect report for review; do not log credentials, row IDs or raw text.

## Pending team notification — NOT SENT

```text
[DATABASE CHANGE]
Collection/Entity: continuum_capture.work_note_agent_drafts,
work_note_agent_operations
Change: additive optional private state.assessment (task-note-assessment/v1),
metadata-only trace guard and absolute original-draft24h retention.
Data impact: expiry-only clamp; no canonical note/document/report/history edit.
Legacy orphan operations without reliable creation time expire at apply time,
which may shorten replay availability. No shared execution has been performed.
Migration: NEW20261029-work-note-assessment.mjs; offline default, bounded inspect,
explicit disposable loopback apply. Old migrations remain unchanged.
PR type: Database
PR: root delivery agent will supply after reviewed commit/push. No merge.
```
