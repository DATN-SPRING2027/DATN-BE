# 02 — FE ↔ BE API Matrix

| Thuộc tính | Giá trị |
|---|---|
| FE SHA | `80a324ffac9cbb1e1b45e0a34d44c9c6ef508046` (PR #69) |
| BE SHA | `5e3bf8d8fb288d11176eb76ac226ef196e0b537e` (`origin/main`, #85) |
| Document repo | `main` @ `1635238`; doc 27 chỉ có trên branch `origin/docs/Phuc-DATN-97-d05-decision-record` (`49e2c6e`) |
| Nguồn FE | [01-fe-ui-inventory.md](01-fe-ui-inventory.md) |

## 0. Ràng buộc governance chi phối toàn bộ ma trận

Một endpoint có tồn tại trong controller **không** có nghĩa là FE dùng được nó. Đối với Task/work item, repository đặt ra các ràng buộc rõ ràng, đã được kiểm chứng trong code và tài liệu:

| Ràng buộc | Evidence |
|---|---|
| Task service **dormant**. Không được đăng ký vào `AppModule` hay `GatewayModule`, không có route Gateway/BFF, không có production caller. | `DATN_BE/AGENTS.md:7,9,11-12`; `src/app.module.ts:14-29` (không import Task); `src/gateway/gateway.module.ts:18-22` |
| Business API phải là **contract-first**: OpenAPI cần được approve trước khi implement. | `DATN_BE/AGENTS.md:22`; `Document/research-tech/ADR-010` (*"The HTTP API contract … must be approved in OpenAPI before implementation."*) |
| D05-DR2 chỉ cho phép controller dormant cho đúng 3 op (create/list/detail), 7 field. **Cấm**: mutation, status, assignment, filter, sort routes, Events/history, `Idempotency-Key`. | `DATN_BE/AGENTS.md:9` |
| Policy mặc định là `DenyAllTaskOperationPermissionPolicy` nên mọi op đều DENY, kể cả khi bật flag. | `src/services/task/runtime/task-authorization-boundary.ts:267-272`; `task-runtime.module.ts:117-138` |
| DR-3 (trust profile), DR-7(c)(d) và DR-8 (scope evidence) đang **DEFER**. Runtime owner của ADR-003 chưa được chỉ định. | doc 27 (branch) `:53-57,73-79`; `DATN_BE/AGENTS.md:10,12,20` |
| Source of truth là **native Continuum Task**; Jira không thuộc MVP. | `Document/research-tech/ADR-009:14-15`; `Document/research-docs/03_DAILY_WORKFLOW_AND_JIRA_SYNC.md:28,33` |
| Kanban, task comments/files, dashboard/reporting được xếp "P1 hoặc ngoài MVP". | `03_DAILY_WORKFLOW_AND_JIRA_SYNC.md:30` |
| Team routes chưa được wire. | `src/services/iam/iam.module.ts:110-126`; `test/team-foundation-runtime-gate.e2e-spec.ts:55-95` |

Vì vậy mọi tương tác cần Task API đều mang trạng thái **BLOCKED**, ngay cả khi phần backend đã tồn tại một phần ở dạng dormant.

## 1. Ma trận chi tiết

Quy ước:
- **Status**: MATCHED / PARTIAL / MISSING / INCOMPATIBLE / UNUSED / BLOCKED.
- **Priority**: P0 = điều kiện tiên quyết để màn hình có dữ liệu thật; P1 = cần cho thao tác chính; P2 = nâng cao hoặc tích hợp ngoài.
- **Gate** ghi quyết định cần có trước khi được implement (chi tiết ở §3).

### 1.1 Context dùng chung

| # | FE view | Action | FE type / field cần | BE hiện có | Method + path | Status | Auth | Đề xuất | Pri | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| C1 | mọi view | Current user ("assign to me", tác giả comment) | `id`, `name` | IAM auth | `GET /api/v1/auth/me` | **MATCHED** | session + ACTIVE org membership | Reuse. Thay `PREVIEW_PEOPLE[0]` bằng `user.id` khi có work item API | P0 | BE `authentication.controller.ts:498`, `authentication.application.service.ts:807-809`; FE `useAuth.ts:59-71` |
| C2 | Workspace | Danh sách project | `Project` | IAM project | `GET /api/v1/iam/projects?page&pageSize&status` | **MATCHED** | readScope | Reuse (đang dùng) | P0 | BE `project.controller.ts:139-156`; FE `useProjects.ts:54-75` |
| C3 | Work, WN | Project header | `Project` | IAM project | `GET /api/v1/iam/projects/{projectId}` | **MATCHED** | scope, trả 404 khi mismatch | Reuse (đang dùng) | P0 | BE `project.controller.ts:158-176`; FE `useProjects.ts:76-89` |
| C4 | Toolbar, List, Board, Detail, Create, WN filter | Danh sách assignee / member | `{id, name, initials}` | IAM project memberships (có `user.fullName`) | `GET /api/v1/iam/projects/{projectId}/memberships?page&pageSize&status=ACTIVE` | **MATCHED** (`project.members.list`: ADMIN, TL, MEMBER) | `ProjectAccessAuthorizationGuard` | Reuse. **Chỉ tích hợp cùng lúc với work item API**, nếu không assignee thật sẽ bị trộn với item mock | P0 | BE `project-access.controller.ts:215-216`, `authorization.policy.ts:354-370`; FE `useProjectMembers.ts:43,90`, `project-members.contract.ts:6,106` |

### 1.2 Work item lõi

| # | FE view | Action | FE field cần | BE hiện có | Path hiện có | Status | Thiếu gì | Đề xuất | Pri | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| W1 | List, Board, Overview, Calendar, Reports, Timeline | Load work items | `WorkItem` (§3 tài liệu 01) | Task D-05 slice: `listByProject` cursor `afterId`, 7 field | `GET /internal/tasks/projects/{projectId}/tasks` (dormant, chỉ loopback) | **BLOCKED** (PARTIAL về kỹ thuật) | Gateway route; ALLOW policy; field `status`, `assigneeId` đã có trong DB nhưng **không** có trong response; thiếu `key`, `type`, `priority`, `dueDate`, `startDate`, `description`, `parentId`, `labels` | Mở rộng response và thêm Gateway route **sau khi** contract được approve | P0 | G1, G2, G3, G4 |
| W2 | Detail (modal và page) | Load detail | như W1 + description | `getById` | `GET /internal/tasks/projects/{projectId}/tasks/{taskId}` (dormant) | **BLOCKED** | như W1 | như W1 | P0 | G1–G4 |
| W3 | Create dialog, List inline, Board quick create, Forms submit, Dev "fix task" | Create | title, type, priority, assignee, dueDate, description, status | `TaskDataRepository.create({title})` + `TaskCreateController` dormant | `POST /internal/tasks/projects/{projectId}/tasks` (dormant; OpenAPI **NOT APPROVED**) | **BLOCKED** | chỉ nhận `title`; OpenAPI create đang ở trạng thái proposal (`docs/openapi/README.md:110-127`) | Approve create contract (G2) rồi mở rộng body | P0 | G1–G5 |
| W4 | Detail, List inline | Sửa title, description, priority, due, labels | – | không có | – | **MISSING + BLOCKED** | không có field và không có mutation route (D05-DR2 cấm) | `PATCH …/tasks/{taskId}` với CAS `If-Match` | P1 | G1–G6 |
| W5 | List inline, Board DnD, bulk bar, Detail | Đổi status | `TODO/IN_PROGRESS/IN_REVIEW/DONE` | `TaskLifecycleCommandService.transitionStatus` (CAS `expectedVersion` + operationId), **không có HTTP** | – | **INCOMPATIBLE + BLOCKED** | FE có `IN_REVIEW`; BE có `BLOCKED`, `CANCELLED` (`task-contract.ts:10-16`); bảng chuyển trạng thái ở `task-lifecycle-policy.ts:86-95` | Quyết định enum (G7) rồi expose command `POST …/tasks/{taskId}/transitions` | P0 | G1–G7 |
| W6 | List, Detail, Board | Assign | `assigneeId` | field `assigneeId` có trong schema, **không có command** | – | **MISSING + BLOCKED** | command và validate rằng assignee là ACTIVE project member | `PATCH` (gộp vào W4) | P1 | G1–G6 |
| W7 | List row menu, bulk | Delete | – | không có; có status `CANCELLED` | – | **BLOCKED_DECISION** | hard delete hay soft cancel? | Khuyến nghị soft cancel bằng status `CANCELLED` (giữ audit) | P1 | G7 |
| W8 | List bulk bar | Bulk status/delete | danh sách id | không có | – | **MISSING + BLOCKED** | – | Hoãn (YAGNI). FE gọi W5 tuần tự, giới hạn concurrency | P2 | sau W5 |
| W9 | Toolbar | Search / filter / sort / paginate phía server | `q`, `status`, `assigneeId`, `priority`, `type`, cursor | chỉ có cursor `_id` | – | **MISSING + BLOCKED** (D05-DR2 cấm filter/sort) | query params và index | Mở rộng W1 bằng filter có allowlist (xem 03, 07) | P1 | G1–G4 |
| W10 | List, Detail | Subtask (CRUD, reorder, convert, đổi parent) | `parentId`, `subtasks{completed,total}` | không có | – | **MISSING + BLOCKED** | field `parentId` và counter | `parentId` trên Task (1 cấp) + batched counts (07 §4) | P1 | G1–G6, G8 |
| W11 | Detail | Checklist / steps | `steps[]` | không có | – | **MISSING + BLOCKED** | – | Hoãn (P2) hoặc embedded array có giới hạn | P2 | G8 |
| W12 | Detail | Comments | `WorkCommentItem` | không có | – | **MISSING + BLOCKED** (03_DAILY:30 "P1/out of MVP") | collection và route | Collection riêng `task_comments` khi Product chấp nhận | P2 | G8 |
| W13 | Detail, List row "Log work" | Worklog | `timeSpent`, `note` | không có | – | **MISSING + BLOCKED** | – | Hoãn; cần quyết định có tính thời gian hay không | P2 | G8 |
| W14 | Detail History tab | History | `author`, `action`, `createdAt` | `task_events` + `TaskHistoryQueryService` (dormant, không có route) | – | **PARTIAL + BLOCKED** (D05-DR2 cấm Events/history route) | route và projection | Expose `GET …/tasks/{taskId}/history` (page/limit) | P1 | G1–G4, doc 26 |
| W15 | Detail, Board | Flag, labels, story points, sprint | – | không có; **không có entity sprint** | – | **BLOCKED_DECISION** | – | Chỉ `labels` nếu Product cần; sprint là một domain mới | P2 | G8 |
| W16 | Detail | Watch | – | notification module chỉ có health | – | **MISSING** | – | Ngoài phạm vi | P2 | G8 |

### 1.3 View projections

| # | View | Action | Status | Thiếu gì | Đề xuất | Pri |
|---|---|---|---|---|---|---|
| V1 | Board | Cột theo status và số lượng | **MISSING + BLOCKED** | Group/count | Dùng W1 với filter `status` + endpoint `summary` (V4). **Không** tạo endpoint board riêng | P1 |
| V2 | Board | Thứ tự card trong cột | **UNUSED** (FE không có reorder trong cột: `WorkBoardView.tsx:297-307`) | – | **Không implement** rank/LexoRank (YAGNI) | – |
| V3 | Calendar | Item theo khoảng ngày | **MISSING + BLOCKED** | `dueDate` + range query | W1 với `dueFrom`/`dueTo` | P1 |
| V3b | Calendar | Kéo thả đổi ngày | **UNUSED** (FE chưa có tính năng này) | – | Không làm | – |
| V4 | Overview, Reports | Aggregate status/priority/type/assignee | **MISSING + BLOCKED** | aggregation | `GET …/tasks/summary` tính on-demand bằng indexed aggregation (đo ở 07) | P1 |
| V5 | Reports | Burndown, velocity, cycle time | **BLOCKED_DECISION** | cần sprint và lịch sử transition | Hoãn | P2 |
| V6 | Timeline | Epic, child, khoảng ngày | **MISSING + BLOCKED** | `startDate`, `dueDate`, hierarchy | W1 với range filter + `parentId`; bỏ mock `INITIAL_TIMELINE_EPICS` | P2 |
| V7 | Timeline | Sửa start/due | **MISSING + BLOCKED** | – | qua W4 | P2 |

### 1.4 Module phụ

| # | View | Action | BE hiện có | Status | Đề xuất | Pri |
|---|---|---|---|---|---|---|
| S1 | Work Notes | List/create note | `capture` chỉ có health; schema `work_notes` có `jiraIssueKey`, `whatDone`, `howSolved`… và **không có `taskId`** (`capture/infrastructure/mongodb/mongodb.schemas.ts:40-143`) | **INCOMPATIBLE + BLOCKED** | Cần contract Work Notes. Field FE (`kind`, `body`, `blocker`, `nextStep`, `week`) không khớp schema; ADR-009 §3 yêu cầu `taskId` | P1 |
| S2 | Work Notes | Mark viewed | không có | **MISSING + BLOCKED** | – | P2 |
| S3 | Work Notes | Save as knowledge / approve / request changes | `lifecycle` chỉ có health; schema `knowledge_proposals` | **MISSING + BLOCKED** | Contract Knowledge lifecycle | P2 |
| S4 | Work Notes | Weekly report submit/review | không có collection | **MISSING + BLOCKED_DECISION** | WEEKLY_SUMMARY (note) và WeeklyReport là 2 entity khác nhau, cần Product quyết định gộp hay tách | P2 |
| S5 | Work Notes | Config template/reminder | schema `work_note_templates`; notification chỉ có health | **MISSING + BLOCKED** | – | P2 |
| S6 | Work Notes | Role MEMBER/LEADER/ADMIN | FE lấy role org (`work-notes-types.ts:14-21`) | **INCOMPATIBLE** | Role phải lấy theo **project** (TEAM_LEADER theo project scope: `authorization.policy.ts:304-389`) | P1 |
| S7 | Docs | List/read/create/edit/comment | `ingestion` chỉ có health; schema `documents`, `document_versions` | **MISSING + BLOCKED** | Contract Docs/Ingestion | P2 |
| S8 | Docs | Sync SAG / access | `integrations/ai-engine` (chỉ SAG session redirect) | **BLOCKED** | Permission filtering trước khi gửi AI (`AGENTS.md:24`) | P2 |
| S9 | Forms | Định nghĩa + submit | không có | **BLOCKED_DECISION** | Không có ADR nào nhắc tới intake form | P2 |
| S10 | Development | Tool, PR, repo, vuln, deploy, branch/commit | không có git integration (chỉ có `work_notes.gitCommitHash`) | **BLOCKED_DECISION** | Ngoài MVP | P2 |
| S11 | Toolbar/Copilot/Detail | AI search, AI copilot, Improve with AI | `integrations/ai-engine` không có contract tương ứng | **BLOCKED** | Contract AI và permission filter | P2 |
| S12 | Header | Automations | không có | **BLOCKED_DECISION** | – | P2 |
| S13 | Toolbar | Import CSV | không có | **MISSING** | Phụ thuộc W3 | P2 |
| S14 | Toolbar | Feedback | không có | **UNUSED / quyết định Product** | Ngoài phạm vi | – |
| S15 | Board | Complete sprint | không có sprint | **BLOCKED_DECISION** | = W15 | P2 |

### 1.5 Endpoint BE không có FE consumer trong Workspace

| Endpoint | Status | Ghi chú |
|---|---|---|
| Team routes (`team-foundation.controller.ts:88-247`) | **UNUSED** trong Work; chưa wire | Có `TeamsWorkspace` riêng, có feature flag |
| `jira` platform integrations (`jira.controller.ts:69-112`) | **UNUSED** trong Work | Chỉ phục vụ Platform operator |
| Chat (~40 route) | **UNUSED** trong Work | Có màn `/chat` riêng |

## 2. Tổng hợp

Mẫu số được đếm từ ma trận này. Mỗi capability chỉ đếm một lần, kể cả khi nhiều view dùng chung.

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| View chức năng (không trùng) | **11** | 10 tab + Issue Detail (modal và page là một component) |
| Route | 3 | `/workspace`, `/projects/:id/work`, `/projects/:id/work-notes` |
| Capability có FE consumer (C + W + V + S, trừ V2, V3b, S14) | **40** | C1–C4 (4), W1–W16 (16), V1/V3/V4/V5/V6/V7 (6), S1–S13 (13), S15 (1) |
| MATCHED (reuse được ngay) | **4** | C1–C4 |
| PARTIAL (backend có một phần, dormant, kèm BLOCKED) | **4** | W1, W2, W3, W14 |
| INCOMPATIBLE (kèm BLOCKED) | **3** | W5 (status enum), S1 (schema Work Notes), S6 (role scope) |
| BLOCKED_DECISION (cần quyết định Product/Architecture) | **8** | W7, W15, V5, S4, S9, S10, S12, S15 |
| MISSING (kèm BLOCKED vì chưa có contract) | **21** | W4, W6, W8–W13, W16, V1, V3, V4, V6, V7, S2, S3, S5, S7, S8, S11, S13 |
| Kiểm tra tổng | 4 + 4 + 3 + 8 + 21 = **40** | |
| UNUSED (không implement) | 2 FE + 3 nhóm BE | V2, V3b; Team, Jira ops, Chat |
| Capability có thể implement **ngay** mà không vi phạm governance | **0 phía BE** | Tất cả phụ thuộc G1–G4. Reuse C1–C4 về kỹ thuật là khả thi, nhưng chỉ có giá trị khi có work item thật |

**Độ phức tạp ước lượng** (sau khi gate mở): khoảng 10–14 ngày công BE + 5–7 ngày công FE cho P0/P1 lõi (W1–W6, W9, W10, W14, V1, V3, V4, C4). Module phụ (Work Notes, Docs, Forms, Development, AI) **chưa ước lượng được** vì chưa có quyết định Product.

## 3. Gate cần mở trước khi implement

| Gate | Nội dung | Người quyết | Nguồn |
|---|---|---|---|
| **G1** | Chỉ định accountable runtime owner của ADR-003 và workflow migration/seed cho `continuum_task` | Architecture + Platform/Runtime owner | `AGENTS.md:12,20` |
| **G2** | Approve OpenAPI cho các op mới (đề xuất ở `04-api-inventory.yaml`) | Product + Architecture + Security (Leader đã từng thực hiện vai trò này cho D-05) | `AGENTS.md:22`; `docs/openapi/README.md:51-127` |
| **G3** | DR-3: trust profile Gateway→Task (verifier, mTLS, replay) | Security + Architecture | doc 27 (DEFER) |
| **G4** | DR-8: nguồn scope evidence (ACTIVE org + project membership) và ALLOW policy | Architecture + Security | doc 27 (DEFER) |
| **G5** | DR-7(c)(d): điều kiện cho create | Product + Architecture | doc 27 (DEFER); `docs/openapi/README.md:110-127` |
| **G6** | Mở rộng schema `tasks` (description, priority, type, dueDate, startDate, parentId, labels, key) kèm migration mới | Architecture + DB owner | `task-database-schema.ts:127-141` (`additionalProperties:false`) |
| **G7** | Enum status/transition: giữ BE (`BLOCKED`, `CANCELLED`) hay thêm `IN_REVIEW`; delete = `CANCELLED`? | Product | `task-contract.ts:10-16`; FE `work-types.ts:1-8` |
| **G8** | Phạm vi MVP cho comments, worklog, checklist, sprint, labels | Product | `03_DAILY_WORKFLOW_AND_JIRA_SYNC.md:30` |
| **G9** | Contract Work Notes / Knowledge / Weekly report (đồng bộ ADR-009 `taskId`) | Product + Architecture | ADR-009 §3; schema capture |

Phương án cho từng gate được trình bày ở [09-final-audit.md](09-final-audit.md) §BLOCKED_DECISION.
