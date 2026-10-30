# Knowledge Handover Workflow — Backend Work Package

- Date: 2026-10-28
- Owner: Thang
- Branch: `feat/Thang-knowledge-handover-workflow-be-api`
- Base: `origin/main` at `f41b57b36a61ad23bd971ef3ec5325caf61f0edc` (includes PR #106 DB merge)
- Worktree: `F:/LEARN KÌ 8/ĐATN/DATN_BE-handover-workflow`

## Context & Gate Status

- DB Gate is closed via human merge of PR #106 (`f41b57b36a61ad23bd971ef3ec5325caf61f0edc`). Physical DB schemas, validators, indexes, and additive migration in `src/services/handover/infrastructure/mongodb/handover-v2.contract.cjs` and `scripts/migrations/20261028-handover-v2.mjs` are treated as immutable foundation; zero DB validator/index/migration modifications are performed on this branch.
- Product invariants follow `17-knowledge-handover-content-decisions.md` (`H-01–H-15`, `P-01–P-08`), `18-knowledge-handover-technical-design.md` (`A01–A16`), `19-knowledge-handover-data-command-contract.md`, `contracts/handover-v1.openapi.yaml` (25 paths, 28 operations, 48 schemas — retained as `PROPOSED` until human review), and `contracts/handover-v1.payload-scenarios.json` (21 payload cases).

## Architectural Slices (TDD, 1–5 Files per Slice)

1. **Slice C04 — Owning Cross-Domain Contracts (IAM, Capture, Lifecycle)**:
   - `HandoverIamScopeService` in `IamModule`: active actor authentication, CSRF check, org/project concealment (`404` on mismatch/archived), historical `departingUserId` validation (`project_memberships` `ACTIVE | INACTIVE` + `organization_memberships` `ACTIVE | SUSPENDED | REMOVED`), active `successorUserId` check, coordinator `TEAM_LEADER` check, and `COORDINATOR_ADMINISTRATION` check (safe metadata receipt without granting content read).
   - `HandoverCaptureSourceService` in `CaptureModule`: strict current-ACL source eligibility, version lookup, candidate discovery, and excerpt resolution for `PROJECT_DOCUMENT` (`APPROVED` version), `WORK_REPORT` (`APPROVED`, enforcing `reportScope: 'LEADER' | 'MEMBER'` without Org Admin bypass), and `TASK_NOTE` (`CONFIRMED`, task/project-scoped, never treated as official SAG index source).
   - `HandoverLifecycleSourceService` in `LifecycleModule`: strict current-ACL source eligibility, version lookup, candidate discovery, and excerpt resolution for `KNOWLEDGE_OBJECT` (`VERIFIED` + `knowledge_versions`, enforcing `confidentiality`).
2. **Slice B01 — Handover Core, Drafts, Revisions, Projections & Gateway**:
   - Session-aware `AuditService` & `OutboxService` support for atomic transactions on `continuum_handover` + `continuum_audit`.
   - Durable command idempotency (`handover_operations`), strong ETag (`"handover:<id>:<version>"`, `"handover-followup:<id>:<version>"`), `If-Match` (`428` missing, `400` invalid, `409` stale), strict request payload validation covering all 21 payload scenarios, and `Cache-Control: no-store`.
   - Endpoints: `listHandovers`, `createHandover` (nullable `B`), `getHandover` (current ACL reauthorization, `AvailableItem` vs opaque `UnavailableItem`, `sourceState: CURRENT | CHANGED`, `capabilities`), `updateHandoverMetadata`, `setHandoverSuccessor` (`assignmentVersion++`, in-flight transfer fence), `setHandoverCoordinator` (safe `Receipt`), `getHandoverDraft`, `replaceHandoverDraft` (`draftVersion++`, server-allocated `itemId`, `contentVersion`, `dependencyFingerprint`), `publishHandoverRevision` (immutable snapshot <= 4 MiB, `PublishReview` + `GapAssignment`, `UNCHANGED` carry provenance vs `CHANGED` reset, `follow_up_tasks` sync), `getHandoverRevision`.
   - `GatewayHandoverController` registered in `GatewayModule`.
3. **Slice C02 + B03 — Owning Task Assignment Contract & Handover Transfer/Reconciliation**:
   - Exported `assignTaskForHandover` + `inspectHandoverTaskAssignment` on `TaskWorkspaceService` / `TaskWorkspaceRepository` using `continuum_task.task_operations` + `tasks` + `task_events` in a single atomic transaction (rejecting `DONE`/`CANCELLED` tasks, checking CAS + expected assignee so reassigned `C` is never overwritten).
   - Endpoints: `startHandoverTaskTransfer`, `getHandoverTaskTransfer`, `reconcileHandoverTaskTransfer`, plus fencing on `setHandoverSuccessor`, `publishHandoverRevision`, `completeHandover`, `cancelHandover`.
4. **Slice B02 — Recipient Acceptance, Evidence, Optional Exceptions, Follow-Ups, Complete & Cancel**:
   - Endpoints: `acceptHandoverPackage`, `acknowledgeHandoverItem`, `submitHandoverEvidence` (HTTPS links only, no upload/fetch), `reviewHandoverEvidence` (`reviewer !== successor`), `acceptOptionalHandoverGap` (rejects `isRequired`), `listHandoverFollowUps`, `resolveHandoverFollowUp` (independent ETag, works after parent `COMPLETED`), `completeHandover` (full server-side guard), `cancelHandover`.
5. **Slice C03 + AI01 — Bounded SAG BFF Adapter, Async Jobs & Cited Q&A**:
   - Extend `HttpAiEngineClient` to allow `POST /api/v1/projects/:projectId/handover/assist` using `X-SAG-BFF-Service-Token` + `X-Continuum-*` scope headers.
   - Endpoints: `proposeHandoverSources`, `generateHandoverDraft` (stale `draftVersion`/`sourceFingerprint` -> `SUPERSEDED`, failure -> `FAILED` with manual fallback `P-08`), `getHandoverJob`, `getHandoverCandidates` (live ACL re-evaluation), `retryHandoverJob`, and `askHandoverQuestion` (CSRF-protected read-only POST, bounded to current published revision's permitted official sources, `ANSWERED` with citations or `INSUFFICIENT_EVIDENCE` with empty `sections`).
6. **Slice Q01 — Real MongoDB 7 Integration Suite (`A01–A16`), Contract Payload Tests & Full `npm run check`**:
   - Prove `A01–A16` and all 21 payload cases against real NestJS HTTP + MongoDB replica set, run `npm run check`, `test:handover-v2:plan`, `test:handover-v2:mongodb`, `test:migrations:plan`, inspect diff, and prepare handoff without pushing.

