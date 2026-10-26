# Backend quản trị: rate limit và các nhóm chức năng còn lại

Ngày kiểm tra: 2026-10-26. Nguồn hợp đồng: `docs/openapi/iam-v1.openapi.json`
và `docs/decisions/platform-operator-console-v2.md`.
Phạm vi: backend; giữ nguyên frontend, schema, migration và dữ liệu thực.

## Rate limit

Trước thay đổi này, backend có Redis rate limit cho login, password reset,
email registration, organization provisioning và một số luồng riêng; chưa có
ngân sách chung cho API Platform. Chỉ có response 429 trong tài liệu không đủ
chứng minh runtime đang giới hạn request.

Đã bổ sung giới hạn cho mọi operation dùng `PlatformAuthorizationGuard`
(`/api/v1/iam/platform/*`):

| Nhóm | Giới hạn theo tài khoản đã xác thực |
| --- | --- |
| GET/HEAD/OPTIONS | 120 request trong mỗi phút UTC |
| POST/PATCH/PUT/DELETE và method khác | 20 request trong mỗi phút UTC |

Ngân sách dùng chung giữa các tài nguyên, permission và IAM instance thông qua
Redis hiện có. Actor lấy từ subject được backend xác thực, không lấy từ header
actor/IP do client gửi. Redis key chứa digest của user ID chuẩn hóa. Đây là fixed
window, vì vậy có thể có hai đợt request sát hai phía của ranh giới phút; không
phải sliding window. Counter tăng và đặt TTL nguyên tử bằng Lua hiện có.

Guard kiểm tra authentication và quyền hiện tại trước khi tiêu ngân sách.
Khi vượt giới hạn, trả 429 `TOO_MANY_REQUESTS`, `Retry-After`,
`X-RateLimit-Limit`, `X-RateLimit-Reset` và `Cache-Control: no-store`.
Không trả số remaining giả vì port Redis hiện chỉ cung cấp kết quả boolean.
Khi rate-limit store lỗi, trả 503 `PLATFORM_RATE_LIMIT_UNAVAILABLE` trước khi
handler chạy. Gateway giữ nguyên status và chuyển tiếp các header trên.

Giới hạn này bảo vệ request Platform đã xác thực; không thay thế giới hạn
network/IP ở reverse proxy. `/auth/platform/me` và `/auth/logout` không dùng
guard Platform và không nằm trong ngân sách mới. Chính sách login hiện có được
giữ nguyên. Không thêm dependency hoặc biến cấu hình để vô hiệu hóa kiểm soát.

## Ma trận chức năng hiện tại

Các path Platform bên dưới có prefix `/api/v1/iam/platform`.
Đây là API đã tồn tại được rà soát và bổ sung kiểm thử; không tạo endpoint trùng.

| Nhóm | API | Kết luận |
| --- | --- | --- |
| Service | GET `/services`, `/services/{serviceId}` | Đã có probe bounded-timeout tới service owner, phân biệt availability/liveness/readiness và dependency; không giả định service chưa cấu hình là khỏe. |
| Job/queue | GET `/queues`, `/queues/{queueId}`, `/jobs`, `/jobs/{queueId}/{jobId}` | Đã có allowlist queue, pagination/filter, metadata an toàn; không trả payload thô. |
| Retry/cancel job | POST `/jobs/{queueId}/{jobId}/retry`, `/cancel` | Đã có expectedStatus, Idempotency-Key, CSRF và permission manage. Retry chỉ FAILED; cancel chỉ WAITING/DELAYED, không ép dừng ACTIVE job. |
| AI | GET `/ai/operations` | Đã có health/readiness của SAG. Chưa có lịch sử hoạt động, processing jobs, lỗi model hay retrieval metrics; các trường này được thể hiện NOT_EXPOSED/UNKNOWN theo hợp đồng. |
| Integration read | GET `/integrations`, `/integrations/{integrationId}` | Đã có signed owner-to-owner HTTP và safe metadata; không trả encrypted/plaintext credential hoặc raw provider error. |
| Integration test/reconnect | POST `/integrations/{integrationId}/test`, `/reconnect` | Route/validation/permission/CSRF và internal signed adapter đã có. Provider thực vẫn thiếu; runtime trả 503, chưa hoạt động với Jira thật. |
| Incident read/history | GET `/incidents`, `/incidents/{incidentId}`, `/history` | Đã có pagination/filter và history projection/redaction. |
| Incident lifecycle | POST `/incidents`, `/{incidentId}/acknowledge`, `/resolve`, `/notes` | Đã có state machine, expectedVersion, Idempotency-Key, authority recheck, history/audit trong Mongo transaction. |
| Request trace | GET `/diagnostics/traces/{requestId}` | Đã có tra cứu chính xác request/correlation ID trong audit đã lưu, tối đa 50 event an toàn. Không phải truy xuất raw log hay distributed trace đầy đủ. Không có event trả 404; lỗi nguồn trả 503. |
| Audit | GET `/audit/events`, `/audit/events/{eventId}`, `/audit/resources/{resourceType}/{resourceId}/history` | Đã có filter, pagination và allowlist projection; không serialize metadata tùy ý. |
| Admin account | GET `/api/v1/auth/platform/me` | Đã có thông tin identity/context và danh sách quyền PLATFORM còn hiệu lực, không tin quyền trong UI/token. |
| Logout | POST `/api/v1/auth/logout` | Đã có blacklist access JWT, thu hồi refresh family từ cookie và xóa cookie. Regression HTTP mới kiểm tra JWT đã logout bị từ chối khi dùng lại. |

