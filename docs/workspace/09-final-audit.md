# 09 — Final Audit: Workspace FE ↔ BE

| | |
|---|---|
| FE | `DATN-FE` PR #69 @ `80a324ffac9cbb1e1b45e0a34d44c9c6ef508046` |
| BE | `DATN-BE` @ `5e3bf8d` → branch `feat/Thang-workspace-api-audit-be-api` |
| Document | `main` @ `1635238` (doc 27 chỉ có trên branch `origin/docs/Phuc-DATN-97-d05-decision-record`) |
| Ngày | 2026-10-22 |

## 1. Kết luận một câu

UI Workspace của PR #69 là **giao diện hoàn chỉnh nhưng hiện đang chạy trên mock data** vì `src/services/task/**` ở BE đang ở trạng thái **dormant** theo `DATN_BE/AGENTS.md:7-12,22`. Trong đợt audit này, chúng ta đã kiểm kê toàn bộ FE/BE, đo kiểm hiệu năng thực tế trên MongoDB, thiết kế bộ OpenAPI 3.1.0 gồm **17 operations**, và **chốt toàn bộ quyết định nghiệp vụ & kiến trúc (G1, G4, G6, G7, G8, G10) cùng Thắng** để sẵn sàng bước vào giai đoạn mở khóa dormant và implement (Phase 8).

## 2. Bức tranh hiện tại

| Khía cạnh | Thực tế |
|---|---|
| View chức năng | 11 view: 10 tab + Issue Detail. Tất cả hiển thị dữ liệu mock |
| API thật FE đang dùng trong Work | 3: `GET /auth/me`, `GET /iam/projects`, `GET /iam/projects/{id}` |
| Capability có FE consumer | 40: 4 MATCHED · 4 PARTIAL · 3 INCOMPATIBLE · 8 BLOCKED_DECISION · 21 MISSING ([02](02-fe-be-api-matrix.md) §2) |
| Màn hình Manager (yêu cầu nghiệp vụ 2026-10-22) | 6 chức năng M1–M6, **không** nằm trong mẫu số 40 vì FE chưa có màn hình này ([02](02-fe-be-api-matrix.md) §1.6) |
| Mô hình vận hành (đã chốt) | Mỗi Project là một workspace task gắn vĩnh viễn với Organization nơi tạo; Leader (`TEAM_LEADER`) vận hành chính và quản lý Sprint; Manager (`ADMIN`) có màn hình toàn org và xem/tạo/sửa task ở mọi project (kể cả `PRIVATE`); Member (`MEMBER`) tạo task và sửa task mình tạo hoặc được giao |
| Task backend | Đã có schema 9 field, 5 index, repository, lifecycle policy (D-08), history (D-09) và 3 controller **dormant** (loopback, DenyAll) |
| Source of truth | **Native Continuum Task** (ADR-009). Jira module chỉ có scaffold, không có OAuth/webhook/sync |
| Work Notes, Knowledge, Docs, Handover, Notification | Module chỉ có endpoint health và schema scaffold; không có business route |

## 3. Bảng tổng hợp các Gate đã được Thắng chốt ngày 2026-10-22

| Gate | Câu hỏi | Quyết định đã chốt (2026-10-22) | Bước kỹ thuật tiếp theo |
|---|---|---|---|
| **G1** Runtime owner | Ai sở hữu vận hành `continuum_task` và workflow migration/seed? | **Đã chốt:** **Thắng (Leader)** là accountable runtime owner cho `continuum_task`. | Ghi vào decision record và cập nhật `DATN_BE/AGENTS.md` (bước `D0`). |
| **G2** Approve contract | Approve [04-api-inventory.yaml](04-api-inventory.yaml)? | **Sẵn sàng duyệt:** 17 operations (7 Task core, 4 Comments/Worklogs, 4 Project Sprints, 2 Manager Org Overview). | Đổi `x-approval-status` sang `APPROVED` khi mở khóa `D0`. |
| **G3** DR-3 trust | Gateway→Task tin context như thế nào? | Dùng EdDSA signed context từ Gateway sang Task (đã có prototype ở `src/services/task/runtime/prototypes/**`). | Wire vào Gateway & Task runtime ở bước `BE-1`/`BE-2`. |
| **G4** Phân quyền & DR-8 scope evidence | Ai được xem/tạo/sửa task và lấy membership từ đâu? | **Đã chốt:** Manager (`ADMIN`) xem/tạo/sửa mọi project (kể cả `PRIVATE`); Leader (`TEAM_LEADER`) vận hành project + sprint; Member (`MEMBER`) tạo task và sửa task mình tạo/được giao. Gateway truyền signed scope evidence. | Implement policy ALLOW ở `BE-1`. |
| **G5** DR-7(c)(d) | Điều kiện create task | **Đã chốt:** ADMIN, TEAM_LEADER, MEMBER đều được tạo task với `Idempotency-Key`. | Implement ở `BE-3`. |
| **G6** Schema & Collections | Mở rộng `tasks` và thêm collection mới? | **Đã chốt:** Mở rộng `tasks` + thêm `task_counters`, `task_comments`, `task_worklogs`, `project_sprints` kèm bộ index không partial ([07](07-performance-analysis.md) §9). | Tạo migration mới ở `DB-1`. |
| **G7** Status enum & Delete | Xử lý `IN_REVIEW` và nút Delete task? | **Đã chốt:** (1) Thêm `IN_REVIEW` vào BE enum (`TODO`, `IN_PROGRESS`, `IN_REVIEW`, `BLOCKED`, `DONE`, `CANCELLED`); cả assignee, Leader, Manager đều được chuyển thẳng sang `DONE` hoặc qua `IN_REVIEW`. (2) Delete trên UI = chuyển sang `CANCELLED` kèm `reason` ≥ 5 ký tự (giữ audit). | Cập nhật `task-lifecycle-policy.ts` ở `BE-4`. |
| **G8** Phạm vi tính năng mở rộng | Có làm labels, checklist, comments, worklog, sprint? | **Đã chốt:** Đưa cả 5 tính năng (`labels`, `steps`, `comments`, `worklogs`, `project_sprints`) vào phạm vi triển khai. Mỗi Sprint thuộc 1 Project, do Leader/Manager tạo và đóng. | Implement ở `DB-1`, `BE-5`, `BE-6`, `BE-7`. |
| **G9** Work Notes / Docs / Forms / Dev | Các module phụ ngoài Task | Tách sang pha sau (module `capture`, `lifecycle`, `ingestion`). | Giữ rõ trạng thái ngoài phạm vi đợt 1. |
| **G10** Truy vấn toàn org cho Manager | Lưu `organizationId` trên task hay truyền `projectIds`? | **Đã chốt Phương án A:** Lưu `organizationId` bất biến trên mỗi document `tasks` (lấy từ trusted context lúc tạo) + 4 compound index tiền tố `organizationId`. Xác nhận Project gắn vĩnh viễn với Organization nơi nó được tạo. | Đưa vào migration `DB-1` và dùng ở `BE-8`. |

