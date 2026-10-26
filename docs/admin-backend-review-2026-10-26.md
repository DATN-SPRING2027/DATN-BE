# Rà soát toàn bộ backend Admin — 2026-10-26

## Kết luận

**Chưa hoàn thành đầy đủ và đúng toàn bộ danh sách yêu cầu.** Ba nhóm còn vấn
đề là Người dùng, Membership và Vận hành. Bảy nhóm còn lại đã có implementation
phù hợp hợp đồng hiện tại và không phát hiện thêm lỗi chặn chức năng trong phạm
vi kiểm tra; đây không phải chứng nhận mọi tình huống runtime đều đã được chứng
minh.

Phạm vi kiểm tra: checkout DATN-BE tại `0e6290a`, nhánh
`codex/platform-session-security`, bao gồm các thay đổi local session/rate limit
chưa commit từ hai lượt trước. Không đánh đồng trạng thái này với main trên
GitHub. Lượt này không sửa logic nghiệp vụ, không chỉnh frontend, không truy cập
database dùng thực tế, không gửi email hay thao tác job/integration thật.

## Phát hiện cần xử lý

### F1 — P1: Runtime bỏ qua readiness của lời mời bằng giá trị true cố định

- `src/services/iam/iam.module.ts:238` gắn
  `ConfiguredOrganizationInvitationReadiness` vào runtime.
- `src/services/iam/application/organizations/organization-invitation-readiness.ts:31`
  luôn trả true và không đọc gate, cấu hình hay bằng chứng readiness.
- `docs/platform-membership-backend.md:60` ghi quyết định fail-closed và cấm thay
  readiness evidence bằng hardcoded true. OpenAPI cũng yêu cầu A7/A8 sẵn sàng.

Ảnh hưởng: invite/resend/cancel Platform có thể đi qua readiness dù chưa có bằng
chứng của notification/cutover; adapter dùng chung còn liên quan acceptance và
bằng chứng xử lý quyền legacy/orphan. Việc có SMTP worker không chứng minh mọi
gate này đã được đáp ứng. Test truyền fake readiness false chỉ kiểm tra service
branch, không phát hiện production DI đang bind adapter luôn true.

Cần sửa: adapter phải cung cấp bằng chứng theo từng gate; khi không có evidence
thì đóng thao tác theo 503 contract. Bổ sung test kiểm tra runtime wiring thay vì
chỉ mock readiness ở application tests. Không tự gỡ gate để làm API có vẻ chạy.

### F2 — P2: Chi tiết user báo sai quyền PLATFORM có hiệu lực

- `src/services/iam/infrastructure/mongodb/platform-administration.repository.ts:1133`
  không lấy `grantedBy`; vòng đếm assignment hợp lệ ở dòng 1147 cũng không đối
  chiếu người cấp và trạng thái account.
- `mapEffectivePermission` ở dòng 2304 chỉ xét assignment status/thời gian/
  uniqueness; không loại self-grant hoặc user SUSPENDED.
- Policy thực ở `src/services/iam/application/authorization/authorization.policy.ts:210`
  lại yêu cầu account ACTIVE và người cấp khác subject.

Đã tái hiện bằng real Mongo repository trên replica set tạm, dùng bản sao test
fixture và xóa sau khi chạy:

1. Đổi grantedBy của assignment `platform.health.read` thành chính subject.
2. Giữ assignment hợp lệ nhưng chuyển account subject sang SUSPENDED.

Cả hai ca mong `effective: false` nhưng nhận `true`. Log tái hiện:
`/tmp/datn-admin-audit-repro.log` (2 ca fail). Đây là sai metadata/quyền hiển thị,
**không phải bằng chứng vượt qua authorization guard**; guard vẫn deny đúng.

Cần sửa: dùng cùng semantics với AuthorizationPolicy để tính effective, bao gồm
subject status, issuer hợp lệ, non-self grant, ambiguity và thời hạn. Thêm hai
regression tests vào suite chính sau khi sửa.

### F3 — P1 theo yêu cầu chức năng: Test/reconnect integration chưa có provider thật

`src/services/jira/jira.module.ts:25` vẫn bind
`UnavailableJiraPlatformIntegrationOperationsProvider`. Adapter ở
`src/services/jira/infrastructure/unavailable-platform-integration-operations.provider.ts`
trả `JIRA_INTEGRATION_PROVIDER_UNAVAILABLE`. IAM chuyển thành safe 503.

