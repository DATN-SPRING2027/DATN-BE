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
| DR-3 (trust profile), DR-7(c)(d) và DR-8 (scope evidence) đang **DEFER**. Runtime owner của ADR-003 đã được chốt là **Thắng (Leader)** ngày 2026-10-22 (chờ ghi vào decision record). | doc 27 (branch) `:53-57,73-79`; `DATN_BE/AGENTS.md:10,12,20` |
| Source of truth là **native Continuum Task**; Jira không thuộc MVP. | `Document/research-tech/ADR-009:14-15`; `Document/research-docs/03_DAILY_WORKFLOW_AND_JIRA_SYNC.md:28,33` |
| Team routes chưa được wire. | `src/services/iam/iam.module.ts:110-126`; `test/team-foundation-runtime-gate.e2e-spec.ts:55-95` |

Vì vậy mọi tương tác cần Task API đều mang trạng thái **BLOCKED** ở mức runtime gate cho tới khi decision record được commit và `DATN_BE/AGENTS.md` gỡ khóa dormant. Tuy nhiên, **toàn bộ quyết định nghiệp vụ (G1, G4, G6, G7, G8, G10) đã được Thắng chốt ngày 2026-10-22**.

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

### 1.2 Work item lõi & cộng tác (đã chốt G7, G8)