## 4. Phát hiện ngoài phạm vi (cần task riêng)

| # | Phát hiện | Mức | Evidence |
|---|---|---|---|
| F1 | Mutation Project (PATCH project, visibility, members, leaders) **không kiểm tra CSRF**, khác với các command controller IAM. `SameSite=Lax` giảm rủi ro nhưng không thay thế được defense-in-depth | **Medium** | `project-access.controller.ts:159-372` (không có `validCsrfPair`); so sánh `organization-membership-command.controller.ts:402` |
| F2 | Mâu thuẫn tài liệu: `AGENTS.md:9` nói create handler phải "chờ DR-7(c)(d)", nhưng PR #70 (`8ba2ace`) đã thêm `TaskCreateController` dormant | Low (vẫn dormant và DenyAll) | `src/services/task/http/task-create.controller.ts:28-61` |
| F3 | Doc 27 chưa có trên `main` của Document repo; doc 28 không tồn tại; ADR-003, DEC-013, DEC-018, DEC-019 chỉ được trích dẫn, không có file trong workspace | Low (truy vết governance) | `AGENTDB.md:9`; doc 24:64 |
| F4 | Helper escape regex bị lặp private 3 lần trong IAM | Low | `platform-administration.repository.ts:243`; `project-access.repository.ts:101,336` |
| F5 | Schema `work_notes` dùng `jiraIssueKey` và thiếu `taskId`, mâu thuẫn ADR-009 | Medium (khi làm Work Notes) | `capture/infrastructure/mongodb/mongodb.schemas.ts:40-143` |
| F6 | FE: 11 nhóm defect UI (nút chết, menu nối sai, metric sai nghĩa, "Assign to me" sai người, delete không confirm) | Low–Medium | [01](01-fe-ui-inventory.md) §7 |

## 5. Đánh giá chất lượng

Phần đánh giá này áp dụng cho **sản phẩm của đợt này** (tài liệu, contract, benchmark) và cho **thiết kế đề xuất**. Không có code runtime mới.

| Tiêu chí | Đánh giá |
|---|---|
| Correctness | Contract kế thừa policy D-08 (mở rộng `IN_REVIEW` và soft-cancel `CANCELLED` theo quyết định G7). Mọi claim đều có `path:line` |
| Maintainability | 17 op có cấu trúc nhất quán; Board, Calendar và Timeline dùng chung list. Không có interface một-implementation, không thêm module mới |
| Security | 404 cho cross-scope; `{_id, projectId}` cho mọi lookup; `organizationId` bất biến từ session; `assigneeId=me` resolve ở server; CSRF, CAS và Idempotency theo mẫu IAM/Team; escape `q` + `maxTimeMS` |
| Performance | Quyết định index dựa trên số đo: calendar tier L từ 299.5 xuống 3.5 ms; subtask batched từ 209.8 xuống 1.4 ms; filter assignee 1.560 xuống 51 keys. Phát hiện và loại bỏ partial index không dùng được |
| Duplication | Không tạo database task thứ hai; không tạo endpoint theo view; tái dùng `task_operations` cho idempotency thay vì thêm Redis |
| Contract consistency | Giữ error shape, keyset D-05, ETag format của Team, `no-store`; OpenAPI 3.1.0 pass Redocly |
| Testability | Mỗi op có ma trận test unit/integration/contract/negative ([03](03-api-contract-design.md) §5); safety guard của benchmark có test |
| Architectural fit | Đúng ADR-009/010, D-08/D-09 và lộ trình mở khóa dormant trong `AGENTS.md` |

## 6. Rủi ro còn lại

1. **Toàn bộ Workspace trên PR #69 hiện vẫn là mock** cho tới khi các PR từ `DB-1` đến `FE-5` trong [06-implementation-plan.md](06-implementation-plan.md) được thực thi và merge.
2. Benchmark chạy trên MongoDB 8.2.3 standalone, không phải 7.0 replica set. Số tuyệt đối cần xác nhận lại; số keys/docs examined thì có giá trị.
3. Chưa có số đo HTTP end-to-end (vì Task service đang dormant).
4. Các tab ngoài phạm vi Task (`Docs`, `Forms`, `Development`, `Work Notes`, `AI Copilot`) thuộc gate G9 sẽ cần ẩn hoặc hiển thị trạng thái "Not available yet" ở bước `FE-4` để không đánh lừa người dùng.