Có route, validation, permission, CSRF và chữ ký owner-to-owner; chưa có credential
decryptor/provider client để test/reconnect Jira thực. Đây là phần chưa triển
khai, không được tính hoàn tất chỉ vì route/HTTP fixture trả 200 khi mock provider.

Cần hợp đồng credential/key ownership, OAuth/API-token reconnect flow,
idempotency/audit và provider adapter được chốt. Người dùng đã xác nhận chưa có
nhánh/tài liệu này ở lượt trước và yêu cầu ghi rõ phần còn thiếu.

### F4 — P2: “Xem hoạt động AI” hiện chỉ là health/readiness

`src/services/iam/infrastructure/platform/platform-ai-operations.repository.ts:90`
trả `modelProvider`, `processingJobs`, `failedProcessingSummary` là
`NOT_EXPOSED`. Không có activity history hay nguồn job/model/retrieval metrics.

API hiện phù hợp hợp đồng readiness đang có, nhưng chưa đáp ứng nghĩa rộng của
“hoạt động AI” trong bảng công việc. Cần hợp đồng và nguồn dữ liệu an toàn từ
SAG owner trước khi triển khai. Không suy diễn model/provider hoạt động bình
thường từ health của metadata database.

### C1 — Hành vi cần chốt trước nghiệm thu: Sửa hồ sơ làm mất hiệu lực session

`platform-administration.repository.ts:1450` tăng `users.mutationFence` ngay khi
đổi fullName/avatarUrl. Authentication ở
`authentication.application.service.ts:999` từ chối access token mang fence cũ;
refresh cũng kiểm tra epoch. Do đó sửa tên/avatar có thể khiến các session hiện
có phải đăng nhập lại, kể cả operator tự sửa hồ sơ bằng user-management API.

Đây là hành vi xác định từ luồng mã hiện tại, chưa được nêu trong mô tả OpenAPI
của profile update; chưa coi là một yêu cầu nghiệp vụ đã được quyết định sai.
Cần xác nhận đây là chủ ý và ghi rõ hợp đồng, hoặc tách version phục vụ concurrency
khỏi session-revocation epoch. Không tự đổi semantics trong lượt review.

## Ma trận đủ 10 nhóm

“Đã có theo contract” nghĩa là có implementation và kiểm thử ở các tầng được
liệt kê, không đồng nghĩa đã nghiệm thu trên triển khai production.
Các route Platform có prefix `/api/v1/iam/platform`.

| Nhóm | Phạm vi đã kiểm tra | Kết luận |
| --- | --- | --- |
| Tổng quan | GET `/dashboard`; counts từ IAM, health probe, tối đa 5 recent audit items, UNKNOWN/UNAVAILABLE khi owner lỗi | Đã có theo contract. Repository aggregate và overview service tests chạy qua. |
| Tổ chức | List/detail, POST tạo, PATCH name/slug; first-admin độc lập operator, duplicate slug, CAS, rollback audit | Đã có theo contract. Chạy thêm 17 integration cases vốn bị skip trên MongoDB 7 replica set tạm: qua. Plan/lifecycle không nằm trong metadata edit. |
| Người dùng | Search/detail/lookup, profile, status, archive/restore, organization list, session list | Chưa hoàn toàn đúng: F2 và cần chốt C1. Status/archive có self-protection, last-ADMIN protection và session revocation; restore giữ SUSPENDED, không tự active hay khôi phục session cũ. |
| Membership | Global/member detail/filter, organization scope, invite/resend/cancel, suspend | Chưa đúng readiness runtime: F1. Lifecycle/CAS/idempotency/last-admin/foreign-org/audit rollback đã có repository tests; không đủ để bỏ qua lỗi wiring. |
| Dự án | List/detail, members, PATCH name/code/visibility; resolve persisted organization; CAS/audit | Đã có theo contract. Không cho sửa description/tenant content qua Platform. Repository tests kiểm tra orphan owner, concurrency, duplicate code và audit rollback. |
| Bảo mật | List/detail session family; revoke single/bulk/all, CAS, user scope, current authority, atomic audit, epoch | Đã có theo contract, gồm validation fixes local và regression tests. Access JWT kiểm tra family/fence ở lần authorization tiếp theo; không hủy request đang thực thi. |
| Vận hành | Services, queues/jobs, retry/cancel, AI status, integration metadata/test/reconnect | Chưa hoàn tất: F3/F4. Cancel chỉ WAITING/DELAYED, không cưỡng bức dừng ACTIVE job. BullMQ/Mongo có receipt và reconciliation, không phải distributed atomic rollback. |
| Sự cố | List/detail/history; create, acknowledge, resolve, notes; state machine/CAS/idempotency/redaction/audit | Đã có theo contract. OPEN → ACKNOWLEDGED → RESOLVED; không resolve thẳng OPEN. Real Mongo transaction tests gồm concurrent replay và rollback audit. |
| Hỗ trợ & kiểm toán | Audit list/detail/resource history; exact request/correlation ID trace | Đã có theo contract. Trace chỉ tối đa 50 allowlisted audit events đã lưu, không phải distributed tracing hoặc raw-log search đầy đủ. |
| Tài khoản Admin | GET `/api/v1/auth/platform/me`, POST `/api/v1/auth/logout`; fresh exact permissions, context, blacklist, refresh revoke, clear cookies | Đã có theo contract. Signed-JWT HTTP regression kiểm tra replay access token sau logout trả 401; identity/persistence dependencies có giới hạn fixture như ghi bên dưới. |