| # | FE view | Action | FE field cần | BE hiện có | Path hiện có | Status | Thiếu gì | Đề xuất (đã chốt nghiệp vụ) | Pri | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| W1 | List, Board, Overview, Calendar, Reports, Timeline | Load work items | `WorkItem` (§3 tài liệu 01) | Task D-05 slice: `listByProject` cursor `afterId`, 7 field | `GET /internal/tasks/projects/{projectId}/tasks` (dormant, chỉ loopback) | **PARTIAL + BLOCKED** | Gateway route; ALLOW policy; thiếu `key`, `type`, `priority`, `dueDate`, `startDate`, `description`, `parentId`, `sprintId`, `labels` | Mở rộng response và thêm Gateway route `/api/v1/tasks/projects/{projectId}/tasks` | P0 | G1–G4, G6 |
| W2 | Detail (modal và page) | Load detail | như W1 + `description`, `steps` | `getById` | `GET /internal/tasks/projects/{projectId}/tasks/{taskId}` (dormant) | **PARTIAL + BLOCKED** | như W1 + `steps` | Mở rộng detail response kèm `ETag` | P0 | G1–G4, G6 |
| W3 | Create dialog, List inline, Board quick create | Create | title, type, priority, assignee, dueDate, description, labels, steps, sprintId | `TaskDataRepository.create({title})` + `TaskCreateController` dormant | `POST /internal/tasks/projects/{projectId}/tasks` (dormant; OpenAPI **NOT APPROVED**) | **PARTIAL + BLOCKED** | chỉ nhận `title`; OpenAPI create đang ở trạng thái proposal (`docs/openapi/README.md:110-127`) | Approve create contract (G2) rồi mở rộng body | P0 | G1–G6 |
| W4 | Detail, List inline | Sửa title, description, priority, due, labels, steps, sprintId | – | không có | – | **MISSING + BLOCKED** | không có field và không có mutation route (D05-DR2 cấm) | `PATCH …/tasks/{taskId}` với CAS `If-Match` | P1 | G1–G6 |
| W5 | List inline, Board DnD, bulk bar, Detail | Đổi status | `TODO/IN_PROGRESS/IN_REVIEW/BLOCKED/DONE/CANCELLED` | `TaskLifecycleCommandService.transitionStatus`, **không có HTTP** | – | **INCOMPATIBLE + BLOCKED** | BE thiếu `IN_REVIEW` (`task-contract.ts:10-16`); bảng chuyển trạng thái ở `task-lifecycle-policy.ts:86-95` | **Đã chốt G7:** thêm `IN_REVIEW` vào BE enum (assignee/Leader/Manager đều chuyển trực tiếp sang `DONE` hoặc qua `IN_REVIEW`); expose `POST …/tasks/{taskId}/transitions` | P0 | G1–G7 |
| W6 | List, Detail, Board | Assign | `assigneeId` | field `assigneeId` có trong schema, **không có command** | – | **MISSING + BLOCKED** | command và validate rằng assignee là ACTIVE project member | `PATCH` (gộp vào W4) | P1 | G1–G6 |
| W7 | List row menu, bulk | Delete | – | không có; có status `CANCELLED` | – | **BLOCKED (chờ mở gate)** | – | **Đã chốt G7:** xóa trên UI = chuyển sang `CANCELLED` kèm `reason` ≥ 5 ký tự (giữ audit, không hard delete) | P1 | G7 (đã chốt) |
| W8 | List bulk bar | Bulk status/delete | danh sách id | không có | – | **MISSING + BLOCKED** | – | Hoãn endpoint riêng (YAGNI). FE gọi W5 tuần tự, giới hạn concurrency | P2 | sau W5 |
| W9 | Toolbar | Search / filter / sort / paginate phía server | `q`, `status`, `assigneeId`, `priority`, `type`, `sprintId`, cursor | chỉ có cursor `_id` | – | **MISSING + BLOCKED** (D05-DR2 cấm filter/sort) | query params và index | Mở rộng W1 bằng filter có allowlist (xem 03, 07) | P1 | G1–G4 |
| W10 | List, Detail | Subtask (CRUD, reorder, convert, đổi parent) | `parentId`, `subtasks{completed,total}` | không có | – | **MISSING + BLOCKED** | field `parentId` và counter | `parentId` trên Task (1 cấp) + batched counts (07 §5) | P1 | G1–G6 |
| W11 | Detail | Checklist / steps | `steps[]` | không có | – | **MISSING + BLOCKED** | – | **Đã chốt G8:** mảng embedded `steps` (≤ 50) trên `tasks`, ghi qua `PATCH` | P1 | G8 (đã chốt) |
| W12 | Detail | Comments | `WorkCommentItem` | không có | – | **MISSING + BLOCKED** | collection và route | **Đã chốt G8:** collection `task_comments` + `GET/POST …/tasks/{taskId}/comments` | P1 | G8 (đã chốt) |
| W13 | Detail, List row "Log work" | Worklog | `timeSpent`, `note` | không có | – | **MISSING + BLOCKED** | collection và route | **Đã chốt G8:** collection `task_worklogs` + `GET/POST …/tasks/{taskId}/worklogs` | P1 | G8 (đã chốt) |
| W14 | Detail History tab | History | `author`, `action`, `createdAt` | `task_events` + `TaskHistoryQueryService` (dormant, không có route) | – | **PARTIAL + BLOCKED** (D05-DR2 cấm Events/history route) | route và projection | Expose `GET …/tasks/{taskId}/history` (page/limit) | P1 | G1–G4, doc 26 |
| W15 | Detail, Board | Labels & Sprint | `labels`, `sprintId` | không có | – | **MISSING + BLOCKED** | – | **Đã chốt G8:** `labels` trên `tasks` + collection `project_sprints` (mỗi Sprint thuộc 1 Project, Leader/Manager tạo & đóng sprint) | P1 | G8 (đã chốt) |
| W16 | Detail | Watch | – | notification module chỉ có health | – | **MISSING** | – | Ngoài phạm vi đợt đầu | P2 | – |

### 1.3 View projections

| # | View | Action | Status | Thiếu gì | Đề xuất | Pri |
|---|---|---|---|---|---|---|
| V1 | Board | Cột theo status và số lượng | **MISSING + BLOCKED** | Group/count | Dùng W1 với filter `status`/`sprintId` + endpoint `summary` (V4). **Không** tạo endpoint board riêng | P1 |
| V2 | Board | Thứ tự card trong cột | **UNUSED** (FE không có reorder trong cột: `WorkBoardView.tsx:297-307`) | – | **Không implement** rank/LexoRank (YAGNI) | – |
| V3 | Calendar | Item theo khoảng ngày | **MISSING + BLOCKED** | `dueDate` + range query | W1 với `dueFrom`/`dueTo` | P1 |
| V3b | Calendar | Kéo thả đổi ngày | **UNUSED** (FE chưa có tính năng này) | – | Không làm | – |
| V4 | Overview, Reports | Aggregate status/priority/type/assignee | **MISSING + BLOCKED** | aggregation | `GET …/task-summary` tính on-demand bằng indexed aggregation (đo ở 07) | P1 |
| V5 | Reports | Burndown, velocity | **MISSING + BLOCKED** | cần sprint counts | **Đã chốt G8:** lấy từ `GET …/sprints` (có sẵn `counts {totalTasks, doneTasks, inProgressTasks, todoTasks}`) kết hợp `task_events` | P1 |
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
| S15 | Board | Complete sprint | không có sprint | **MISSING + BLOCKED** | **Đã chốt G8:** `POST /api/v1/tasks/projects/{projectId}/sprints/{sprintId}/complete` (chỉ Leader/Manager) | P1 |

