# 09 — Final Audit: Workspace FE ↔ BE

| | |
|---|---|
| FE | `DATN-FE` PR #69 @ `80a324ffac9cbb1e1b45e0a34d44c9c6ef508046` |
| BE | `DATN-BE` @ `5e3bf8d` → branch `feat/Thang-workspace-api-audit-be-api` |
| Document | `main` @ `1635238` (doc 27 chỉ có trên branch `origin/docs/Phuc-DATN-97-d05-decision-record`) |
| Ngày | 2026-10-22 |

## 1. Kết luận một câu

UI Workspace của PR #69 là **giao diện hoàn chỉnh nhưng chưa có backend**. Lý do không chỉ là thiếu code: repository **chủ động cấm** expose Task API cho tới khi có quyết định Architecture/Product/Security được ghi nhận. Vì vậy đợt này hoàn thành audit, contract đề xuất, kiến trúc và bằng chứng hiệu năng, nhưng **không implement API**. Đây là kết quả đúng theo governance, không phải kết quả bỏ dở.

## 2. Bức tranh hiện tại

| Khía cạnh | Thực tế |
|---|---|
| View chức năng | 11 view: 10 tab + Issue Detail. Tất cả hiển thị dữ liệu mock |
| API thật FE đang dùng trong Work | 3: `GET /auth/me`, `GET /iam/projects`, `GET /iam/projects/{id}` |
| Capability có FE consumer | 40: 4 MATCHED · 4 PARTIAL · 3 INCOMPATIBLE · 8 BLOCKED_DECISION · 21 MISSING ([02](02-fe-be-api-matrix.md) §2) |
| Task backend | Đã có schema 9 field, 5 index, repository, lifecycle policy (D-08), history (D-09) và 3 controller **dormant** (loopback, DenyAll) |
| Source of truth | **Native Continuum Task** (ADR-009). Jira module chỉ có scaffold, không có OAuth/webhook/sync |
| Work Notes, Knowledge, Docs, Handover, Notification | Module chỉ có endpoint health và schema scaffold; không có business route |

## 3. BLOCKED_DECISION: phương án và hệ quả

| Gate | Câu hỏi | Phương án A (khuyến nghị) | Phương án B | Hệ quả nếu không quyết |
|---|---|---|---|---|
| **G1** Runtime owner | Ai sở hữu vận hành `continuum_task` và workflow migration/seed? | Chỉ định một người (ví dụ Danh, người viết D-04/D-05) làm runtime owner. Dùng pattern migration có sẵn (`20261019-task-lifecycle-contract.mjs`) | Tạm chạy Task trong monolith (`AppModule`). **Trái** ADR-010 và AGENTS.md | Không thể activate Task |
| **G2** Approve contract | Approve [04-api-inventory.yaml](04-api-inventory.yaml)? | Approve 7 op tối thiểu, mỗi op một decision record | Chỉ approve read (list/detail mở rộng + summary) trước, mutation sau | Không được implement (`AGENTS.md:22`) |
| **G3** DR-3 trust | Gateway→Task tin context như thế nào? | Giai đoạn đầu: Task chạy cùng network nội bộ, Gateway ký context bằng EdDSA (đã có prototype ở `runtime/prototypes/**`), Task verify + chống replay | mTLS đầy đủ | DenyAll giữ nguyên |
| **G4** DR-8 scope evidence | Task lấy ACTIVE org/project membership từ đâu? | Gateway gửi kèm evidence đã ký; Task không truy vấn chéo DB IAM | Task gọi IAM `/internal` mỗi request: thêm latency và phụ thuộc | DenyAll giữ nguyên |
| **G5** DR-7(c)(d) | Điều kiện create | Theo slice proposal hiện có | – | Không có create |
| **G6** Schema | Mở rộng field + 5 index ([07](07-performance-analysis.md) §9) | Migration mới, có dry-run SHA và rollback | Giữ 7 field: FE chỉ hiển thị được title | View không có dữ liệu ý nghĩa |
| **G7** Status enum | FE `IN_REVIEW` khác BE `BLOCKED`/`CANCELLED`; delete? | Giữ enum BE (đã approve D-08); FE đổi cột "In Review" thành "Blocked"; delete = `CANCELLED` có reason | Thêm `IN_REVIEW` vào BE: phải sửa policy D-08 + migration + decision record mới | Board không map được |
| **G8** Phạm vi MVP | comments, worklog, checklist, sprint, labels | MVP gồm labels; comments/worklog/checklist/sprint để P2 | Đưa comments vào MVP (collection riêng) | FE phải ẩn tính năng |
| **G9** Work Notes | Contract capture khác FE và thiếu `taskId` | Viết contract Work Notes mới theo ADR-009 §3 (`taskId`), thống nhất `kind/body/blocker/nextStep` | Giữ schema capture hiện tại và đổi FE theo | Work Notes vẫn mock |

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
| Correctness | Contract tái sử dụng nguyên văn policy D-08 đã approve (transition, reason, actor) thay vì viết lại. Mọi claim đều có `path:line` |
| Maintainability | 7 op trên 5 resource; Board, Calendar và Timeline dùng chung list. Không có interface một-implementation, không thêm module mới |
| Security | 404 cho cross-scope; `{_id, projectId}` cho mọi lookup; `assigneeId=me` resolve ở server; CSRF, CAS và Idempotency theo mẫu IAM/Team; escape `q` + `maxTimeMS` |
| Performance | Quyết định index dựa trên số đo: calendar tier L từ 299.5 xuống 3.5 ms; subtask batched từ 209.8 xuống 1.4 ms; filter assignee 1.560 xuống 51 keys. Phát hiện và loại bỏ partial index không dùng được |
| Duplication | Không tạo database task thứ hai; không tạo endpoint theo view; tái dùng `task_operations` cho idempotency thay vì thêm Redis |
| Contract consistency | Giữ error shape, keyset D-05, ETag format của Team, `no-store`; OpenAPI pass Redocly |
| Testability | Mỗi op có ma trận test unit/integration/contract/negative ([03](03-api-contract-design.md) §5); safety guard của benchmark có test |
| Architectural fit | Đúng ADR-009/010, D-08/D-09 và các ràng buộc dormant trong `AGENTS.md` |

## 6. Rủi ro còn lại

1. **Toàn bộ Workspace vẫn là mock.** Người dùng có thể nhầm là tính năng đã chạy, dù UI có nhãn "Preview data".
2. Benchmark chạy trên MongoDB 8.2.3 standalone, không phải 7.0 replica set. Số tuyệt đối cần xác nhận lại; số keys/docs examined thì có giá trị.
3. Chưa có số đo HTTP end-to-end.
4. Lộ trình ở [06](06-implementation-plan.md) giả định G1–G7 được quyết theo phương án A. Nếu chọn B, ước lượng sẽ thay đổi.
5. Nếu Product giữ toàn bộ tính năng trên UI (Development, Forms, Docs, AI, Sprint), phạm vi backend lớn hơn nhiều so với ước lượng P0/P1.