## Các kiểm soát chung đã kiểm tra

- Runtime IamModule có controller/service/repository registration; Gateway có
  route inventory đối chiếu controller. Không chỉ kiểm tra frontend link.
- Platform dùng verified principal, exact current PLATFORM assignment;
  Organization ADMIN hoặc forged actor/role header không tự có quyền.
- Phân trang có bound; query/body có allowlist; các projection không trả token,
  encrypted credential, raw job payload hoặc tenant content.
- Mutations giữ CSRF/idempotency/CAS theo từng contract. Chỉ gán “transaction
  nguyên tử” khi MongoDB bao phủ các write, không áp dụng cho BullMQ/Mongo.
- Rate limit local mới: Redis actor budget 120 reads/20 writes mỗi phút UTC,
  429/Retry-After, store failure 503, Gateway giữ budget headers. Không thay thế
  network rate limit; `/auth/platform/me` và `/auth/logout` ngoài ngân sách này.

## Kết quả kiểm tra trong lượt review

| Kiểm tra | Kết quả |
| --- | --- |
| `npm run check`: lint/typecheck/safety | Qua |
| Unit/integration mặc định | 1.498 qua, 135 skipped, 1 lỗi Capture |
| Lỗi Capture | `does not assign periods ending before a member joined`: nhận 4, kỳ vọng tối đa 3. Test đã có tính không ổn định từ các lượt trước; chưa xác định nguyên nhân trong review này. Không tính gate toàn repo là xanh. |
| Toàn bộ HTTP E2E chạy riêng | 168 qua, 4 skipped |
| `npm run build` | Qua |
| Org provisioning integration được bật riêng | 17 qua, MongoDB 7.0.24 mới, loopback URI do test cấp và dừng sau test |
| Reproduction F2 | 2 fail như dự kiến: chứng minh projection hiện tại sai; không cộng vào số test thành công |
| Mutation sensitivity của rate-limit tests | Bản sao helper đảo `if (!allowed)` thành `if (allowed)`: 9/10 tests fail; bản gốc không bị thay đổi |

Các bản sao tái hiện/mutation đã xóa. Logs của lượt review nằm ở `/tmp`:
`datn-admin-audit-check.log`, `datn-admin-audit-e2e.log`,
`datn-admin-audit-build.log`, `datn-admin-audit-provisioning.log`,
`datn-admin-audit-repro.log`, `datn-admin-audit-mutation.log`.

HTTP matrix dùng controller/guard/policy/service thật nhưng một số identity,
persistence, BullMQ và external provider là bounded doubles. Tests không chứng
minh SMTP/Jira/SAG trên môi trường triển khai thật. Skipped tests không được coi
là đã kiểm chứng. Lượt trước đã có Redis smoke thật trên instance tạm; lượt
review này kiểm tra lại code và tests, không trình bày smoke cũ như lần chạy mới.

## Thứ tự xử lý đề xuất

1. F1: khôi phục readiness evidence/fail-closed và thêm runtime-wiring test.
2. F2: thống nhất effective-permission projection với policy và thêm regression.
3. Chốt C1 để tránh tác dụng phụ session không được mô tả của profile edit.
4. Chốt owner contracts rồi triển khai Jira provider và AI activity source.
5. Xử lý nguyên nhân test Capture không ổn định trước khi coi gate toàn repo đạt.

Không merge, push, cấp permission hoặc sửa dữ liệu vận hành trong lượt review.