Quyền đọc và manage của từng nhóm tách biệt, được tra lại trên mỗi request.
Organization ADMIN không tự có quyền PLATFORM. Side-effecting operations giữ
nguyên yêu cầu CSRF/idempotency/current-version của từng hợp đồng.

Mongo incident mutation/history/audit có transaction nguyên tử. BullMQ command
và Mongo audit không thể là cùng một Mongo transaction; implementation hiện có
lưu trạng thái command và reconciliation để retry không lặp side effect khi
audit tạm lỗi. Không gọi đây là rollback nguyên tử giữa Redis và Mongo.

## Phần còn thiếu đã được xác nhận

Người dùng xác nhận chưa có tài liệu/nhánh provider và yêu cầu ghi rõ phần thiếu:

1. **Jira test/reconnect thực:** `JiraModule` đang bind
   `UnavailableJiraPlatformIntegrationOperationsProvider`. Cần hợp đồng credential
   encryption/key ownership, OAuth/API-token flow, refresh/reconnect semantics,
   provider audit/idempotency và adapter owner được chấp thuận trước khi thay
   provider. Không được chỉ đổi status thành CONNECTED để báo thành công.
2. **Lịch sử hoạt động AI:** cần API/event source và safe projection từ SAG owner
   cho activity/jobs/failure/metrics, cùng pagination và quyền truy cập được chốt.
   Readiness không chứng minh hoạt động model/retrieval đã được quan sát.

Không thêm dữ liệu giả, không lấy raw credential từ Mongo để tự suy đoán định
dạng giải mã, không tự mở rộng API SAG trong lần thay đổi này.

## Kiểm chứng

- HTTP regression trước sửa: guard trả 200 khi budget đã hết; sau sửa trả 429.
- Gateway regression trước sửa: mất budget headers; sau sửa giữ status 429,
  Retry-After, Limit và Reset.
- Unit tests: ngân sách read/write riêng, actor isolation/case normalization,
  ranh giới phút, metadata retry và lỗi Redis fail-closed.
- HTTP matrix mới: 16 read routes kiểm tra đúng permission, 401/403; 8 mutation
  routes kiểm tra permission, CSRF, idempotency và 429 trước side effect;
  thêm invalid queries và trace 404/503.
- Admin HTTP test dùng AccessTokenService/JWT và application service thật;
  persistence và blacklist store là bounded doubles. Kiểm tra xóa cookie,
  hash refresh credential được chuyển tới repository và access-token replay 401.
- Các suite repository hiện có kiểm chứng incident lifecycle/CAS/idempotency/
  audit rollback trên Mongo replica set tạm, safe audit projection và job
  retry/cancel/reconciliation với BullMQ doubles.

Đã chạy thêm smoke test với Redis thật, chạy tạm trên cổng loopback ngẫu nhiên,
có password riêng và tắt persistence. Hai RedisService client cùng gửi 40 lệnh
ghi đồng thời cho một actor: đúng 20 thành công và 20 bị 429. Kiểm tra thêm actor
khác có ngân sách riêng, ngân sách đọc 120 tách với ghi và cửa sổ phút mới được
cấp lại. Redis tạm được dừng sau test. Smoke này dùng clock cố định để kiểm tra
ranh giới phút; không phải benchmark tải hoặc kiểm thử Redis Cluster.

HTTP fixtures không chứng minh Jira/SAG provider hoạt động thật. Không truy cập
database thật, không retry/cancel job thật, không reconnect integration thật
trong quá trình kiểm thử.

Kết quả cuối:

- Lint, typecheck và các safety checks trong `npm run check`: qua.
- Unit/integration: 1.498 qua, 135 skipped, 1 lỗi ở Capture
  `does not assign periods ending before a member joined` (nhận 4 work report,
  kỳ vọng tối đa 3). Cùng test đã qua khi chạy riêng và ở lần full run trước;
  chưa xác định nguyên nhân không ổn định, không thay đổi Capture để né lỗi.
- E2E chạy riêng sau đó: 168 qua, 4 skipped.
- `npm run build`: qua. `git diff --check`: qua.
- Redis smoke thật trên instance tạm: qua như mô tả ở trên.

Vì Capture còn lỗi, không coi gate tổng thể là xanh và chưa merge/push.
Code vẫn ở local trên nhánh `codex/platform-session-security`, cùng phần session
đã làm ở lượt trước. Không commit dữ liệu, secret hoặc file log kiểm thử.
