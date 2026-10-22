# 03 — API Contract Design (đề xuất, CHƯA APPROVE)

> [!IMPORTANT]
> Tài liệu này là **proposal** đã tích hợp đầy đủ các quyết định nghiệp vụ do **Thắng (Product Owner / Runtime Owner)** xác nhận ngày 2026-10-22. Theo `DATN_BE/AGENTS.md:22`, business API phải được ghi nhận trong decision record và approve OpenAPI trước khi implement. Contract máy-đọc-được nằm ở [04-api-inventory.yaml](04-api-inventory.yaml) (`x-approval-status: PROPOSED_NOT_APPROVED`).

## 1. Nguyên tắc thiết kế (áp dụng từ repo, không tự đặt chuẩn mới)

| Quy ước | Áp dụng | Evidence |
|---|---|---|
| Public path | `/api/v1/tasks/...`, ánh xạ 1-1 sang `/internal/tasks/...` qua rewrite sẵn có của Gateway | `src/gateway/gateway-iam.controller.ts:921`; ADR-010 (Gateway forward tới Task) |
| Error shape | `{code, message, details, requestId}`; **không** đưa RFC 9457 vào để tránh hai chuẩn lỗi song song | `src/common/http/structured-exception.filter.ts:18-58` |
| Envelope | DTO trả trực tiếp, không bọc thêm; trang Task/Comment/Worklog dùng `{items, nextAfterId}` (D-05) | `src/services/task/http/task-response.ts`; `docs/openapi/task-v1-d05-slice.openapi.json` |
| Pagination | Keyset `afterId` + `limit` 1–100 (D-05 DR-6). Bổ sung `cursor` opaque cho chế độ date-range | doc 27 DR-6; đo ở [07](07-performance-analysis.md) §2 |
| Non-member / cross-scope | **404**, không để lộ sự tồn tại của resource | slice OpenAPI; `ProjectAccessAuthorizationGuard` trả `PROJECT_NOT_FOUND` |
| CAS | `If-Match: "task:<id>:<version>"` (hoặc `"sprint:<id>:<version>"` cho Sprint) và `ETag` cùng định dạng; thiếu header thì `428 PRECONDITION_REQUIRED`; stale thì `409 TASK_VERSION_CONFLICT` / `SPRINT_VERSION_CONFLICT` | `team-contract.ts:188-207`; `task-lifecycle-policy.ts:108-115` |
| Idempotency | `Idempotency-Key` cho create task/comment/worklog/sprint (regex giống Team/IAM). Với transition, key UUIDv4 được lưu làm `operationId` | `team-contract.ts:33,178-184`; `task_operations` (`task-database-schema.ts:84-120`) |
| CSRF | `X-CSRF-Token` = cookie `__Host-csrf` cho mọi mutation | `organization-membership-command.controller.ts:402…`; `team-foundation.controller.ts:249-258` |
| Membership | Mọi op kiểm tra ACTIVE org membership **và** ACTIVE project membership (hoặc role ADMIN toàn org) ở server | `AGENTS.md:25`; `task-lifecycle-policy.ts:102-105` |
| Cache | `Cache-Control: no-store`, giữ như hiện tại | các list IAM và Chat |

## 2. Bề mặt API (đã đồng bộ phạm vi G7, G8, G10 do Thắng chốt)

