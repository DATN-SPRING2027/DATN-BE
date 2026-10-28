# Agent WorkNote — guarded local implementation

Status 2026-10-28: Task Note, Project Document and Work Report editors are
implemented under user-approved contracts 04/08, including local integration
before DB merge. Owner DanhDEV; BE branch feat/DanhDEV-agent-worknote-be-api,
base origin/main 2325a8e. DB package stays in its separate branch/worktree.

The runtime writes to the application's existing configured MongoDB Capture
connection (continuum_capture). No new application database, SAG persistence or
connection fallback is introduced. The user explicitly deferred SAG integration
on 2026-10-28 because the SAG team is not ready. SAG is not a completion gate for
this editor scope; no repository link is needed to use rewrite/clarification/Save.

Implemented: private 24-hour drafts/chat, revision-bound autosave, exact selection,
Task evidence separated from author answers, optional answer choices/free text/
unknown/skip, preview/edit/regenerate/explicit Apply, undo/redo, independent Save,
confirmation before removing the before-rewrite draft, immutable canonical history
and stale-safe restore. Shared workflows carry no fabricated Task identity.
Document review/files and Report ownership/cadence/period/Submit remain separate.

Repository defaults remain off. On2026-10-28 the user authorized the existing
Atlas integration and Git delivery plan. Capture backup/restore was verified
against all10 original collection content hashes; indexes-only shared migration
and replay passed without changing existing document content or bulk conversion.
DB PR: https://github.com/DATN-SPRING2027/DATN-BE/pull/104 (draft, unmerged).

Only this workstation's editor/Agent/shared flags are enabled, using explicit
xKiro pilot model mistralai/ministral-14b, real IAM authorization and existing
Mongo/Redis configuration. The key/Mongo URI were preserved. FE's stale local
API base3002 was corrected to3001. Real app runs at localhost:3000 with API3001;
port3019 remains a disposable fixture. User-authenticated browser acceptance is
in progress from New note in the Task notes tab; no production deployment or
merge is implied. SAG remains deferred and the user will update Jira.

Verification: npm run check passed BE/FE/DB. Real IAM + Task API + Capture + Redis
+ xKiro smoke passed on isolated disposable infrastructure; Gateway transport is
covered separately with explicit IAM/Task HTTP fixtures. The port3019 browser
preview always uses temporary Mongo and synthetic identity. It must never be
pointed at the configured application database as a substitute for real login.

Evaluation: prompt v0.3.2; v3 corpus60 (30dev/10val/20holdout). Explicit Mistral
comparison completed 104/105 attempts, 59 unique cases; includes 45 repeats on15
development cases. Qwen completed6/12 development attempts. Human semantic
acceptance remains NOT_ESTABLISHED. See evaluation-followup-2026-10-28.json;
older evaluation-summary.json and archived prompts are historical evidence.

See DOC research-docs/WorkNote-Agent/: contract04, current delivery07,
contract08 + shared-editor-v1.local.openapi.json, deferred SAG discovery09.
DB scripts/migrations/20261027-work-note-agent.README.md contains the migration
runbook and unsent team notification. No dependency or external message added.


Current rollout evidence is in DOC research-docs/WorkNote-Agent/
10-existing-atlas-execution-plan-2026-10-28.md. Local backup archives, populated
environment backups and raw browser/API diagnostics remain outside Git.

Final authenticated Task Note acceptance passed on the normal application:
New note at BE-2 / Activity / Task notes, real xKiro grammar and missing-detail
question/answer, explicit Apply, confirmed canonical Save, persistence after
reload, v2 edit and v1 Restore as newv3. The final read-only Atlas check proves
history1/2/3, no remaining QA draft/chat, uncertainty preserved and all6 original
notes unchanged. A new QA Project Document saved as Draft with an immutable editor
snapshot; all137 original Documents were unchanged. No review/Submit was invoked.

Restore's browser-native confirmation was replaced by the existing in-app
alertdialog after browser acceptance exposed blocked native interaction. Targeted
Composer suite12/12; final FE fullcheck953/953 passed plus lint/typecheck/build.
BE fullcheck1563unit +168e2e passed (137/4 skipped); DB1502unit +168e2e passed
(135/4 skipped). No independent human semantic acceptance is claimed.
BE PR105 and FE PR99 remain drafts, DB PR104 remains unmerged. See DOC execution10
for actual-versus-fixture coverage and the final delivery record.

Authenticated Work Report acceptance also passed: the user's own blank current
Leader obligation, synthetic QA title/body, ordinary Save without AI, Draft
state retained, no Submit, persisted after browser reload. Atlas proof shows
schema2/version1 with one snapshot, correct author/period and no remaining draft;
all46 reports from the pre-run backup are unchanged. The current obligation was
created by normal scheduling after backup, not by the editor. No role or cadence
was changed to obtain access. This completes actual Save coverage for all three
workflows; independent human semantic acceptance and teammate review remain open.
