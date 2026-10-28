# Bàn giao Backend — Knowledge Handover Workflow

- **Checkout (Worktree cô lập)**: `F:/LEARN KÌ 8/ĐATN/DATN_BE-handover-workflow`
- **Branch**: `feat/Thang-knowledge-handover-workflow-be-api`
- **Base `main`**: `a856d9c` (rebased onto latest `origin/main`, bao gồm PR #107 AI Chat BFF và DB PR #106 `f41b57b36a61ad23bd971ef3ec5325caf61f0edc` / `53c906dea77ebc7fc9a196531210400fdcbefc4a`)
- **Push & PR Authorization**: Thang đã chỉ thị rõ ràng `"push lên tạo pr"` ngày `2026-10-29`.
- **Checkout `DATN_BE` gốc (AI Chat)**: giữ nguyên trạng thái, không động chạm.

## 1. Phạm vi thay đổi

1. **Cross-Domain Application Contracts (không truy cập chéo DB)**:
   - `IAM`: `src/services/iam/application/projects/handover-iam-scope.service.ts` (+ `.spec.ts`) phân giải `Leader`/`Coordinator`/`Successor` hiện hành, `departingUserId` lịch sử (kể cả đã rời dự án — `A01`, `A02`), và đường khôi phục an toàn cho Org Manager (`canAssignCoordinator` không kế thừa quyền đọc nội dung dự án `PRIVATE` — `A16`).
   - `Capture`: `src/services/capture/application/handover-capture-source.service.ts` xác thực nguồn `PROJECT_DOCUMENT` (`APPROVED`), `WORK_REPORT` (`SUBMITTED | REVIEWED`), `TASK_NOTE` (`CONFIRMED` khi được chọn tường minh, không đưa vào đề xuất AI tự động hay Q&A — `A03`, `A04`).
   - `Lifecycle`: `src/services/lifecycle/application/handover-lifecycle-source.service.ts` xác thực `KNOWLEDGE_OBJECT` (`APPROVED | VERIFIED`) + `knowledge_versions` và trạng thái `sourceStatus` (`CURRENT` vs `UPDATED_SINCE_SNAPSHOT`).
   - `Task`: `src/services/task/workspace/handover-task-assignment.service.ts` (+ `.spec.ts`) thực thi chuyển giao task bền vững, idempotent theo `operationId` với bảng đối soát `handover_assignment_operations` trong `continuum_task` (`A10`, `A11`).
   - `AI Integration`: mở rộng `src/integrations/ai-engine/{ai-engine.module.ts,http-ai-engine.client.ts,http-ai-engine.client.spec.ts}` gọi endpoint nội bộ SAG `POST /api/v1/projects/{projectId}/handover/assist` bằng `X-SAG-BFF-Service-Token` và scope headers `X-Continuum-*`, tương thích hoàn toàn với AI Chat BFF (`PR #107`).
2. **Handover Workflow Domain & API (`src/services/handover/**` + `GatewayHandoverController`)**:
   - Triển khai đầy đủ 25 paths / 28 operations theo `handover-v1.openapi.yaml` với `ETag`, `If-Match`, `Idempotency-Key`, `Idempotency-Replayed` và CSRF double-submit guard.
   - Bất biến snapshot khi publish, impact map carry-forward đúng provenance, binding `(successorUserId, assignmentVersion, revisionId, contentVersion, contentFingerprint)` (`A05`, `A06`), HTTPS-only evidence + Leader review (`A09`), optional gap exception + post-completion follow-up độc lập (`A08`, `A15`), fence chặn complete khi còn transfer `PENDING | UNKNOWN`, cancel giữ nguyên lịch sử (`A14`), và stale AI job `SUPERSEDED` + manual fallback (`A12`, `P-08`).
   - Live ACL fail-closed: khi nguồn mất quyền hoặc không còn hợp lệ, item chuyển sang `availability = UNAVAILABLE` và ẩn toàn bộ `title`, `body`, `requirement`, `citations`, `sources` (`A04`, `A13`).
   - Giữ nguyên hoàn toàn physical DB contract & migration từ PR #106 (`handover-v2.contract.cjs`, `20261028-handover-v2.mjs`).

## 2. Kết quả kiểm tra

- `npm run test:handover-v2:plan`: **PASS (5/5)**
- `npm run test:handover-v2:mongodb`: **PASS (3/3)**
- `npm run test:migrations:plan`: **PASS**
- `npm run check`: **PASS** (`eslint` 0 lỗi, `tsc` 0 lỗi, `role-reconciliation` 15/15, `dev-db-smoke` 25/25, `165` unit suites / `1,544` unit tests pass, `18` e2e suites / `173` e2e tests pass bao gồm `test/handover-v2.mongodb-e2e-spec.ts` và `test/handover-workflow.mongodb-e2e-spec.ts` chạy trên MongoDB 7.0.24 replica set thật cho toàn bộ `A01–A16`, `nest build` thành công).

## 3. Tác động DB / Cấu hình / Bảo mật

- **Database**: Không sửa đổi schema, validator, hay migration PR #106 trong `continuum_handover`. Trong `continuum_task`, `HandoverTaskAssignmentService` lưu biên nhận idempotency vào collection nội bộ `handover_assignment_operations` có index unique `(organizationId, projectId, operationId)` được đảm bảo tự động qua `TaskWorkspaceRepository` mà không đổi schema `tasks`. Chưa chạy migration lên DB dùng chung.
- **Environment**: Tái sử dụng `SAG_API_BASE_URL` và `SAG_BFF_SERVICE_TOKEN` hiện có; không thêm biến `.env` bắt buộc mới.

## 4. Lệnh push cho Thang

```powershell
Set-Location -LiteralPath 'F:\LEARN KÌ 8\ĐATN\DATN_BE-handover-workflow'
git status --short
git log -1 --stat
git push -u origin feat/Thang-knowledge-handover-workflow-be-api
```