### 1.5 Endpoint BE không có FE consumer trong Workspace

| Endpoint | Status | Ghi chú |
|---|---|---|
| Team routes (`team-foundation.controller.ts:88-247`) | **UNUSED** trong Work; chưa wire | Có `TeamsWorkspace` riêng, có feature flag |
| `jira` platform integrations (`jira.controller.ts:69-112`) | **UNUSED** trong Work | Chỉ phục vụ Platform operator |
| Chat (~40 route) | **UNUSED** trong Work | Có màn `/chat` riêng |

### 1.6 Màn hình Manager (yêu cầu nghiệp vụ mới, xác nhận 2026-10-22)

Các dòng này đến từ yêu cầu nghiệp vụ của Thắng, **không** đến từ FE PR #69. FE hiện **không có** màn hình này, nên chúng **không nằm trong mẫu số 40** ở §2. Chúng được liệt kê riêng để không bị bỏ sót.

Mô hình vận hành: mỗi Project là một workspace task gắn vĩnh viễn với Organization nơi nó được tạo; Leader của project vận hành; Manager (`ADMIN`) xem toàn bộ task mọi project (kể cả PRIVATE) và tạo/sửa được task mọi project.

| # | Chức năng | BE hiện có | Status | Đề xuất | Gate |
|---|---|---|---|---|---|
| M1 | Bảng task toàn Organization (lọc theo project, trạng thái, người được giao, hạn) | không có; Task hiện chỉ có `projectId` (`task-database-schema.ts:127-141`) | **MISSING + BLOCKED** | `GET /api/v1/tasks/organization/tasks` dùng `organizationId` bất biến trên task ([04](04-api-inventory.yaml)) | G1–G4, G6, **G10 (Phương án A đã chốt)** |
| M2 | Thẻ tổng hợp theo project (tổng, đang làm, trễ hạn) | không có | **MISSING + BLOCKED** | `GET /api/v1/tasks/organization/task-summary` | như M1 |
| M3 | Xem task của từng project (drill-down) | `listByProject` dormant (W1) | **BLOCKED**, tái dùng W1 với quyền ADMIN toàn org | không thêm endpoint | như W1 |
| M4 | Manager tạo và sửa task mọi project | policy D-08 **đã cho** ADMIN chuyển status mọi task (`task-lifecycle-policy.ts:181-182`); chưa có field update | **PARTIAL + BLOCKED** | tái dùng W3/W4/W5 với actor ADMIN; ghi `actor` vào `task_events` | G4 (đã chốt nghiệp vụ) |
| M5 | Manager thấy project PRIVATE không phải thành viên | `ProjectAccessAuthorizationGuard` đã cho ADMIN phạm vi org (`authorization.policy.ts:245-301`) với API project của IAM | **MATCHED** ở tầng IAM; Task chưa có | Task authorization phải dùng cùng quy tắc | G4 (đã chốt nghiệp vụ) |
| M6 | Màn hình FE cho Manager | – | **MISSING (FE)** | thiết kế UI mới theo Rule 06 | – |

## 2. Tổng hợp

Mẫu số được đếm từ ma trận của §1.1–1.5 (không gồm §1.6). Mỗi capability chỉ đếm một lần, kể cả khi nhiều view dùng chung.

