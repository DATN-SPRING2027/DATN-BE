# 08 — Test Results

Mọi kết quả dưới đây là output thật của các lệnh đã chạy. Log gốc nằm trong artifact của cuộc audit (`scratch/baseline/*.log`).

## 1. Baseline trước khi thay đổi

### 1.1 Backend: `DATN_BE` @ `5e3bf8d` (origin/main, branch `feat/Thang-workspace-api-audit-be-api`)

| Lệnh | Kết quả |
|---|---|
| `npm ci --no-audit --no-fund` | exit 0 |
| `npm run lint` | exit 0, 0 problem |
| `npm run typecheck` | exit 0 |
| `npx jest --runInBand` | exit 0. **Test Suites:** 130 passed, 14 skipped (144). **Tests:** 1306 passed, 135 skipped (1441). Thời gian 77.95 s |
| `npm run build` | exit 0 |

14 suite bị skip là các spec `*.mongodb.spec.ts`. Chúng cần `MONGODB_INTEGRATION=true` và một MongoDB 7 replica set; CI chạy chúng bằng `mongo:7.0 --replSet rs0` (`.github/workflows/ci.yml:95-173`). Đây là trạng thái có sẵn, không phải lỗi mới.

Ghi chú tiền điều kiện: `package-lock.json` bị sửa sẵn trên `main` từ trước. Thay đổi này **đã được giữ nguyên** trong `stash@{0}` ("pre-existing package-lock.json change (preserved before workspace audit 2026-10-22)") và chưa được pop.

### 1.2 Frontend: `DATN_FE` @ `80a324f` (PR #69)

| Lệnh | Kết quả |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run` | exit 0. **Test Files:** 99 passed (99). **Tests:** 716 passed (716). Thời gian 33.96 s |
| `next build` | **không chạy** ở baseline: dev server `next dev` đang dùng chung thư mục `.next`, và build song song từng làm hỏng cache dev (đã xảy ra trước đó trong phiên). Build FE đã pass ở các PR trước (#68). Không có thay đổi FE nào trong đợt này |

## 2. Kiểm chứng trong đợt này

| Hạng mục | Lệnh | Kết quả |
|---|---|---|
| OpenAPI hợp lệ | `npx @redocly/cli@1 lint docs/workspace/04-api-inventory.yaml --skip-rule no-empty-servers` | **valid**, 0 error / 0 warning. Skip `no-empty-servers` có chủ đích: `docs/openapi/README.md` quy định không ghi `servers` |
| Safety guard của benchmark | `node --test scripts/perf/workspace-query-plans.test.mjs` | 2 pass / 0 fail (từ chối `mongodb+srv://` và host không phải loopback **trước khi** connect) |
| Format | `npx prettier --check scripts/perf/*.mjs` | All matched files use Prettier code style |
| Benchmark query plan | `node scripts/perf/workspace-query-plans.mjs --iterations 20` | exit 0; kết quả ở [07](07-performance-analysis.md); DB scratch đã bị drop (kiểm tra `listDatabases`: không còn) |
| BE quality gate sau thay đổi | `npm run check` (lint + typecheck + 2 node:test + jest + e2e + build) | xem §3 |

## 3. Quality gate sau thay đổi

`npm run check` trên branch `feat/Thang-workspace-api-audit-be-api` (sau khi thêm `docs/workspace/**` và `scripts/perf/**`) cho **exit 0**.

| Bước | Kết quả |
|---|---|
| `eslint "{src,test}/**/*.ts"` | pass |
| `tsc --noEmit` | pass |
| `test:organization-role-reconciliation` | pass |
| `test:dev-db-smoke-safety` | pass |
| `jest --runInBand` | **Test Suites:** 130 passed, 14 skipped (144). **Tests:** 1306 passed, 135 skipped (1441). 51.0 s. **Giống hệt baseline** |
| `jest --config ./test/jest-e2e.json` | **Test Suites:** 14 passed, 2 skipped (16). **Tests:** 82 passed, 4 skipped (86). 34.9 s |
| `nest build` | pass |

Các dòng log `ERROR [TaskCreateService] … INVALID_TRUSTED_CONTEXT` và `WARN [GoogleOAuth] …` trong output jest là log do test cố ý tạo ra trong kịch bản negative. Chúng không phải lỗi.

Không có regression: src không bị thay đổi, nên đây là kết quả kỳ vọng.

**Bổ sung sau yêu cầu Manager (2026-10-22):** sau khi chạy `npm run check` ở trên, tôi thêm `scripts/perf/workspace-org-queries.mjs`, cập nhật các tài liệu và mở rộng test an toàn. `npm run check` **không chạy lại**, vì các thay đổi này chỉ nằm trong `docs/workspace/**` và `scripts/perf/**`, nằm ngoài phạm vi lint của check (`eslint "{src,test}/**/*.ts"`) và không import vào `src`. Các kiểm tra liên quan đã chạy riêng:

| Lệnh | Kết quả |
|---|---|
| `node --test scripts/perf/workspace-query-plans.test.mjs` (4 test: 2 script × 2 trường hợp từ chối URI) | **4 pass / 0 fail**. Kiểm tra `listDatabases`: không còn database `datn_workspace*` nào |
| `npx @redocly/cli@1 lint docs/workspace/04-api-inventory.yaml --skip-rule no-empty-servers` (17 operations, `0.3.0-proposal`) | valid, 0 error / 0 warning |
| `node scripts/perf/workspace-org-queries.mjs --iterations 20` | exit 0, kết quả ở [07 §12](07-performance-analysis.md); DB scratch tự drop |

## 4. Những gì CHƯA được kiểm chứng (và lý do)

| Hạng mục Phase 9 | Trạng thái | Lý do |
|---|---|---|
| Unit/integration/contract test cho Task API mới | **Không có** | Không có API nào được implement (BLOCKED, xem 06 §1) |
| Negative security test (cross-project/org, IDOR, CSRF) | **Không có** cho API mới | như trên. Test sẵn có của IAM vẫn pass trong jest |
| Contract test FE↔BE | **Không có** | FE không gọi Task API |
| Browser E2E (Playwright) cho workspace thật | **Không có** | Mọi view vẫn chạy mock. Một phép E2E lúc này chỉ xác nhận lại hành vi mock, không chứng minh được tích hợp |
| Load test HTTP (k6) | **Không có** | Không có endpoint. Chỉ có benchmark tầng DB |
| Integration test MongoDB replica set | **Không chạy** cục bộ | mongod local là standalone 8.2.3. CI có replica set 7.0 |

Không có mục nào ở trên được báo cáo là "pass".
