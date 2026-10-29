# Knowledge Handover Workflow — Backend Todo

## Review round 2 (2026-10-29)

- [x] R2-BE01: sanitize Q&A status messages after live authorization; test revoked and uncited content.
- [x] R2-BE02: authorize historical item dependencies on every follow-up projection, including command replays.
- [x] R2-BE03: fail closed for edited Task Notes without an immutable matching snapshot.
- [x] R2-BE04: recheck source eligibility, version and content after AI generation, before applying the draft.
- [x] R2-X01: carry bounded coverage warnings to FE without changing the merged database schema.
- [x] Focused regressions, full quality gates and independent security candidate review; see the handoff and Git history for PR #110 delivery.

- [x] Verify PR #106 merge ancestor (`f41b57b36a61ad23bd971ef3ec5325caf61f0edc`), fast-forward `main`, create isolated worktree `DATN_BE-handover-workflow` on `feat/Thang-knowledge-handover-workflow-be-api`, and preserve all active AI Chat checkouts untouched.
- [x] Slice C04: Implement & unit-test `HandoverIamScopeService` (including `resolveActiveProjectMemberScope` for Leader-successor `B` — `F06`), `HandoverCaptureSourceService` (strict pinned-version snapshots for `TASK_NOTE` and fail-closed `readable: false` for outdated `WORK_REPORT` — `F03`), and `HandoverLifecycleSourceService` across owning modules (`IAM`, `Capture`, `Lifecycle`) with zero cross-DB leakage.
- [x] Slice B01: Implement & test Handover domain/repository/idempotency/CAS, core aggregate + draft (`DraftItemDto.contentVersion` — `F07`, normalized whitespace change check) + revision publish + live ACL fail-closed projection endpoints, 21 OpenAPI payload scenarios, and `GatewayHandoverController` (`ETag`, `If-Match`, `Idempotency-Key`, `Idempotency-Replayed`).
- [x] Slice C02 + B03: Implement & test durable idempotent `HandoverTaskAssignmentService` on `continuum_task` (`task_operations`) and Handover task transfer + post-commit drift reconciliation (`A10`, `A11`, `A15` fence on `PENDING | UNKNOWN`, `F02` keeping reassigned `C` intact and blocking stale completion).
- [x] Slice B02: Implement & test epoch/revision/contentVersion-bound package & item acceptance (`A05`, `A06`), outdated required source blocking (`REQUIRED_ITEM_SOURCE_OUTDATED` — `F01`), HTTPS-only evidence submit/review (`A09`), optional gap exceptions (`A08`), independent post-completion follow-ups (`A15`), `completeHandover` (`A07`, `A15`), and `cancelHandover` (`A14`).
- [x] Slice C03 + AI01: Implement & test SAG BFF adapter (`HttpAiEngineClient.request` on `/api/v1/projects/:projectId/handover/assist`), `SOURCE_PROPOSAL` (`A03`), `GENERATION` (`A12` stale `SUPERSEDED` + `P-08` manual fallback), contained background job error handling (`F04`), stalled lease recovery + expired-lease `retryJob` (`F05`), candidate live re-authorization, and `askHandoverQuestion` (`A04`, `A13`).
- [x] Slice Q01: Execute real MongoDB 7.0.24 replica-set e2e acceptance suite (`test/handover-workflow.mongodb-e2e-spec.ts` covering `A01–A16` + `F01–F07`), migration/planner tests (`test:handover-v2:plan`, `test:handover-v2:mongodb`, `test:migrations:plan`), and full `npm run check` (`169` unit suites / `1,567` unit tests, `19` active e2e suites / `176` e2e tests, `0` lint/typecheck errors, `nest build` green).