| Chỉ số | Giá trị | Ghi chú |
|---|---|---|
| View chức năng (không trùng) | **11** | 10 tab + Issue Detail (modal và page là một component) |
| Route | 3 | `/workspace`, `/projects/:id/work`, `/projects/:id/work-notes` |
| Capability có FE consumer (C + W + V + S, trừ V2, V3b, S14) | **40** | C1–C4 (4), W1–W16 (16), V1/V3/V4/V5/V6/V7 (6), S1–S13 (13), S15 (1) |
| MATCHED (reuse được ngay) | **4** | C1–C4 |
| PARTIAL (backend có một phần, dormant, kèm BLOCKED) | **4** | W1, W2, W3, W14 |
| INCOMPATIBLE (kèm BLOCKED) | **3** | W5 (thêm `IN_REVIEW` đã chốt ở G7), S1 (schema Work Notes), S6 (role scope) |
| BLOCKED_DECISION (đã giải quyết 4/8 cho Task; còn 4 cho module phụ) | **8** | Đã chốt cho Task: W7, W15, V5, S15. Còn chờ cho module phụ: S4, S9, S10, S12 |
| MISSING (kèm BLOCKED vì chưa mở gate dormant) | **21** | W4, W6, W8–W13, W16, V1, V3, V4, V6, V7, S2, S3, S5, S7, S8, S11, S13 |
| Kiểm tra tổng | 4 + 4 + 3 + 8 + 21 = **40** | |
| UNUSED (không implement) | 2 FE + 3 nhóm BE | V2, V3b; Team, Jira ops, Chat |

## 3. Trạng thái các Gate sau khi Thắng xác nhận ngày 2026-10-22

| Gate | Nội dung | Trạng thái | Quyết định đã chốt / việc kỹ thuật còn lại |
|---|---|---|---|
| **G1** | Chỉ định accountable runtime owner của ADR-003 và workflow migration/seed cho `continuum_task` | **ĐÃ CHỐT NGHIỆP VỤ** | **Thắng (Leader)** đảm nhận vai trò runtime owner cho `continuum_task`. Chỉ còn ghi vào decision record và cập nhật `DATN_BE/AGENTS.md` |
| **G2** | Approve OpenAPI cho các op mới (`04-api-inventory.yaml`) | **SẴN SÀNG DUYỆT** | OpenAPI 3.1.0 đã bao gồm đủ 17 operation theo quyết định của Thắng và pass `@redocly/cli@1 lint` |
| **G3** | DR-3: trust profile Gateway→Task (verifier, mTLS, replay) | **CHỜ GHI DECISION RECORD** | Khuyến nghị dùng EdDSA signed context (đã có prototype trong `src/services/task/runtime/prototypes/**`) |
| **G4** | DR-8: nguồn scope evidence và ma trận phân quyền | **ĐÃ CHỐT MA TRẬN QUYỀN** | Manager (`ADMIN`) xem/tạo/sửa mọi project (kể cả PRIVATE); Leader (`TEAM_LEADER`) vận hành project của mình + quản lý sprint; Member (`MEMBER`) tạo task và sửa task mình tạo hoặc được giao |
| **G5** | DR-7(c)(d): điều kiện cho create | **ĐÃ CHỐT NGHIỆP VỤ** | Cho phép ADMIN, TEAM_LEADER, MEMBER tạo task với `Idempotency-Key` |
| **G6** | Mở rộng schema `tasks` + các collection mới (`task_counters`, `task_comments`, `task_worklogs`, `project_sprints`) | **ĐÃ CHỐT PHẠM VI** | Thực hiện bằng migration mới ở bước `DB-1` |
| **G7** | Enum status/transition và hành vi Delete | **ĐÃ CHỐT** | Thêm `IN_REVIEW` vào BE enum; cả assignee, Leader, Manager đều được chuyển thẳng sang `DONE` hoặc qua `IN_REVIEW`; Delete = chuyển sang `CANCELLED` kèm `reason` ≥ 5 ký tự |
| **G8** | Phạm vi MVP cho comments, worklog, checklist, sprint, labels | **ĐÃ CHỐT** | Đưa cả 5 tính năng (`labels`, `steps`, `comments`, `worklogs`, `project_sprints`) vào phạm vi triển khai; mỗi Sprint thuộc 1 Project |
| **G9** | Contract Work Notes / Knowledge / Weekly report (đồng bộ ADR-009 `taskId`) | **TÁCH PHA SAU** | Thuộc module `capture`/`lifecycle`, tách khỏi pha Task core |
| **G10** | Truy vấn "mọi task của org" cho màn hình Manager | **ĐÃ CHỐT (PHƯƠNG ÁN A)** | Lưu `organizationId` bất biến trên mỗi document `tasks` + 4 index tiền tố `organizationId`; xác nhận Project gắn vĩnh viễn với Organization lúc tạo |
