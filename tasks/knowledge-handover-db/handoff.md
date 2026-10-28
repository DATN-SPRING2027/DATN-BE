# Bàn giao DB — Knowledge Handover

Checkout: `F:/LEARN KÌ 8/ĐATN/DATN_BE-handover-db`.
Branch: `feat/Thang-knowledge-handover-db`.
Base: `2325a8e1f567fbb7276b57f14cd05c9ffe08bc5e` từ main đã fetch/pull ff-only.
Thang subsequently authorized commit, push and PR creation explicitly on
2026-10-28: “push lên tạo pr cho tôi”. The earlier manual handoff below records
the prepared commands; current commit/PR results are reported in the chat.

## Các phần đã làm

- Physical contract V2 cho 9 collection, 18 index; giữ schema/model legacy riêng.
- Migration mới `20261028-handover-v2.mjs`: dry-run, inventory, preflight,
  reviewed hash, paused-writer guard, additive apply và hậu kiểm.
- Tests schema, planner, MongoDB 7 cô lập và Mongoose serialization thật.
- Hướng dẫn migration/rollback, task record và PR description.
- Đồng bộ checklist trong Document và câu trả lời đã xác nhận trong hồ sơ phỏng vấn.

File thay đổi thuộc `package.json`, Handover infrastructure/MongoDB,
`scripts/migrations/*handover-v2*`, một test MongoDB e2e và thư mục task này.
BE application/FE/SAG chưa được triển khai vì Thang chọn chờ DB PR human merge.
Không sửa các thay đổi AI Chat đang nằm ở checkout BE gốc hoặc worktree khác.

## Lệnh tiếp theo cho Thang

Review diff và các file mới trước khi stage. Các lệnh dưới đây được chuẩn bị để
Thang chạy; AI chưa thực hiện commit/push:

```powershell
Set-Location -LiteralPath 'F:\LEARN KÌ 8\ĐATN\DATN_BE-handover-db'
git diff --check
git diff
git status --short
git add -- package.json src/services/handover/infrastructure scripts/migrations/20261028-handover-v2.mjs scripts/migrations/20261028-handover-v2.README.md scripts/migrations/handover-v2.plan.mjs scripts/migrations/handover-v2.plan.test.mjs scripts/migrations/handover-v2.mongodb.test.mjs test/handover-v2.mongodb-e2e-spec.ts tasks/knowledge-handover-db
git diff --cached --stat
git diff --cached
git commit -m "feat(handover): add versioned handover database contract"
git push -u origin feat/Thang-knowledge-handover-db
```

Sau khi push, tạo PR vào `main` bằng nội dung trong `pr-description.md`;
chờ người có quyền review/CI và merge. Chưa có PR URL để cung cấp.
Không chạy migration lên DB dùng chung chỉ vì PR được tạo/merge; làm theo
`scripts/migrations/20261028-handover-v2.README.md` và quy trình môi trường.

## Impact và các gate còn lại

Không thay `.env`, quyền IAM hoặc dependency versions; chưa áp dụng DB dùng
chung. Migration có thêm biến môi trường riêng cho người vận hành.
Rollback quiesce writers và giữ dữ liệu/index/validator; không xóa lịch sử.

Sau DB merge: fetch/update main, tạo các nhánh BE/FE/SAG mới theo workflow,
triển khai API/ACL, Task command và reconciliation, AI source/generation/jobs,
rồi FE và visual QA với BE thật. Tính năng toàn phần chưa hoàn tất ở gate DB.

Kết quả kiểm tra và giới hạn bằng chứng được ghi trong `todo.md`.
