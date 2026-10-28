> Current execution record — 2026-10-28: the user extended authorization to the
> existing Atlas integration and Git delivery plan. Capture was backed up to a
> protected local archive, restored into an owned disposable MongoDB and all10
> original collection content hashes matched. Both shared wrappers were applied
> in indexes-only mode and repeated successfully. All10 original collection
> hashes stayed unchanged; no legacy Task Note or Report was bulk converted.
> This is local workstation activation, not a merge or production deployment.
> The earlier preparation/local-only statements below are historical records.

# WorkNote Agent database package

Branch: feat/DanhDEV-agent-worknote-db, base origin/main 2325a8e.
User authorized local integration before DB merge on 2026-10-27; no teammate
review/merge or shared Atlas execution is inferred. Schema/index/migration files
in this worktree are the DB PR scope; application code lives in the BE branch.

No URI is read by default, no dotenv is loaded, and no network call is made:

```powershell
node scripts/migrations/20261027-work-note-agent.mjs
node --test scripts/migrations/work-note-agent.plan.test.mjs
```

To inspect a disposable loopback replica set, explicitly supply
WORKNOTE_MIGRATION_URI and use --inspect. --apply additionally creates the owned
draft/operation indexes and backfills missing freeform snapshots transactionally.
The tool refuses SRV, remote, multi-host and non-Capture database targets.
Do not point it at Atlas. Shared execution needs its own reviewed rollout.

Inventory is bounded to 10,000 candidate notes. Every candidate is checked before
writes. Legacy content is deterministic labeled concatenation, with exact inner
whitespace. Missing fields/over-budget content require manual review. Existing
freeform notes are skipped. Existing historical versions are retained; a fresh
version records the current legacy snapshot. Migration transactions can be
rerun after partial progress. Counters/plan are logged, never source text.

Drafts and transient operation payloads expire at expiresAt, 24 hours after
author activity; backend reads must enforce expiry before asynchronous TTL.
Save/Discard transactions scrub draft-associated operation payloads into
content-free closed receipts; Save adds its content-free result receipt. Retaining
opaque closed IDs prevents old create replay from resurrecting a draft.
Canonical content/version history has no draft TTL.

Rollback: disable the new routes/editor; preserve new freeform fields and
versions. Do not drop collections, remove canonical text or convert it into
lossy structured fields. Legacy writes to upgraded notes must be rejected.

Pending team notification (not sent):

```text
[DATABASE CHANGE]
Collection/Entity: continuum_capture.work_notes, work_note_versions,
work_note_agent_drafts, work_note_agent_operations
Thay đổi: freeform canonical content/version/provenance; owned drafts and
24-hour TTL operation storage; resume/cleanup indexes.
Ảnh hưởng dữ liệu: additive deterministic legacy backfill; legacy fields retained
by migration, historical canonical snapshots preserved; no Atlas execution.
Migration: 20261027-work-note-agent.mjs, dry-run default, loopback-only apply.
PR type: Database
PR: Pending commit, push and review.
```


## Document / Report extension and shared operator runbook (2026-10-28)

User approved contract 08 and local-before-DB-merge; shared execution remains a
separate operator action. New schema scope: project_documents.editorVersionNumber,
optional project_document_versions.provenance, project_document_editor_versions,
work_reports canonical fields and work_report_versions. Shared draft identity is
exclusive by workflow. Existing review state/cadence/file ownership is unchanged.

The commands below are the operator runbook. See the current execution record
above for the completed, verified indexes-only application on the configured Atlas.
Default no-argument invocations make no network call:

```powershell
node scripts/migrations/20261028-work-note-agent-shared.mjs
node scripts/migrations/20261028-work-note-editor-shared.mjs
```

1. Review/merge DB PR before shared runtime deployment. Review collection/index
   inventories and contract 08. Arrange a transaction-capable Atlas target and
   tested restore plan for the affected Capture collections. A backup-reference
   string is operator attestation, never proof that backup/restore was verified.
2. Keep both BE flags and FE entry-point flags false. Supply explicit
   WORKNOTE_MIGRATION_URI securely in the operator environment; never paste it in
   a command, chat, .env.example or log. The tool does not load dotenv. Supply
   WORKNOTE_MIGRATION_EXPECTED_HOST independently; only exact Atlas *.mongodb.net
   + /continuum_capture with TLS is allowed. Wrong database/multiple hosts/TLS
   bypasses/URI fragments are rejected before connect.
3. Run the Task shared wrapper with --inspect and the editor shared wrapper with
   --inspect. Inspection is read-only but connects to the explicit target.
   Indexes-only editor inspection does not scan Report bodies. Use --inspect
   --backfill to preflight bounded nonempty legacy Report candidates; max10,000,
   manual review required for malformed/oversize data. Never increase the bound
   silently or infer content with a model.
4. Apply requires WORKNOTE_MIGRATION_CONFIRM_TARGET equal to host/continuum_capture
   and WORKNOTE_MIGRATION_BACKUP_REFERENCE set by the operator. Apply Task indexes
   through its shared wrapper (indexes-only default). Explicit --backfill is
   required for deterministic Task legacy snapshot conversion; prefer on-demand
   author Save when existing records do not need bulk conversion.
   Apply editor wrapper with --apply to create shared indexes only. Optional
   --apply --backfill converts nonempty legacy Reports in transactions and retains
   old fields. Author Save also upgrades one Report on demand. Blank obligations
   are not backfilled. Rerun is idempotent after partial progress.
5. Deploy BE read compatibility/legacy-write guard, then test current authorization,
   index readiness, Redis availability and server xKiro config in the target.
   Enable BE WORKNOTE_EDITOR_ENABLED and optionally WORKNOTE_AGENT_ENABLED, then
   WORKNOTE_SHARED_EDITOR_ENABLED, then corresponding NEXT_PUBLIC FE flags through
   the normal deployment process. Local flags do not authorize shared activation.
6. Verify Save/Submit separation, owner/current-membership denials, selection
   correctness, provider failure with independent Save, canonical versions and
   confirmation cleanup. Verify existing source review/replacement events before
   integrating the actual DATN SAG fork; do not point generic upstream ingest at
   project content as a substitute for Project ACL proof.
7. Rollback by disabling entry points/BE flags and retaining canonical text/history.
   Do not drop collections or reverse freeform text into lossy old fields. Existing
   v2 reports must stay read-compatible and legacy text writes remain rejected.

Additional pending team notification (NOT SENT):

```text
[DATABASE CHANGE]
Collection/Entity: continuum_capture.project_documents, project_document_versions,
project_document_editor_versions, work_reports, work_report_versions,
work_note_agent_drafts (workflow/resource resume index)
Change: additive canonical Report text/history + Document editor snapshots;
workflow-exclusive private drafts; immutable no-TTL canonical history.
Data impact: verified indexes-only Atlas application; original collection hashes
unchanged. No bulk backfill; optional deterministic conversion remains separate.
Migration: 20261028-work-note-editor.mjs (loopback) and explicit shared wrapper;
indexes-only default, --backfill is separate. Backup reference is attestation only.
PR type: Database
PR: https://github.com/DATN-SPRING2027/DATN-BE/pull/104 (draft). No merge or notification sent.
```


2026-10-28 rollout refinement (before first shared execution): both shared wrappers
now default to indexes-only for --apply. Task bulk conversion requires explicit
--backfill, just like Report conversion. The original local engine/CLI retains
its existing default backfill behavior for compatibility. A regression first
failed then passed for apply/backfill:false preserving legacy rows/history.
The completed existing-Atlas rollout used indexes only and retained all5 legacy
Task Notes unchanged until an authorized author saves through the new editor.
