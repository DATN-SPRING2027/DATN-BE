# 03 — API Contract Design (đề xuất, CHƯA APPROVE)

> [!IMPORTANT]
> Tài liệu này là **proposal**. Theo `DATN_BE/AGENTS.md:22`, business API phải được approve OpenAPI trước khi implement. Contract máy-đọc-được nằm ở [04-api-inventory.yaml](04-api-inventory.yaml) (`x-approval-status: PROPOSED_NOT_APPROVED`).

## 1. Nguyên tắc thiết kế (áp dụng từ repo, không tự đặt chuẩn mới)

| Quy ước | Áp dụng | Evidence |
|---|---|---|
| Public path | `/api/v1/tasks/...`, ánh xạ 1-1 sang `/internal/tasks/...` qua rewrite sẵn có của Gateway | `src/gateway/gateway-iam.controller.ts:921`; ADR-010 (Gateway forward tới Task) |
| Error shape | `{code, message, details, requestId}`; **không** đưa RFC 9457 vào để tránh hai chuẩn lỗi song song | `src/common/http/structured-exception.filter.ts:18-58` |
| Envelope | DTO trả trực tiếp, không bọc thêm; trang Task dùng `{items, nextAfterId}` (D-05) | `src/services/task/http/task-response.ts`; `docs/openapi/task-v1-d05-slice.openapi.json` |
| Pagination | Keyset `afterId` + `limit` 1–100 (D-05 DR-6). Bổ sung `cursor` opaque cho chế độ date-range | doc 27 DR-6; đo ở [07](07-performance-analysis.md) §2 |
| Non-member / cross-scope | **404**, không để lộ sự tồn tại của resource | slice OpenAPI; `ProjectAccessAuthorizationGuard` trả `PROJECT_NOT_FOUND` |
| CAS | `If-Match: "task:<id>:<version>"` và `ETag` cùng định dạng; thiếu header thì `428 PRECONDITION_REQUIRED`; stale thì `409 TASK_VERSION_CONFLICT` | `team-contract.ts:188-207`; `task-lifecycle-policy.ts:108-115` |
| Idempotency | `Idempotency-Key` cho create (regex giống Team/IAM). Với transition, key UUIDv4 được lưu làm `operationId` | `team-contract.ts:33,178-184`; `task_operations` (`task-database-schema.ts:84-120`) |
| CSRF | `X-CSRF-Token` = cookie `__Host-csrf` cho mọi mutation | `organization-membership-command.controller.ts:402…`; `team-foundation.controller.ts:249-258` |
| Membership | Mọi op kiểm tra ACTIVE org membership **và** ACTIVE project membership ở server | `AGENTS.md:25`; `task-lifecycle-policy.ts:102-105` |
| Cache | `Cache-Control: no-store`, giữ như hiện tại | các list IAM và Chat |

## 2. Bề mặt API tối thiểu

Chỉ có **7 operation trên 5 resource**. Không có endpoint riêng cho Board, Calendar hay Timeline vì cả ba đều là **projection của list** với filter khác nhau. Cách này tránh nhân bản authorization và logic query.