Tổng cộng **17 operation**:
- **7 operation Task lõi theo project** (#1–#7)
- **4 operation Comments & Worklogs theo task** (#8–#11, theo quyết định G8)
- **4 operation Sprints theo project** (#12–#15, theo quyết định G8)
- **2 operation Manager toàn Organization** (#16–#17, theo quyết định G4 & G10)

Không tạo endpoint riêng cho Board, Calendar hay Timeline vì cả ba đều là **projection của list** với filter khác nhau (`status`, `sprintId`, `dueFrom`/`dueTo`, `parentId`).

| # | Method | Path (public) | Consumer FE | Trạng thái | Ghi chú |
|---|---|---|---|---|---|
| 1 | GET | `/api/v1/tasks/projects/{projectId}/tasks` | List, Board (theo cột `status` / `sprintId`), Calendar (`dueFrom`/`dueTo`), Timeline, Reports table, subtask (`parentId`) | mở rộng op **đã APPROVE** | additive: thêm filter (gồm `sprintId`) và field |
| 2 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}` | Issue Detail (modal + page) | mở rộng op **đã APPROVE** | trả thêm `ETag`, `steps`, `labels`, `sprintId` |
| 3 | POST | `/api/v1/tasks/projects/{projectId}/tasks` | Create dialog, inline create, quick create | mở rộng **PROPOSAL** create | `Idempotency-Key` |
| 4 | PATCH | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}` | Detail edit, inline priority/assignee, timeline date, đổi parent, checklist `steps`, `labels`, `sprintId` | MỚI | không cho ghi `status` |
| 5 | POST | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/transitions` | Board DnD, inline status, bulk bar, detail, delete (`toStatus=CANCELLED`) | MỚI (mở rộng policy D-08 thêm `IN_REVIEW`) | |
| 6 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/history` | History tab | MỚI (adapter của D-09 đã ACCEPT) | |
| 7 | GET | `/api/v1/tasks/projects/{projectId}/task-summary` | Overview, header cột Board, KPI Reports | MỚI | aggregation on-demand |
| 8 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/comments` | Detail Comments tab | MỚI (G8) | keyset `afterId` |
| 9 | POST | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/comments` | Detail add comment | MỚI (G8) | `Idempotency-Key` + CSRF |
| 10 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/worklogs` | Detail Worklog tab | MỚI (G8) | keyset `afterId` + `totalMinutes` |
| 11 | POST | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/worklogs` | Detail / List row "Log work" | MỚI (G8) | `Idempotency-Key` + CSRF |
| 12 | GET | `/api/v1/tasks/projects/{projectId}/sprints` | Board sprint header, List/Reports sprint filter, Burndown/Velocity | MỚI (G8) | theo từng project |
| 13 | POST | `/api/v1/tasks/projects/{projectId}/sprints` | Create sprint | MỚI (G8) | chỉ `TEAM_LEADER` hoặc `ADMIN` |
| 14 | PATCH | `/api/v1/tasks/projects/{projectId}/sprints/{sprintId}` | Edit sprint name/goal/dates/start sprint | MỚI (G8) | chỉ `TEAM_LEADER` hoặc `ADMIN`; bắt buộc `If-Match: "sprint:<id>:<version>"` |
| 15 | POST | `/api/v1/tasks/projects/{projectId}/sprints/{sprintId}/complete` | Board "Complete sprint" | MỚI (G8) | chỉ `TEAM_LEADER` hoặc `ADMIN`; bắt buộc `If-Match` + `Idempotency-Key`; tùy chọn dời task chưa xong |
| 16 | GET | `/api/v1/tasks/organization/tasks` | Màn hình Manager toàn org (bảng task) | MỚI (G4, G10) | chỉ `ADMIN`; keyset `afterId` hoặc `cursor` (cho `dueFrom`/`dueTo`) |
| 17 | GET | `/api/v1/tasks/organization/task-summary` | Màn hình Manager toàn org (thẻ theo project) | MỚI (G4, G10) | chỉ `ADMIN`; `totals` toàn org + phân trang `projects` bằng `limit` & `cursor`/`nextCursor` |

### 2.1 Lý do tách `status` khỏi `PATCH` và quy tắc `IN_REVIEW` / `CANCELLED` (G7 đã chốt)

Policy chuyển trạng thái nằm ở **một chỗ duy nhất** là `evaluateTaskLifecycleTransition` (`task-lifecycle-policy.ts:97-157`). Theo xác nhận của Thắng (G7):
1. **Bổ sung trạng thái `IN_REVIEW`** vào enum BE: `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`, `CANCELLED`.
2. **Bảng chuyển trạng thái cập nhật** (cần cập nhật decision record D-08 + migration validator):
   - `TODO` → `IN_PROGRESS`, `BLOCKED`, `CANCELLED`
   - `IN_PROGRESS` → `TODO`, `IN_REVIEW`, `BLOCKED`, `DONE`, `CANCELLED`
   - `IN_REVIEW` → `IN_PROGRESS`, `BLOCKED`, `DONE`, `CANCELLED`
   - `BLOCKED` → `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `CANCELLED`
   - `DONE` → `IN_PROGRESS` (reopen)
   - `CANCELLED` → `TODO` (reopen)
3. **Quyền chuyển sang `DONE` và `IN_REVIEW`:** Cả người được giao (`MEMBER`), `TEAM_LEADER` và `ADMIN` đều có thể chuyển task trực tiếp sang `DONE` (`IN_PROGRESS → DONE`) hoặc đi qua bước `IN_REVIEW` (`IN_PROGRESS → IN_REVIEW → DONE`). `IN_REVIEW` là bước review tùy chọn, không chặn người được giao hoàn thành task.
4. **Xóa task trên UI = chuyển sang `CANCELLED`:** Nút "Delete task" trên FE gọi `POST …/transitions` với `toStatus: "CANCELLED"` kèm `reason` (≥ 5 ký tự) để giữ toàn vẹn lịch sử audit. Không có hard delete.
5. **Lý do bắt buộc (`reason` ≥ 5 code points):** Áp dụng khi chuyển sang `BLOCKED`, `CANCELLED`, hoặc reopen từ `DONE`/`CANCELLED`.

**Hệ quả với FE Board (bắt buộc ghi vào handoff):**
- Kéo thẳng `TODO → DONE` hoặc `TODO → IN_REVIEW` sẽ nhận `422 TASK_TRANSITION_NOT_ALLOWED`.
- Khi chuyển sang `BLOCKED` hoặc xóa (`CANCELLED`), FE phải mở prompt nhập `reason` (≥ 5 ký tự).

### 2.2 Board, Calendar, Timeline không có endpoint riêng

| View | Gọi | Lý do |
|---|---|---|
| Board | `GET …/tasks?status=TODO&limit=50`, mỗi cột một request (song song, tối đa 6) + `task-summary` để có header count; có thể truyền thêm `sprintId` | Phân trang theo từng cột; index `{projectId,status,_id}`. Không cần LexoRank vì FE **không** có reorder trong cột (`WorkBoardView.tsx:297-307`) |
| Calendar | `GET …/tasks?dueFrom=…&dueTo=…&limit=100` + `cursor`; drawer "unscheduled" dùng `GET …/tasks?dueDate=none` | Index **không partial** `{projectId,dueDate,_id}` (partial index không được planner chọn cho range query, đo ở 07 §3); cửa sổ ≤ 100 ngày |
| Timeline | `GET …/tasks?parentId=none&dueFrom&dueTo`, child lazy qua `parentId=<id>` | Không load toàn bộ cây; chỉ 1 cấp |

### 2.3 Subtask & Checklist (`steps`)

- **Subtask:** Mỗi subtask là một Task có `parentId`. Hierarchy giới hạn **1 cấp**: validate `TASK_PARENT_INVALID` nếu parent đã là subtask hoặc nằm ở project khác. `subtaskCounts {total, done}` được tính bằng **1 aggregation batched** cho các id trong trang (đo ở [07](07-performance-analysis.md) §5).
- **Checklist (`steps`):** Mảng embedded tối đa 50 phần tử `{id, text, done}` ngay trên document `tasks`, cập nhật qua `PATCH /api/v1/tasks/projects/{projectId}/tasks/{taskId}` (bảo vệ bằng `If-Match` CAS).

### 2.4 Task key `<CODE>-<n>`

- FE hiển thị key (`work-types.ts:72-97`). Cấp phát atomic bằng `findOneAndUpdate({_id: projectId}, {$inc: {seq: 1}})` trên collection `task_counters` của Task service, kèm unique index `{projectId, key}`.
- Project code đã có ở IAM (`POST iam/projects` body `{name, code}`). Task service **không** gọi sang IAM ở mỗi request; code được đưa vào qua scope evidence (G4).

### 2.5 Phân quyền (đã được Thắng xác nhận ngày 2026-10-22)

Mô hình vận hành: **mỗi Project là một workspace task riêng**; **Leader của project là người vận hành chính**; **Manager (`ADMIN`) có màn hình tổng hợp task của mọi project và xem/tạo/sửa từng task của từng project**.

| Op | ADMIN (Manager) | TEAM_LEADER (của project đó) | MEMBER (của project đó) | Nguồn / ghi chú |
|---|---|---|---|---|
| list, detail, history, summary, comments, worklogs, sprints (read) theo project | ✓ mọi project trong org, **kể cả project PRIVATE mà Manager không là thành viên** | ✓ | ✓ | Thắng xác nhận. `ProjectAccessAuthorizationGuard` hiện đã cho ADMIN phạm vi org (`authorization.policy.ts:245-301`) |
| list, summary **toàn org** (màn hình Manager) | ✓ | ✗ (trả 404) | ✗ (trả 404) | mục 2.6 |
| create task | ✓ **mọi project trong org, kể cả project mình không là thành viên** | ✓ | ✓ (Member được tự tạo task) | task do Manager tạo ghi `createdBy` = Manager; assignee vẫn phải là ACTIVE project member |
| update field (title, description, priority, due, labels, parent, steps, sprintId) | ✓ mọi task mọi project | ✓ mọi task của project | chỉ task **mình tạo hoặc được giao** | Thắng xác nhận |
| assign / đổi `assigneeId` | ✓ | ✓ | theo quyền update của Member ở trên, và assignee phải là ACTIVE project member | |
| transition (kể cả `IN_REVIEW`, `DONE`, `CANCELLED`) | ✓ mọi task | ✓ mọi task của project | chỉ task được giao cho mình (cancel/reopen: thêm creator) | Thắng xác nhận (G7) |
| add comment / add worklog | ✓ mọi project | ✓ | ✓ mọi member ACTIVE của project | Thắng xác nhận (G8) |
| create / update / complete sprint | ✓ mọi project | ✓ project của mình | ✗ (`403 TASK_OPERATION_FORBIDDEN`) | Thắng xác nhận (G8): Leader của project (hoặc Manager) quản lý sprint |

**Lưu ý về nguyên tắc BA:** tài liệu BA nêu "Manager quản trị Organization nhưng không mặc nhiên có quyền quản lý nội dung của mọi Project". Quyết định cho Manager **tạo và sửa** task mọi project là ngoại lệ có chủ đích do Product Owner chốt. Mọi thay đổi do ADMIN thực hiện đều ghi `actor` và `actorType` vào `task_events` (`task-database-schema.ts:48-79`), hiển thị rõ trên History tab.

Quyền được đánh giá ở server từ evidence (ACTIVE org + project membership + RoleAssignment). **Không bao giờ tin** `organizationId`, `userId` hay role do FE gửi lên.

### 2.6 Màn hình Manager: task toàn Organization (G10 Phương án A)

Thắng đã chốt:
- **G10 = Phương án A:** lưu `organizationId` bất biến trên mỗi document `tasks` (lấy từ trusted context của server khi tạo task) kèm 4 compound index có tiền tố `organizationId`.
- **Project không bao giờ chuyển sang Organization khác:** mỗi Project gắn vĩnh viễn với `Organization` nơi nó được tạo.

| # | Method | Path (public) | Mục đích |
|---|---|---|---|
| 16 | GET | `/api/v1/tasks/organization/tasks` | Bảng task toàn org: thứ tự mặc định `_id` tăng dần với `afterId`; khi truyền `dueFrom`/`dueTo` thì sắp theo `dueDate` tăng dần, `_id` tăng dần và dùng `cursor`/`nextCursor` |
| 17 | GET | `/api/v1/tasks/organization/task-summary` | Thẻ tổng hợp: `totals` luôn phản ánh toàn bộ Organization; danh sách `projects` được phân trang keyset (`limit` 1..200 mặc định 50, `cursor`/`nextCursor` mã hóa `(overdue, total, projectId)`) để truy cập được mọi Project ngay cả khi vượt 200 |

- **Organization không nằm trong path.** Org lấy từ session đã xác thực (`AGENTS.md:25`).
- Chỉ ADMIN truy cập được. Các role khác nhận **404** (không tiết lộ sự tồn tại).
- Màn hình này **chưa tồn tại ở FE** (PR #69 chỉ có workspace theo từng project). Sẽ được xây dựng ở bước `FE-5` theo Rule 06.

### 2.7 Comments, Worklogs & Sprints theo Project (G8 đã chốt)

1. **Task Comments (`task_comments`):**
   - `GET /api/v1/tasks/projects/{projectId}/tasks/{taskId}/comments?afterId&limit`: trả `{items, nextAfterId}` theo thứ tự `_id` tăng dần (cũ → mới) hoặc mới → cũ nhất quán với cursor.
   - `POST /api/v1/tasks/projects/{projectId}/tasks/{taskId}/comments`: body `{body: string (1..5000)}`, yêu cầu `Idempotency-Key` và `X-CSRF-Token`.
2. **Task Worklogs (`task_worklogs`):**
   - `GET /api/v1/tasks/projects/{projectId}/tasks/{taskId}/worklogs?afterId&limit`: trả `{items, totalMinutes, nextAfterId}`.
   - `POST /api/v1/tasks/projects/{projectId}/tasks/{taskId}/worklogs`: body `{minutes: int (1..1440), loggedAt?: date-time, note?: string (≤2000)}`, cộng dồn hoặc tính tổng `totalMinutes`.
3. **Project Sprints (`project_sprints`):**
   - Mỗi Sprint thuộc **một Project** (`projectId`, `organizationId`, `name`, `goal`, `status: PLANNED | ACTIVE | COMPLETED`, `startDate`, `endDate`, `completedAt`, `version`).
   - Mỗi Task có tối đa 1 `sprintId` (`ObjectId | null`).
   - Tại một thời điểm một Project có tối đa 1 sprint ở trạng thái `ACTIVE`.
   - Khi gọi `POST …/sprints/{sprintId}/complete`, Leader/Manager có thể truyền `moveIncompleteToSprintId` (`ObjectId | null`, `null` = đưa về backlog) để dời các task chưa `DONE`/`CANCELLED` trong cùng transaction.
   - Endpoint `GET …/sprints` trả kèm thống kê `{totalTasks, doneTasks, inProgressTasks, todoTasks}` trên mỗi sprint để FE vẽ **Velocity** và **Burndown** trong Reports mà không cần N+1 request.

## 3. Ánh xạ field FE ↔ contract

| FE (`work-types.ts`) | Contract | Chuyển đổi |
|---|---|---|
| `id` | `id` | – |
| `key` | `key` | – |
| `title` | `title` | – |
| `type` | `type` | giống enum (`TASK`, `BUG`, `STORY`) |
| `status` | `status` | Đã đồng bộ: `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`, `CANCELLED` (G7) |
| `assignee: WorkPerson` | `assigneeId` | FE join với C4 (`/iam/projects/{id}/memberships`) để lấy `fullName`; initials tính ở FE |
| `reporter` | `createdBy` | join như trên |
| `priority` | `priority` | – |
| `createdAt` (free text) | ISO-8601 | FE format bằng `next-intl` |
| `dueDate`, `startDate` | ISO-8601 \| null | – |
| `parent {key, summary}` | `parentId` | FE tra từ trang hoặc gọi detail |
| `subtasks {completed,total}` | `subtaskCounts {done,total}` | đổi tên field |
| `subtaskItems` | `GET …/tasks?parentId=<id>` | lazy load |
| `labels` | `labels` | `string[]` (tối đa 20) |
| `steps` | `steps` | `TaskChecklistStep[]` (tối đa 50) trên `TaskDetail` |
| `sprint` | `sprintId` | join với `GET …/sprints` của project |
| `comments` | `GET/POST …/tasks/{taskId}/comments` | tách sub-resource có phân trang |
| `worklogs` / `timeSpent` | `GET/POST …/tasks/{taskId}/worklogs` | tách sub-resource có `totalMinutes` |
| `storyPoints`, `team`, `flagged`, `resolution` | **ngoài phạm vi** | FE ẩn hoặc vô hiệu hóa |
| `projectName` | từ C3 (hoặc có sẵn trên `OrganizationTask`) | – |

## 4. Năng lực ngoài phạm vi Task API (G9 / P2)

Các năng lực thuộc module khác chưa đưa vào OpenAPI của Task:

| Năng lực | Hướng đề xuất | Lý do chưa đưa vào |
|---|---|---|
| Work Notes | Contract riêng ở module `capture`, thêm `taskId` theo ADR-009 §3; xử lý field FE `kind/body/blocker/nextStep/week` khác schema `work_notes` (`whatDone/howSolved/whyThisWay`) | Gate G9 (module `capture`) |
| Weekly report | Product chốt gộp vào Work Note (`kind=WEEKLY_SUMMARY`) hay tách entity | Gate G9 |
| Knowledge approve | module `lifecycle` (`knowledge_proposals`) | Gate G9 |
| Docs | module `ingestion` (`documents`) + permission filter trước khi gửi AI | `AGENTS.md:24` |
| Forms, Development, Automations, AI Copilot | – | chưa có ADR hay module |

## 5. Yêu cầu test cho mỗi op (khi được implement)

| Op | Unit | Integration (Mongo replica set) | Contract | Security negative |
|---|---|---|---|---|
| list | parse/validate query allowlist (gồm `sprintId`), cursor encode/decode | filter + keyset ổn định với dữ liệu trùng `dueDate` | response khớp `Task` schema | project khác → 404; member INACTIVE → 404; org khác → 404; `assigneeId=me` không nhận id từ client |
| create | validate body | key unique khi tạo đồng thời (N tiến trình); gán `organizationId` từ context | 201 + Location + ETag | replay cùng key → cùng body; khác body → 409 `IDEMPOTENCY_KEY_REUSED` |
| update | allowlist field, `parentId` 1 cấp, `steps` ≤ 50 | CAS với 2 writer đồng thời: chính xác 1 thắng | 428/409 | assignee không phải member → 422; `sprintId` thuộc project khác → 422 |
| transition | test policy D-08 mở rộng (`IN_REVIEW`, `CANCELLED` delete) | atomic với event `TASK_STATUS_TRANSITIONED` | 200 + ETag | MEMBER chuyển task người khác → 403; thiếu `reason` khi `CANCELLED`/`BLOCKED` → 422 |
| comments / worklogs | validate body (`minutes` 1..1440, `body` 1..5000) | keyset pagination + idempotency | 200/201 khớp schema | cross-project / non-member → 404 |
| sprints | validate dates (`startDate < endDate`), tối đa 1 ACTIVE sprint/project | complete sprint dời task chưa xong trong transaction | 200/201 khớp schema | MEMBER gọi create/patch/complete sprint → 403 |
| history | page/limit | thứ tự newest-first | schema | cross-project → 404 |
| summary & org overview | mốc thời gian UTC | đối chiếu count với dataset seed | schema | non-ADMIN gọi `/organization/*` → 404; cross-org → không rò rỉ dữ liệu |
