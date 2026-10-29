# Bàn giao Backend — Knowledge Handover Workflow

- **Checkout (Worktree cô lập)**: `F:/LEARN KÌ 8/ĐATN/DATN_BE-handover-workflow`
- **Branch**: `feat/Thang-knowledge-handover-workflow-be-api`
- **Base `main`**: `a856d9c` (rebased onto latest `origin/main`, bao gồm PR #107 AI Chat BFF và DB PR #106 `f41b57b36a61ad23bd971ef3ec5325caf61f0edc` / `53c906dea77ebc7fc9a196531210400fdcbefc4a`)
- **Push & PR Authorization**: Thang đã chỉ thị rõ ràng `"push lên tạo pr"` và `"xem pr này đúng không, nếu đúng thì fix rồi push lên pr"` ngày `2026-10-29`.
- **Checkout `DATN_BE` gốc (AI Chat)**: giữ nguyên trạng thái, không động chạm.

## 1. Phạm vi thay đổi

1. **Cross-Domain Application Contracts (không truy cập chéo DB)**:
   - `IAM`: `src/services/iam/application/projects/handover-iam-scope.service.ts` (+ `.spec.ts`) phân giải `Leader`/`Coordinator`/`Successor` hiện hành (bao gồm `resolveActiveProjectMemberScope` để nhận diện chính xác khi người kế nhiệm `B` đồng thời là `TEAM_LEADER` — **Review Fix `F06`**), `departingUserId` lịch sử (kể cả đã rời dự án — `A01`, `A02`), và đường khôi phục an toàn cho Org Manager (`canAssignCoordinator` không kế thừa quyền đọc nội dung dự án `PRIVATE` — `A16`).
   - `Capture`: `src/services/capture/application/handover-capture-source.service.ts` xác thực nguồn `PROJECT_DOCUMENT` (`APPROVED`), `WORK_REPORT` (`APPROVED`), `TASK_NOTE` (`CONFIRMED` khi được chọn tường minh, không đưa vào đề xuất AI tự động hay Q&A — `A03`, `A04`).
     - **Review Fix (`F03`)**: khi pin phiên bản cũ (`ref.version`), `TASK_NOTE` chỉ trích xuất `title` và `excerpts` từ đúng bản chụp trong `work_note_versions` (và từ chối fail-closed nếu đã bị sửa tại chỗ mà không có bản chụp lịch sử), còn `WORK_REPORT` từ chối `ref.version !== currentVersion` (`readable: false`) vì collection `work_reports` không lưu snapshot nội dung lịch sử qua các lần duyệt lại — không bao giờ trả nội dung `v2` dưới nhãn `version: 1`.
   - `Lifecycle`: `src/services/lifecycle/application/handover-lifecycle-source.service.ts` xác thực `KNOWLEDGE_OBJECT` (`VERIFIED`) + `knowledge_versions` và trạng thái `sourceStatus` (`CURRENT` vs `UPDATED_SINCE_SNAPSHOT`).
   - `Task`: `src/services/task/workspace/handover-task-assignment.service.ts` (+ `.spec.ts`) thực thi chuyển giao task bền vững, idempotent qua `WORKSPACE_TASK_OPERATIONS_COLLECTION` (`task_operations`, khóa `(actorId, projectId, operationId)`) trong `continuum_task` (`A10`, `A11`), kèm `inspectTasksCurrentState` kiểm tra trạng thái phân công hiện hành.
   - `AI Integration`: mở rộng allowlist JSON route trong `src/integrations/ai-engine/http-ai-engine.client.ts` (`HttpAiEngineClient.request(...)`) cho phép gọi endpoint nội bộ SAG `POST /api/v1/projects/:projectId/handover/assist` bằng `X-SAG-BFF-Service-Token` và scope headers `X-Continuum-*`, tương thích hoàn toàn với AI Chat BFF (`PR #107`).
2. **Handover Workflow Domain & API (`src/services/handover/**` + `GatewayHandoverController`)**:
   - Triển khai đầy đủ 25 paths / 28 operations theo `handover-v1.openapi.yaml` với `ETag`, `If-Match`, `Idempotency-Key`, `Idempotency-Replayed`, `DraftItemDto.contentVersion` (**hỗ trợ `F07`**) và CSRF double-submit guard.
   - **Review Fix (`F01`)**: `evaluateCompletionReadiness` yêu cầu `ev.isCurrent` cho các nguồn của mục bắt buộc (`REQUIRED_ITEM_SOURCE_OUTDATED`) và `evaluateCarriedItemAcceptances` không carry-forward xác nhận hiểu khi nguồn đã cũ (`isCurrent === false`), buộc Leader phát hành bản cập nhật hoặc xử lý ảnh hưởng nguồn mới trước khi complete.
   - **Review Fix (`F02`)**: `HandoverTransferService.reconcileTransfer` đối soát lại cả các child đã `COMMITTED` (ghi `CONFLICT` với `TASK_REASSIGNED_AFTER_DISPATCH` nếu task đã chuyển sang `C` và giữ nguyên `C`), đồng thời `completeHandover` gọi `reverifyCurrentRevisionTransfers` + kiểm tra trạng thái thực tế của toàn bộ `selectedTaskIds` (`SELECTED_TASK_ASSIGNEE_DRIFTED` / `SELECTED_TASK_NOT_FOUND`).
   - **Review Fix (`F04` & `F05`)**: `HandoverAiService` bọc toàn bộ vòng đời background job (bao gồm bước claim và ghi lỗi) bằng `.catch(...)` chống `unhandledRejection`, bổ sung cơ chế phục hồi định kỳ (`OnModuleInit` / `OnModuleDestroy` + nudge khi poll) để reclaim job `PENDING` hoặc `RUNNING` hết hạn lease (`attempt < 3`) với `leaseOwner` riêng và lease-fenced updates, cho phép `retryJob` nhận cả job `RUNNING` hết hạn lease, và giới hạn kích thước `candidateReasonCache`.
   - Chuẩn hóa `trim()` trên `title` và `requirement` trước khi so sánh `hasMeaningfulDraftItemChange` trong `replaceHandoverDraft`.
   - Live ACL fail-closed: khi nguồn mất quyền hoặc không còn hợp lệ, item chuyển sang `availability = UNAVAILABLE` và ẩn toàn bộ `title`, `body`, `requirement`, `citations`, `sources` (`A04`, `A13`).
   - Giữ nguyên hoàn toàn physical DB contract & migration từ PR #106 (`handover-v2.contract.cjs`, `20261028-handover-v2.mjs`).

## 2. Kết quả kiểm tra

- `npm run test:handover-v2:plan`: **PASS (5/5)**
- `npm run test:handover-v2:mongodb`: **PASS (3/3)**
- `npm run test:migrations:plan`: **PASS**
- `npm run check`: **PASS** (`eslint` 0 lỗi, `tsc` 0 lỗi, `role-reconciliation` 15/15, `dev-db-smoke` 25/25, `169` unit suites / `1,567` unit tests pass, `19` active e2e suites / `176` e2e tests pass bao gồm `test/handover-v2.mongodb-e2e-spec.ts` và `test/handover-workflow.mongodb-e2e-spec.ts` chạy trên MongoDB 7.0.24 replica set thật cho toàn bộ `A01–A16` và các ca hồi quy `F01–F07`, `nest build` thành công).

## 3. Tác động DB / Cấu hình / Bảo mật

- **Database**: Không sửa đổi schema, validator, hay migration PR #106 trong `continuum_handover`. Trong `continuum_task`, `HandoverTaskAssignmentService` lưu biên nhận idempotency vào collection nội bộ `task_operations` (`WORKSPACE_TASK_OPERATIONS_COLLECTION`), khóa theo `(actorId, projectId, operationId)` qua `TaskWorkspaceRepository` mà không đổi schema `tasks`. Chưa chạy migration lên DB dùng chung.
- **Environment**: Tái sử dụng `SAG_API_BASE_URL` và `SAG_BFF_SERVICE_TOKEN` hiện có; không thêm biến `.env` bắt buộc mới. Khi SAG không khả dụng, hệ thống fail-closed với `AI_ENGINE_UNAVAILABLE`, `AI_ENGINE_NOT_CONFIGURED` hoặc `AI_ENGINE_REQUEST_FAILED` và bảo toàn luồng soạn/xuất bản thủ công (`P-08`).

## 4. Lệnh kiểm tra / push

```powershell
Set-Location -LiteralPath 'F:\LEARN KÌ 8\ĐATN\DATN_BE-handover-workflow'
git status --short
git log -2 --stat
git push origin feat/Thang-knowledge-handover-workflow-be-api
```
