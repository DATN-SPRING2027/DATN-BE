## Summary

Implements the complete **Knowledge Handover** backend workflow (`B01`, `B02`, `B03`, `AI01`, `C02`, `C03`, `C04`, `Q01`) on top of the human-merged V2 database foundation (`PR #106` / `f41b57b36a61ad23bd971ef3ec5325caf61f0edc`).

### Scope
- **Cross-domain application contracts** (zero cross-DB reads/writes):
  - `HandoverIamScopeService`: active Leader/Coordinator/Successor scope resolution (including live `resolveActiveProjectMemberScope` when Successor `B` is also a `TEAM_LEADER` — `F06`), historical departing member `A` validation (`A01`, `A02`), and safe Org Manager coordinator recovery without leaking private handover content (`A16`).
  - `HandoverCaptureSourceService` & `HandoverLifecycleSourceService`: live source eligibility (`PROJECT_DOCUMENT` `APPROVED`, `WORK_REPORT` `APPROVED`, `TASK_NOTE` `CONFIRMED`, `KNOWLEDGE_OBJECT` `VERIFIED`), exact pinned-version snapshot excerpt resolution (`work_note_versions` for `TASK_NOTE`, fail-closed `readable: false` when historical snapshot content is unavailable for `WORK_REPORT` or in-place edited `TASK_NOTE` — `F03`), drift detection (`UPDATED_SINCE_SNAPSHOT`), and `TASK_NOTE` restriction (`A03`, `A04`).
  - `HandoverTaskAssignmentService`: durable idempotent task reassignment, post-dispatch drift inspection (`inspectTasksCurrentState`), & receipt tracking via `WORKSPACE_TASK_OPERATIONS_COLLECTION` (`task_operations`, keyed by `(actorId, projectId, operationId)`) in `continuum_task` (`A10`, `A11`, `F02`).
  - `HttpAiEngineClient.request(...)`: allow-listed BFF principal-scoped call to SAG `POST /api/v1/projects/:projectId/handover/assist`.
- **Handover workflow controller, services & gateway proxy**:
  - All 25 paths / 28 operations with `ETag`, `If-Match`, `Idempotency-Key`, `Idempotency-Replayed`, `DraftItemDto.contentVersion` (`F07`), and CSRF enforcement.
  - Immutable revision snapshots, epoch/revision/contentVersion-bound acknowledgements (`A05`, `A06`), completion readiness blocking on outdated required item sources (`REQUIRED_ITEM_SOURCE_OUTDATED` — `F01`) and post-dispatch task reassignment drift (`SELECTED_TASK_ASSIGNEE_DRIFTED` / `TASK_REASSIGNED_AFTER_DISPATCH` — `F02`, keeping `C` intact), HTTPS-only evidence & Leader review (`A09`), optional gap exceptions & post-completion follow-ups (`A08`, `A15`), transfer completion fence (`PENDING | UNKNOWN`), cancellation audit preservation (`A14`), and fail-closed `UNAVAILABLE` item redaction (`A04`, `A13`).
  - Contained background AI job scheduling (`F04`), periodic + on-read stalled job lease recovery (`PENDING` and expired-lease `RUNNING` reclaim with `leaseOwner` fencing + `retryJob` support for expired leases — `F05`), stale AI job `SUPERSEDED` guard, and manual fallback (`A12`, `P-08`).

### Tests Run
- `npm run test:handover-v2:plan` (5/5 passed)
- `npm run test:handover-v2:mongodb` (3/3 passed)
- `npm run test:migrations:plan` (passed)
- `npm run check`: lint, typecheck, role reconciliation (`15/15`), dev-db smoke (`25/25`), `169` unit suites (`1,567` tests), `19` active e2e suites (`176` tests including `test/handover-workflow.mongodb-e2e-spec.ts` covering `A01–A16` + `F01–F07` regressions on real MongoDB 7.0.24 replica set + 21 OpenAPI payload scenarios), and `nest build`.

### Database, Configuration & Rollback Impact
- **Database**: Uses the merged `PR #106` `continuum_handover` V2 collections/validators unchanged (apply `scripts/migrations/20261028-handover-v2.mjs` per its README before enabling traffic in shared environments). `continuum_task` uses additive idempotent operation receipts in `task_operations` without modifying `tasks` validator/schema.
- **Configuration**: Uses existing `SAG_API_BASE_URL` and `SAG_BFF_SERVICE_TOKEN`.
- **Risks & Rollback**: Deploying SAG PR [`sag-laya-integration#47`](https://github.com/DATN-SPRING2027/sag-laya-integration/pull/47) (`feat/Thang-knowledge-handover-workflow-sag-be-api`) enables live AI proposals/generation/Q&A; if SAG is unavailable, Handover fails closed with `AI_ENGINE_UNAVAILABLE` / `AI_ENGINE_NOT_CONFIGURED` / `AI_ENGINE_REQUEST_FAILED` and preserves full manual draft/publish workflow (`P-08`). Reverting this PR leaves additive records intact without destructive rollback.