| # | Method | Path (public) | Consumer FE | Trạng thái | Ghi chú |
|---|---|---|---|---|---|
| 1 | GET | `/api/v1/tasks/projects/{projectId}/tasks` | List, Board (theo cột `status`), Calendar (`dueFrom`/`dueTo`), Timeline, Reports table, subtask (`parentId`) | mở rộng op **đã APPROVE** | additive: thêm filter và field |
| 2 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}` | Issue Detail (modal + page) | mở rộng op **đã APPROVE** | trả thêm `ETag` |
| 3 | POST | `/api/v1/tasks/projects/{projectId}/tasks` | Create dialog, inline create, quick create (Forms/Dev chỉ khi G8/G9 mở) | mở rộng **PROPOSAL** create | `Idempotency-Key` |
| 4 | PATCH | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}` | Detail edit, inline priority/assignee, timeline date, đổi parent | MỚI | không cho ghi `status` |
| 5 | POST | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/transitions` | Board DnD, inline status, bulk bar, detail | MỚI (adapter của policy D-08 đã APPROVE) | |
| 6 | GET | `/api/v1/tasks/projects/{projectId}/tasks/{taskId}/history` | History tab | MỚI (adapter của D-09 đã ACCEPT) | |
| 7 | GET | `/api/v1/tasks/projects/{projectId}/task-summary` | Overview, header cột Board, KPI Reports | MỚI | aggregation on-demand |

### 2.1 Lý do tách `status` khỏi `PATCH`

Policy chuyển trạng thái đã được approve ở mức dormant (doc 25 D-08) và nằm ở **một chỗ duy nhất** là `evaluateTaskLifecycleTransition` (`task-lifecycle-policy.ts:97-157`):
- bảng transition (`:86-95`)
- reason ≥ 5 code point cho BLOCKED, CANCELLED và reopen (`:159-166`)
- TODO→IN_PROGRESS bắt buộc có assignee (`:174-179`)
- MEMBER chỉ được chuyển task được giao cho mình; cancel/reopen chỉ creator; ADMIN và TEAM_LEADER được chuyển mọi task (`:181-188`)

Nếu cho `PATCH {status}` thì sẽ có hai đường ghi status, dễ bỏ sót luật. Vì vậy `status` chỉ ghi được qua resource `transitions`.

**Hệ quả với FE Board (bắt buộc ghi vào handoff):**
- Kéo thẳng `TODO → DONE` sẽ nhận `422 TASK_TRANSITION_NOT_ALLOWED`, vì bảng transition không có cặp này.
- FE phải chặn drop không hợp lệ dựa trên bảng transition, hoặc hiển thị lỗi rồi rollback.
- Khi chuyển sang BLOCKED/CANCELLED, FE phải mở prompt nhập reason.

### 2.2 Board, Calendar, Timeline không có endpoint riêng

| View | Gọi | Lý do |
|---|---|---|
| Board | `GET …/tasks?status=TODO&limit=50`, mỗi cột một request (song song, tối đa 5) + `task-summary` để có header count | Phân trang theo từng cột; index `{projectId,status,_id}`. Không cần LexoRank vì FE **không** có reorder trong cột (`WorkBoardView.tsx:297-307`) |
| Calendar | `GET …/tasks?dueFrom=…&dueTo=…&limit=100` + `cursor`; drawer "unscheduled" dùng `GET …/tasks?dueDate=none` (nếu Product giữ drawer) | Index **không partial** `{projectId,dueDate,_id}` (partial index không được planner chọn cho range query, đo ở 07 §3); cửa sổ ≤ 100 ngày |
| Timeline | `GET …/tasks?parentId=none&dueFrom&dueTo`, child lazy qua `parentId=<id>` | Không load toàn bộ cây; chỉ 1 cấp |

### 2.3 Subtask

- Mỗi subtask là một Task có `parentId`. Hierarchy giới hạn **1 cấp**: validate `TASK_PARENT_INVALID` nếu parent đã là subtask hoặc nằm ở project khác.
- `subtaskCounts {total, done}` được tính bằng **1 aggregation batched** cho các id trong trang. Không lưu counter denormalized, nên không có rủi ro lệch dữ liệu. Đo ở [07](07-performance-analysis.md) §5.

### 2.4 Task key `<CODE>-<n>`

- FE hiển thị key (`work-types.ts:72-97`). Đề xuất cấp phát atomic bằng `findOneAndUpdate({_id: projectId}, {$inc: {seq: 1}})` trên collection counter của Task service, kèm unique index `{projectId, key}`.
- Project code đã có ở IAM (`POST iam/projects` body `{name, code}`). Task service **không** gọi sang IAM ở mỗi request; code được đưa vào qua scope evidence (G4) hoặc snapshot lúc tạo task.

### 2.5 Phân quyền đề xuất (chờ G4)

| Op | ADMIN | TEAM_LEADER (project) | MEMBER (project) | Nguồn |
|---|---|---|---|---|
| list, detail, history, summary | ✓ | ✓ | ✓ | khớp `project.members.list` |
| create | ✓ | ✓ | ✓ | `03_DAILY` cho Member tạo task trong project của mình (đề xuất) |
| update field | ✓ | ✓ | chỉ task mình tạo hoặc được giao (đề xuất) | **cần Product chốt** |
| transition | theo policy D-08 | theo policy D-08 | theo policy D-08 | `task-lifecycle-policy.ts:168-189` |

Quyền phải được đánh giá ở server từ evidence (ACTIVE org + project membership + RoleAssignment). **Không bao giờ tin** `organizationId`, `userId` hay role do FE gửi lên.

## 3. Ánh xạ field FE ↔ contract

| FE (`work-types.ts`) | Contract | Chuyển đổi |
|---|---|---|
| `id` | `id` | – |
| `key` | `key` | – |
| `title` | `title` | – |
| `type` | `type` | giống enum |
| `status` `IN_REVIEW` | **không có** | **G7**: thêm `IN_REVIEW` vào BE (cần migration + đổi policy), **hoặc** FE ánh xạ cột "In Review" sang `BLOCKED`. Khuyến nghị: Product chốt |
| `assignee: WorkPerson` | `assigneeId` | FE join với C4 (`/iam/projects/{id}/memberships`) để lấy `fullName`; initials tính ở FE |
| `reporter` | `createdBy` | join như trên |
| `priority` | `priority` | – |
| `createdAt` (free text) | ISO-8601 | FE format bằng `next-intl` |
| `dueDate`, `startDate` | ISO-8601 \| null | – |
| `parent {key, summary}` | `parentId` | FE tra từ trang hoặc gọi detail |
| `subtasks {completed,total}` | `subtaskCounts {done,total}` | đổi tên field |
| `subtaskItems` | `GET …/tasks?parentId=<id>` | lazy load |
| `labels` | `labels` | – |
| `comments`, `worklogs`, `steps`, `sprint`, `storyPoints`, `team`, `flagged`, `resolution` | **ngoài phạm vi** (G8) | FE ẩn hoặc vô hiệu hóa với nhãn "Not available yet" thay vì giả lập |
| `projectName` | từ C3 | – |

## 4. Năng lực được phác thảo nhưng KHÔNG đưa vào OpenAPI

Các năng lực sau chỉ được phác thảo, không có trong OpenAPI vì chưa có quyết định Product (G8/G9). Phác thảo để làm đầu vào cho decision record, không phải để implement.

| Năng lực | Hướng đề xuất | Lý do chưa đưa vào |
|---|---|---|
| Comments | Collection `task_comments {taskId, projectId, authorId, body, createdAt}`, index `{taskId,_id}`, list keyset | `03_DAILY:30` xếp vào P1/ngoài MVP |
| Worklog | `task_worklogs {taskId, authorId, minutes, note, loggedAt}` | chưa có yêu cầu nghiệp vụ về thời gian |
| Checklist | mảng embedded `steps` (≤ 50) trên Task, ghi qua PATCH | rủi ro tăng kích thước document; cần Product |
| Sprint / velocity / burndown | Domain mới (sprint, membership của task trong sprint) | không có ADR |
| Work Notes | Contract riêng ở module `capture`, thêm `taskId` theo ADR-009 §3; xử lý field FE `kind/body/blocker/nextStep/week` khác schema `work_notes` (`whatDone/howSolved/whyThisWay`) | G9 |
| Weekly report | Product phải chốt gộp vào Work Note (`kind=WEEKLY_SUMMARY`) hay tách entity | FE đang có 2 khái niệm |
| Knowledge approve | module `lifecycle` (`knowledge_proposals`) | G9 |
| Docs | module `ingestion` (`documents`) + permission filter trước khi gửi AI | `AGENTS.md:24` |
| Forms, Development, Automations, AI Copilot | – | không có ADR hay module |

## 5. Yêu cầu test cho mỗi op (khi được implement)

| Op | Unit | Integration (Mongo replica set) | Contract | Security negative |
|---|---|---|---|---|
| list | parse/validate query allowlist, cursor encode/decode | filter + keyset ổn định với dữ liệu trùng `dueDate` | response khớp `Task` schema | project khác → 404; member INACTIVE → 404; org khác → 404; `assigneeId=me` không nhận id từ client |
| create | validate body | key unique khi tạo đồng thời (N tiến trình) | 201 + Location + ETag | replay cùng key → cùng body; khác body → 409 `IDEMPOTENCY_KEY_REUSED` |
| update | allowlist field, `parentId` 1 cấp | CAS với 2 writer đồng thời: chính xác 1 thắng | 428/409 | assignee không phải member → 422 |
| transition | dùng lại test policy D-08 | atomic với event `TASK_STATUS_TRANSITIONED` | 200 + ETag | MEMBER chuyển task người khác → 403 |
| history | page/limit | thứ tự newest-first | schema | cross-project → 404 |
| summary | mốc thời gian UTC | đối chiếu count với dataset seed | schema | cross-project → 404 |
