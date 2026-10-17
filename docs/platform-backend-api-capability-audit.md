# Platform Backend API Capability Audit

Ngày audit: 2026-10-17

## 1. Executive Summary

**Kết luận: PARTIAL.** Backend chưa đủ API để xây dựng toàn bộ Platform Administration Console. Backend có một lát cắt Platform thực sự: tạo/đọc Organization, tra cứu một User theo email chính xác, đọc Membership theo Organization, suspend Membership, đọc IAM liveness và đọc audit projection giới hạn. Các route này có Platform permission riêng và được bảo vệ bằng PlatformAuthorizationGuard.

Các phần còn thiếu gồm Platform user directory/lifecycle, session administration, project directory, jobs/queues, integration administration, incidents, diagnostics và dashboard aggregate. Một số API/domain tương tự tồn tại trong Organization scope hoặc dạng persistence/infrastructure; chúng không cho Platform Operator quyền truy cập theo scope hiện tại.

**Phạm vi:** Backend NestJS DATN_BE, branch feat/Thang-platform-operator-v1-be-api, commit b274598. Working tree có sẵn untracked .serena/ và được giữ nguyên. FE chỉ đọc tại DATN_FE, branch feat/Thang-platform-console-ui-fe-ui, commit 7446c26; checkout này có thay đổi chưa commit và không bị sửa. Audit tĩnh trên source, contract, schema và tests; không chạy tests hay gọi dịch vụ đang chạy.

**Đếm capability:** Master Matrix có 54 dòng capability nguyên tử, mỗi dòng một status chính: 5 READY, 14 PARTIAL, 7 API_EXISTS_SCOPE_WRONG, 18 API_MISSING, 5 DOMAIN_MISSING, 3 UNSUPPORTED_BY_CURRENT_ARCHITECTURE, 1 API_EXISTS_AUDIT_MISSING, 1 API_EXISTS_TEST_MISSING. Không tìm thấy route Platform hiện có nào thiếu Platform permission; API chưa tồn tại không được suy diễn thành permission code bị thiếu.

### BUGS FOUND

1. Gateway GET /health/ready dùng cùng requestServiceHealth() với /health; implementation chỉ gọi GET /internal/health của IAM. Route tên “ready” nhưng không chứng minh MongoDB, Redis hoặc BullMQ sẵn sàng.
2. PATCH /api/v1/iam/users/:userId có thể thay đổi trạng thái User trong Organization scope, nhưng UserDirectoryRepository.updateStatusAtomically không ghi audit event. Không được dùng route này làm Platform user status API.
3. OpenAPI khai báo một số PATCH Project/Membership không được controller triển khai; OpenAPI README cũng mô tả Project partial update. Đây là contract drift, không phải bằng chứng API chạy được.
4. OpenAPI chỉ liệt kê ba Platform routes A-04 trong khi runtime có tám route dưới /iam/platform; FE gọi một số route không được mô tả.

## 2. Current Platform Permissions

Registry thực tế là PLATFORM_PERMISSIONS trong src/services/iam/application/authorization/authorization.policy.ts. Có đúng bảy permission:

| Permission | Purpose / resource | Scope và điều kiện cấp | Endpoint sử dụng |
|---|---|---|---|
| organization.create | Tạo Organization và bootstrap first ADMIN | Assignment scope PLATFORM; không được cấp bởi Organization ADMIN | POST /api/v1/iam/platform/organizations |
| platform.health.read | Đọc IAM process liveness | PLATFORM | GET /api/v1/iam/platform/health |
| platform.audit.read | Đọc operational audit projection giới hạn | PLATFORM | GET /api/v1/iam/platform/audit |
| platform.organizations.organization.read | Đọc Organization summary | PLATFORM | GET /api/v1/iam/platform/organizations và /:organizationId |
| platform.users.account.read | Tra cứu một tài khoản ACTIVE theo email chính xác | PLATFORM | POST /api/v1/iam/platform/users/lookup |
| platform.memberships.membership.read | Đọc Membership của một Organization | PLATFORM | GET /api/v1/iam/platform/organizations/:organizationId/memberships |
| platform.memberships.lifecycle.manage | Suspend Membership theo policy hẹp | PLATFORM | POST /api/v1/iam/platform/organizations/:organizationId/memberships/:membershipId/suspend |

Mỗi route /iam/platform có permission decorator riêng, class guard đọc evidence đang hiệu lực. Permission nằm trong platform_authority_assignments, tách khỏi Organization role assignments. Organization Admin và role khác không thừa hưởng các quyền này. GET /auth/platform/me và POST /auth/logout thao tác trên principal/session của chính người đang đăng nhập, được kiểm tra bằng context/token thay vì quyền quản trị người khác.

Không có permission code trong registry cho Platform user directory/status, session administration, project administration, job retry/cancel, integration, incident hay diagnostics. Vì chưa có route và policy tương ứng, báo cáo không tự đặt tên permission cho các capability đó.

## 3. API Inventory

Global prefix là /api/v1. Tám handler Platform nằm trong PlatformController tại src/services/iam/controllers/platform.controller.ts; class gắn PlatformAuthorizationGuard.

| Method và route | Request / query / headers | Response và giới hạn | Permission / scope | Audit, sensitive data, tests |
|---|---|---|---|---|
| POST /api/v1/iam/platform/organizations | Body strict: name, slug, plan (FREE/ENTERPRISE), firstAdminUserId; cookie auth cần CSRF | 201, {id,name,slug,plan,createdAt,updatedAt}; không pagination | organization.create; PLATFORM action tạo Organization | Ghi organization.create cùng transaction với Organization, ACTIVE first-ADMIN Membership và role assignment. E2E test bao gồm 201/401/403/409/422/500, bootstrap và rollback audit. Không trả credentials. |
| GET /api/v1/iam/platform/organizations | Query page mặc định 1, pageSize mặc định 20, tối đa 100; không filter/sort tùy chọn | data[] gồm id/name/slug/plan/createdAt/updatedAt; pagination gồm page/pageSize/totalItems/totalPages | platform.organizations.organization.read; PLATFORM | Projection không trả settings. Có repository integration test; không có HTTP test riêng cho list. |
| GET /api/v1/iam/platform/organizations/:organizationId | ObjectId path; không query/body | PlatformOrganizationSummary; 404 khi không tồn tại | platform.organizations.organization.read; PLATFORM | Projection summary; service/repository được gọi trong membership flow, không tìm thấy HTTP test riêng cho detail. |
| POST /api/v1/iam/platform/users/lookup | Body duy nhất {email}; strict key; bắt buộc CSRF pair kể cả khi có Authorization | HTTP 200, {id,email,fullName,status:"ACTIVE"}; 404 USER_NOT_FOUND nếu không có tài khoản ACTIVE khớp chính xác | platform.users.account.read; PLATFORM | Không trả password hash/MFA secret; repository test kiểm tra projection. Không phải list/search/filter API. |
| GET /api/v1/iam/platform/organizations/:organizationId/memberships | Query page/pageSize tối đa 100, status tùy chọn theo membership enum; không search/sort | PlatformMembershipPage, mỗi dòng gồm membership/user ID, status/version/timestamps, user summary, organizationRoles[] và pagination | platform.memberships.membership.read; PLATFORM, path gắn một Organization | Repository test kiểm tra org fence và loại secret/permissions khỏi response. Không có HTTP contract test riêng. Role projection chỉ lấy Organization ADMIN/MEMBER, không effective permissions. |
| POST /api/v1/iam/platform/organizations/:organizationId/memberships/:membershipId/suspend | Body expectedMembershipVersion, reasonCode (SECURITY_INCIDENT/ACCESS_REVIEW); Idempotency-Key bắt buộc 16–128 ký tự; cookie auth cần CSRF; X-Request-ID tùy chọn | HTTP 200 hoặc replay; body membership SUSPENDED/version mới; X-Idempotent-Replay header | platform.memberships.lifecycle.manage; PLATFORM, repository đối chiếu orgId với membership | Ghi ORGANIZATION_MEMBERSHIP_SUSPENDED; transaction/idempotency, version fence, last-admin safeguard. Repository integration test gồm stale version, unassigned authority, cross-Organization 404, last-admin, audit rollback. |
| GET /api/v1/iam/platform/health | Không query/body | {"status":"ok"} từ IAM process liveness | platform.health.read; PLATFORM | Không phải readiness/dependency health. Có route metadata inventory nhưng không tìm thấy test chạy đúng Platform health handler; status API_EXISTS_TEST_MISSING. |
| GET /api/v1/iam/platform/audit | Không query/body | Tối đa 100 records: action/resource/resource ID/actor ID/time; không pagination/filter/detail | platform.audit.read; PLATFORM | Mongo whitelist bốn actions, projection bỏ metadata. Repository test kiểm tra không lộ password/token/tenant/project content; chưa có HTTP integration test. |

Supporting routes và domain cùng tên nhưng không phải Platform API:

| Capability hiện có | Implementation và scope thật |
|---|---|
| User list/detail/update | UserDirectoryController: GET /api/v1/iam/users, GET /api/v1/iam/users/:userId, PATCH /api/v1/iam/users/:userId; principal và UserDirectoryService.requireAdmin khóa vào Organization hiện tại. Filter status/roleCode, không text search. |
| Membership read | OrganizationMembershipReadController: GET /api/v1/iam/organizations/:organizationId/memberships và /:membershipId; Organization scope, Organization membership permission. |
| Invitation/lifecycle | OrganizationMembershipCommandController tại /api/v1/iam/organizations/:organizationId: GET/POST invitations, POST resend/cancel và POST memberships/:membershipId/suspend. Một số lệnh invitation đang bị readiness gate và trả 503. |
| Project directory/access | ProjectController tại /api/v1/iam/projects chỉ POST/list/detail theo Organization principal. ProjectAccessController có visibility và project membership/leader routes với Project access authorization. |
| Session self-service | AuthenticationController: GET /api/v1/auth/platform/me, POST /api/v1/auth/logout; không có list/revoke session người khác. |
| Health | HealthController /api/v1/health và Gateway /health, /health/ready; không tạo Platform dependency projection. |
| Jobs, AI/RAG, Jira, Incident | BullMQ, ingestion job schema, Jira connection schema và module boundary có tồn tại; không tìm thấy Platform controller/API quản trị tương ứng. |

### Route-to-handler evidence

- POST /iam/platform/organizations → PlatformController.createOrganization → OrganizationProvisioningService.create → MongoOrganizationProvisioningRepository.create; permission organization.create.
- GET /iam/platform/organizations → PlatformController.listOrganizations → PlatformAdministrationService.listOrganizations → MongoPlatformAdministrationRepository.listOrganizations; permission platform.organizations.organization.read.
- GET /iam/platform/organizations/:organizationId → PlatformController.findOrganization → PlatformAdministrationService.findOrganization → MongoPlatformAdministrationRepository.findOrganization; permission platform.organizations.organization.read.
- POST /iam/platform/users/lookup → PlatformController.lookupUser → PlatformAdministrationService.lookupActiveUser → MongoPlatformAdministrationRepository.findActiveUserByExactEmail; permission platform.users.account.read.
- GET /iam/platform/organizations/:organizationId/memberships → PlatformController.listOrganizationMemberships → PlatformAdministrationService.listOrganizationMemberships → MongoPlatformAdministrationRepository.listOrganizationMemberships; permission platform.memberships.membership.read.
- POST /iam/platform/organizations/:organizationId/memberships/:membershipId/suspend → PlatformController.suspendMembership → PlatformAdministrationService.suspendMembership → MongoOrganizationMembershipCommandRepository.executePlatformSuspend; permission platform.memberships.lifecycle.manage.
- GET /iam/platform/health → PlatformController.getHealth → IamApplicationService.getHealth; permission platform.health.read. Handler trả process health, không đọc dependency readiness.
- GET /iam/platform/audit → PlatformController.listAudit → PlatformAuditService.listOperationalMetadata → MongoPlatformAuditRepository.listOperationalMetadata; permission platform.audit.read.
- GET /auth/platform/me → AuthenticationController.getCurrentPlatformSessionIdentity → AuthenticationApplicationService.getCurrentPlatformSessionIdentity; current Platform principal.
- POST /auth/logout → AuthenticationController.logout → AuthenticationApplicationService.logout; revoke current presented credentials.

## 4. User Management

Platform chỉ có exact-email lookup cho tài khoản ACTIVE qua PlatformAdministrationService.lookupActiveUser → MongoPlatformAdministrationRepository.findActiveUserByExactEmail. Không có Platform list/search/filter/detail, activate/deactivate, toàn bộ memberships theo User, effective roles/permissions hoặc user sessions.

Organization-scoped directory không tương đương Platform directory. GET /iam/users chạy theo Organization hiện tại; detail/PATCH kiểm tra admin hiện tại và khóa đối tượng trong tenant. Status dùng ACTIVE/SUSPENDED (invite có PENDING_INVITE), không dùng INACTIVE. PATCH đổi status nhưng repository không ghi audit. Xem dòng 1.1–1.5 và 13.4 trong matrix.

FE đã tích hợp lookup để chọn first ADMIN khi tạo Organization. Trang Users còn lại là placeholder; không có bằng chứng FE gọi Platform directory route vì route đó chưa tồn tại.

## 5. Organization Management

Platform API hỗ trợ create, list, detail với PlatformOrganizationSummary. Create transaction đồng thời tạo Organization, Membership ACTIVE cho first ADMIN, role assignment ADMIN và audit. List/detail không trả settings hoặc secret.

Không có Platform update metadata hoặc organization lifecycle/status API. Model Organization có name/slug/plan/settings/timestamps và revision cho membership admin; không có trạng thái lifecycle. Member list và suspend được ghi ở nhóm Membership. Invitation commands là Organization scope, không phải Platform administration. FE có placeholder cho metadata/lifecycle/invitation/role management.

## 6. Membership Management

Platform list giới hạn một Organization, hỗ trợ pagination và status filter; state hiện trong repository gồm PENDING_INVITE, ACTIVE, SUSPENDED, REMOVED. Platform suspend được implement ở application/repository, có idempotency, optimistic version, last-eligible-admin guard và audit atomicity.

Không có Platform invite/resend/revoke, remove, restore hoặc role change. Organization invitation command route có tồn tại nhưng scope là Organization; một số command readiness-gated và trả 503. Organization cancel chuyển pending membership thành REMOVED; không tìm thấy restore hoặc role-change route. Không có membership history API riêng; Platform audit chỉ hiển thị event suspend trong whitelist.

## 7. Project Management

Project domain tồn tại, nhưng ProjectController list/detail/create yêu cầu identity và Organization context; ProjectAccessController quản lý visibility, member/leader metadata dưới Project scope. Không có /iam/platform/projects route, Platform permission hay Platform-wide metadata projection.

**NOT A PLATFORM BACKEND RESPONSIBILITY:** các API hiện tại để Organization/Project Admin quản lý Project trong tenant thuộc đúng scope đó. Không dùng chúng từ Platform UI hoặc coi chúng là Platform API. Nếu sản phẩm yêu cầu Platform Operator xem/tác động metadata xuyên Organization, cần capability/API riêng được phê duyệt.

Không tìm thấy Platform API trả documents, chunks, source content hoặc retrieval payload; cần giữ ranh giới này. OpenAPI có PATCH Project và PATCH project membership mà controller không triển khai; xem mục 28.

## 8. Session & Security

GET /api/v1/auth/platform/me kiểm tra verified, active, non-revoked access token và context=PLATFORM, rồi dựng lại effective Platform permissions. Response là principal của operator; không có session ID/status/expiry/IP/UA đầy đủ. FE dùng API này.

Logout chỉ revoke access token và refresh token đang được trình bày trong request, sau đó clear cookies; không tìm thấy audit event. Không có Platform session list/detail, revoke session của User khác, bulk revoke, anomalous activity hay security-event API. Model refresh_sessions lưu refresh-token hash và revoked/expiry/context metadata nhưng không có Platform reader/command controller. Không phát hiện entity anomaly event.

Mutation nhạy cảm mới chỉ có Membership suspend với permission, CSRF, idempotency và audit. FE account page là self-service; session/security administration còn placeholder.

## 9. Platform Dashboard

FE lấy Organization count từ pagination.totalItems của Platform org list. User/project count và active/inactive aggregate hiển thị unavailable; không có endpoint aggregate. Recent activity dùng audit list tối đa 100; IAM status chỉ liveness.

Không có Platform aggregate cho User/Project count, trạng thái, platform-wide operational events hoặc service dependency health. Không thay thế bằng count Organization APIs hoặc dữ liệu mock.

## 10. Service Operations

GET /api/v1/iam/platform/health trả IAM process liveness: status ok. Health endpoint ghi rõ không xác nhận MongoDB, Redis, BullMQ hoặc dependency readiness.

GatewayHealthController routes /health và /health/ready cùng gọi requestServiceHealth(), chỉ request IAM /internal/health. Vì vậy /health/ready không đại diện dependency readiness. Không có Platform service registry/status/availability/dependency/diagnostic projection.

## 11. Jobs & Queues

BullMQ queues và ingestion job persistence tồn tại (job states WAITING, ACTIVE, COMPLETED, FAILED, RETRYING), nhưng không tìm thấy Platform GET jobs/detail/failed jobs, queue status/health, retry/cancel hoặc error projection API. Persistence/runtime không đồng nghĩa API hoặc quyền quản trị.

Không có Platform response projection để redact job payload/error; không có HTTP action audit hoặc controller tests vì API chưa tồn tại. FE Jobs là placeholder.

## 12. RAG & AI

AiEngineModule hiện là module boundary rỗng; tài liệu kiến trúc đặt FastAPI/SAG ở dịch vụ riêng. Không tìm thấy Platform proxy/health/status cho index, model, retrieval hoặc AI processing. Audit phân loại phần này UNSUPPORTED_BY_CURRENT_ARCHITECTURE đối với NestJS hiện tại; cần xác định service owner/contract trước khi hứa capability.

Không có Platform API trả tenant documents, chunks, private prompts, retrieval context, API key hay credential. Giữ giới hạn operational-only nếu tích hợp sau này. FE AI/RAG là shell/placeholder, không phải API hiện có.

## 13. Integrations

Mongo schema jira_connections có organizationId/projectId, provider/site metadata, connection status, lastSyncAt và trường encrypted credentials/webhook secret. Đây là tenant/project integration persistence, không có Platform list/status/test/reconnect controller.

Không dùng schema làm bằng chứng credentials có thể hoặc nên trả về UI. Không có Platform-safe operational error projection, permission/audit cho reconnect, hay integration API tests. FE Integration page chưa kết nối Platform backend.

## 14. Incidents

Không tìm thấy Incident entity/schema, controller, service, status enum hay event history. Vì domain model cũng chưa có, list/detail/severity/affected service, acknowledge/resolve/notes/history/audit đều DOMAIN_MISSING. Không suy diễn enum OPEN/ACKNOWLEDGED/RESOLVED.

FE Incident page là placeholder. Nếu cần capability, trước hết cần quyết định domain/source of truth; audit này không thay đổi schema hay giả định enum.

## 15. Diagnostics

Không tìm thấy Platform request trace/lookup, diagnostic tools, system troubleshooting hoặc redacted diagnostic output API. Request ID/correlation headers ở một số mutation không tạo endpoint tra cứu. Không tìm thấy response projection chứng minh việc redact authorization/cookie/token/password/secret/tenant payload.

FE diagnostics area là placeholder. Endpoint tương lai cần định nghĩa projection và redaction contract trước khi expose.

## 16. Audit

GET /api/v1/iam/platform/audit → PlatformAuditService.listOperationalMetadata → MongoPlatformAuditRepository.listOperationalMetadata đọc continuum_audit.audit_logs_iam. Query chỉ nhận bốn action: organization.create, platform.authority.granted, platform.authority.revoked, ORGANIZATION_MEMBERSHIP_SUSPENDED; sort mới nhất trước, limit 100. Response chỉ gồm action, targetResource, targetResourceId, actorUserId, occurredAt. Không trả metadata thô.

Không có query filters, server-side time range, pagination, event detail hay per-resource history. Filter trên FE là filter local của tập tối đa 100 event. Grant/revoke event có reader support nhưng authority lifecycle service chưa nối vào HTTP route.

Đã xác minh event producer cho Organization create và Platform Membership suspend. Organization invite/resend/cancel có audit writes nhưng không thuộc Platform audit whitelist. Project mutations có audit tenant scope nhưng không nằm trong Platform whitelist. User status update không ghi audit; logout không có audit; integration/incident actions chưa có.

## 17. Platform Account

GET /api/v1/auth/platform/me (AuthenticationController.getCurrentPlatformSessionIdentity) trả id/email/name/context=PLATFORM/permissions sau khi xác thực access token và đọc lại permission evidence. Không trả credential/token. Controller test xác nhận route gọi application service và trả permission projection.

Response không có session ID, trạng thái session riêng, issued/expiry details hoặc login IP/user-agent. POST /api/v1/auth/logout là sign out self; service revoke token hiện tại và endpoint clear access/refresh cookies. Không tương đương Platform session management.

## 18. Permission Matrix

| Permission thật | Resource / scope | Platform Operator | Organization Admin | Role khác | Implemented / endpoint |
|---|---|---|---|---|---|
| organization.create | Organization create; action scope PLATFORM | Có khi assignment ACTIVE/valid | Không qua quyền PLATFORM; có flow riêng tạo Organization của mình nếu policy cho phép | Không qua quyền PLATFORM | Có, POST platform organizations |
| platform.health.read | IAM liveness / PLATFORM | Có khi assignment hợp lệ | Không | Không | Có, GET platform health |
| platform.audit.read | Operational audit / PLATFORM | Có khi assignment hợp lệ | Không | Không | Có, GET platform audit |
| platform.organizations.organization.read | Organization summary / PLATFORM | Có khi assignment hợp lệ | Không | Không | Có, Organization list/detail |
| platform.users.account.read | Exact active account lookup / PLATFORM | Có khi assignment hợp lệ | Không | Không | Có, user lookup |
| platform.memberships.membership.read | Membership của Organization / PLATFORM | Có khi assignment hợp lệ | Không qua quyền PLATFORM | Không | Có, Platform Membership list |
| platform.memberships.lifecycle.manage | Platform Membership suspend / PLATFORM | Có khi assignment hợp lệ | Không qua quyền PLATFORM | Không | Có, Platform suspend |

Policy/guard tests xác minh role/header claims không tự tạo Platform authority; guard đọc fresh evidence, từ chối assignment inactive/revoked/expired, trả 401/403 và fail closed 503 khi evidence provider lỗi. Không phát hiện route Platform chỉ được bảo vệ bằng permission chưa có trong registry.

## 19. Resource Scope Matrix

| Route/domain | Authentication / authorization | Resource và scope | Kết luận Platform |
|---|---|---|---|
| /iam/platform/organizations* | Active Platform principal + permission assignment | Organization resource; PLATFORM action scope | Platform API thực sự |
| /iam/platform/users/lookup | Platform permission + CSRF check | User record, exact lookup | Platform API hẹp, không phải directory |
| /iam/platform/organizations/:id/memberships* | Platform principal + per-route permission | Membership thuộc organizationId trong path | Platform API có Organization fence |
| /iam/users* | Current identity + Organization Admin policy | User trong Organization của principal | Không phải Platform API |
| /iam/organizations/:organizationId/memberships* | Organization-context membership/admin permission | Membership trong Organization | Không phải Platform API |
| /iam/projects* | Current identity/Organization scope; project permission/guard | Project của Organization và Project membership | Không cho Platform-wide access |
| /auth/platform/me, /auth/logout | Principal của chính user, Platform context ở me | Current account/current credentials | Self-service, không quản trị account/session khác |
| ingestion_jobs, BullMQ, jira_connections | Internal runtime/schema; không Platform controller | Job/queue hoặc tenant integration | Persistence/runtime không thành API Platform |
| Project documents/content/RAG source | Không có Platform route tìm thấy | Tenant/private content | Không expose qua Platform API |

PlatformAuthorizationGuard resolve principal từ verified session/context và kiểm tra permission từ persisted evidence; client-selected Organization ID không biến Organization/Project route thành Platform route. Platform data routes có path scope và repository projection riêng.

## 20. Audit Coverage

Đối với mutation HTTP Platform đang tồn tại: 2/2 có audit event bắt buộc (Organization create và Platform Membership suspend). Organization create audit cùng transaction bootstrap; suspend audit cùng membership mutation/idempotency ledger, lỗi audit làm rollback. Platform audit projection bỏ metadata và giới hạn action/field.

Ngoài mutation Platform hiện hữu, PATCH /api/v1/iam/users/:userId status update trong Organization scope tồn tại nhưng UserDirectoryRepository.updateStatusAtomically không ghi event. Grant/revoke audit producer có thể tồn tại trong PlatformAuthorityChangeService/repository nhưng chưa có HTTP route. Invitation writes có organization audit nhưng tenant scope và không vào Platform projection. Project writes có audit scope riêng. Logout không có audit được tìm thấy; integration/incident/job Platform actions chưa có API.

## 21. Test Coverage

Static inspection tests đã có; không chạy test trong vòng audit:

| Test class/file | Đã bao phủ | Giới hạn |
|---|---|---|
| src/services/iam/controllers/platform.controller.spec.ts | Reflection inventory khẳng định đúng 8 path/permission trên controller | Không gọi handler để kiểm tra HTTP response/auth runtime |
| src/services/iam/infrastructure/mongodb/organization-provisioning.mongodb.spec.ts | HTTP integration create: success, invalid input, 401/403, 409, 422, 500, duplicate/concurrent slug, rollback, audit, cross-role/revoked authority | Chỉ bao phủ create |
| src/services/iam/infrastructure/mongodb/platform-administration.mongodb.spec.ts | Repository projection org/user/membership; suspend, pagination/scope, cross-Organization 404, stale 409, permission denial, last-admin, audit atomicity/rollback và redaction | Repository/command trực tiếp, không phải controller HTTP integration |
| src/services/iam/infrastructure/mongodb/platform-audit.repository.spec.ts | Audit whitelist, bounded projection và loại sensitive data | Không kiểm tra HTTP route |
| src/services/iam/application/authorization/platform-authorization.guard.spec.ts | 401/403, revoked/fresh evidence, forged role claim, fail-closed 503 | Test controller/guard, không chạy từng production route |
| src/services/iam/controllers/authentication.controller.spec.ts và application service spec | /auth/platform/me projection; platform session identity/logout behavior | Không có session-admin APIs để test |
| src/services/iam/application/authorization/project-access-authorization.guard.spec.ts | Từ chối client chọn cross-organization context, project permission/scope | Không tạo Platform project coverage |

Đếm đúng tám handler PlatformController: **1/8 có HTTP integration test trực tiếp** (POST organization create); 8/8 có static route/permission inventory. Repository/service tests bổ sung có giá trị nhưng không chứng minh controller contract. Tìm thấy tests status 401/403/404/409/422/500 trong các flow liên quan; không tìm thấy 429 test cho Platform API trong tập đã kiểm tra. Capability không có route cũng không có auth/audit/security API test.

## 22. Master Capability Matrix

Mỗi dòng là một capability độc lập trong tổng số 54. FE ready phân biệt route được gọi thật với UI shell; status là một phân loại chính, không loại bỏ thiếu sót phụ ghi tại Tests/Audit.

| Group | Capability | API exists / route | Scope | Permission | Audit | Tests | FE ready | Status |
|---|---|---|---|---|---|---|---|---|
| 1 Users | Directory/search/filter | Chỉ POST /iam/platform/users/lookup exact email | PLATFORM, partial | platform.users.account.read | Lookup không mutate | Repository projection, không HTTP test | Lookup dùng cho first ADMIN; directory shell | PARTIAL |
| 1 Users | User detail | GET /iam/users/:userId | ORGANIZATION | Org admin policy | Read | Org tests, không Platform | Platform detail shell | API_EXISTS_SCOPE_WRONG |
| 1 Users | Activate/deactivate/status | PATCH /iam/users/:userId | ORGANIZATION | Org admin policy | Thiếu audit | Org service/repository tests | Platform status shell | API_EXISTS_SCOPE_WRONG |
| 1 Users | Memberships/effective roles/permissions theo User | Platform list /iam/platform/organizations/:id/memberships chỉ có orgRoles | PLATFORM, một org/lần | platform.memberships.membership.read | Read | Repository projection | Membership tab có list; user detail thiếu | PARTIAL |
| 1 Users | User sessions | Không có Platform route | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 2 Orgs | Organization list/detail/basic metadata | GET /iam/platform/organizations[/:organizationId] | PLATFORM | platform.organizations.organization.read | Read | Repository tests; thiếu HTTP list/detail | Có, org screen/dashboard | READY |
| 2 Orgs | Edit metadata | Không có Platform PATCH/PUT | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 2 Orgs | Organization lifecycle/status | Không có status field/API | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | DOMAIN_MISSING |
| 2 Orgs | Member list và Organization ADMIN visibility | GET Platform memberships; roles chỉ ADMIN/MEMBER | PLATFORM, một org | platform.memberships.membership.read | Read | Repository test | Có, member directory | PARTIAL |
| 2 Orgs | Invite/resend/revoke Organization membership | POST invitations/resend/cancel dưới /iam/organizations/:id | ORGANIZATION | Org admin policy | Một số tenant events; không Platform audit | Command tests; một số gate 503 | Platform invitation shell | API_EXISTS_SCOPE_WRONG |
| 3 Membership | Membership list/filter/status | GET /iam/platform/organizations/:id/memberships | PLATFORM, một org | platform.memberships.membership.read | Read | Repository integration; thiếu HTTP test | Có, status filter | READY |
| 3 Membership | Invite/resend/revoke | Organization invitation routes; không Platform equivalent | ORGANIZATION | Org admin policy | Tenant audit không vào Platform projection | Command tests; một số 503 gates | Shell | API_EXISTS_SCOPE_WRONG |
| 3 Membership | Suspend/remove/restore | Platform POST suspend; org scope có suspend/cancel, không Platform remove/restore | PLATFORM partial / ORGANIZATION | platform.memberships.lifecycle.manage cho suspend | Suspend audited | Repository integration gồm audit/cross-org/409 | Suspend có UI; action khác shell | PARTIAL |
| 3 Membership | Role change | Không có route đổi Organization role | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 3 Membership | Membership history/audit | Platform audit có suspend event trong whitelist, không history riêng | PLATFORM partial | platform.audit.read | Event giới hạn | Audit repository test | UI local filter/activity | PARTIAL |
| 4 Projects | Project directory/detail/org association/metadata | GET /iam/projects, /iam/projects/:projectId | ORGANIZATION | Organization/project read policy | Không phải Platform audit | Project tests | Platform projects shell | API_EXISTS_SCOPE_WRONG |
| 4 Projects | Visibility/access policy | GET/PATCH /iam/projects/:id/visibility | PROJECT + ORGANIZATION | project.visibility.manage | Project audit scope | Project guard/service tests | Platform shell | API_EXISTS_SCOPE_WRONG |
| 4 Projects | Project membership/access metadata | GET/POST/DELETE /iam/projects/:id/memberships; leader routes | PROJECT + ORGANIZATION | project.members.*, project.leader.manage | Project audit scope | Project access tests | Platform shell | API_EXISTS_SCOPE_WRONG |
| 4 Projects | Platform-safe metadata-only projection | Không có /iam/platform/projects | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 5 Security | Current Platform identity/effective permissions | GET /api/v1/auth/platform/me | Current principal | Verified active Platform context | Read | Controller/application tests | Có | PARTIAL |
| 5 Security | Other-user session list/detail | Không có Platform route; refresh session model chỉ persistence | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 5 Security | Session revoke/multi-revoke | POST /auth/logout chỉ revoke credential đang trình bày | Self only | Authenticated self | Logout audit không tìm thấy | Application service tests | Chỉ sign-out self | PARTIAL |
| 5 Security | Anomalous session/security events | Không tìm thấy event/entity/API | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | DOMAIN_MISSING |
| 6 Dashboard | Organization count | GET org list trả pagination.totalItems | PLATFORM list projection | platform.organizations.organization.read | Read | Repository test | Có, compose UI | PARTIAL |
| 6 Dashboard | User/project count, active/inactive summary | Không có Platform aggregate | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | UI ghi unavailable | API_MISSING |
| 6 Dashboard | Platform health summary | GET /iam/platform/health chỉ IAM liveness | PLATFORM | platform.health.read | Read | Handler integration thiếu | Có nhưng chỉ liveness | PARTIAL |
| 6 Dashboard | Operational events + recent audit | GET /iam/platform/audit, tối đa 100, bốn actions | PLATFORM bounded | platform.audit.read | Chỉ action whitelist | Repository projection test | Có, recent list | PARTIAL |
| 7 Services | Service list/status/availability | Không có service registry/API | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 7 Services | IAM liveness | GET /iam/platform/health trả status ok | PLATFORM | platform.health.read | Read | Không test trực tiếp đúng handler | Dashboard dùng endpoint | API_EXISTS_TEST_MISSING |
| 7 Services | Readiness/dependency/database/queue health | Gateway /health/ready gọi cùng IAM /internal/health; không check dependency | Gateway health, không Platform projection | N/A | Read | Gateway spec xác nhận URL IAM; không dependency tests | Không có readiness projection | PARTIAL |
| 7 Services | Service diagnostics | Không có Platform route | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 8 Jobs | Job list/detail/status/failure | Persistence/runtime có, không controller | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có Platform API test | Shell | API_MISSING |
| 8 Jobs | Queue list/state/health | BullMQ có runtime, không Platform projection | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 8 Jobs | Retry/cancel job | Không có route/service Platform | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 8 Jobs | Redacted job error/failure projection | Không có API projection | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có redaction test | Shell | API_MISSING |
| 9 AI/RAG | Index status/processing | Không có trong backend NestJS Platform contract | External SAG boundary | N/A | N/A | Không có Platform API test | Shell | UNSUPPORTED_BY_CURRENT_ARCHITECTURE |
| 9 AI/RAG | Model/LLM health | AiEngineModule rỗng; SAG là dịch vụ ngoài | External service | N/A | N/A | Không có | Shell | UNSUPPORTED_BY_CURRENT_ARCHITECTURE |
| 9 AI/RAG | Retrieval operational status, content-safe | Không có Platform operational proxy | External SAG boundary | Chưa có contract | N/A | Không có | Shell | UNSUPPORTED_BY_CURRENT_ARCHITECTURE |
| 10 Integrations | Integration list/provider/status/last check | jira_connections schema; không Platform endpoint | Tenant/project persistence | Chưa đăng ký | N/A | Không Platform API test | Shell | API_MISSING |
| 10 Integrations | Test connection/reconnect | Không có route | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 10 Integrations | Safe operational error projection | Credential fields có trong schema; không Platform projection | Tenant integration | Chưa đăng ký | N/A | Không redaction/API test | Shell | API_MISSING |
| 11 Incidents | Incident list/detail/severity/service | Không tìm thấy incident entity/API | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | DOMAIN_MISSING |
| 11 Incidents | Acknowledge/resolve/notes/lifecycle | Không có incident domain/command | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | DOMAIN_MISSING |
| 11 Incidents | Incident history/audit | Không có incident domain/audit model | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | DOMAIN_MISSING |
| 12 Diagnostics | Request trace/lookup | Không có query API; correlation ID chỉ có ở vài command | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 12 Diagnostics | System diagnostics/troubleshooting | Không có Platform endpoint | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không có | Shell | API_MISSING |
| 12 Diagnostics | Redacted diagnostics output | Không có diagnostic projection | PLATFORM yêu cầu | Chưa đăng ký | N/A | Không redaction/API test | Shell | API_MISSING |
| 13 Audit | Bounded audit list | GET /iam/platform/audit | PLATFORM | platform.audit.read | Whitelist + field projection | Repository security test | Có | READY |
| 13 Audit | Actor/action/resource/time filters + pagination | Không có server params; FE lọc local trên tối đa 100 | PLATFORM read partial | platform.audit.read | Giới hạn 100 | Repository list test | UI filter local | PARTIAL |
| 13 Audit | Resource detail/per-resource history | Có resource type/ID, không detail/history | PLATFORM partial | platform.audit.read | Metadata bị loại response | Projection test | Activity list | PARTIAL |
| 13 Audit | Audit cho User status mutation | PATCH /iam/users/:userId tồn tại nhưng không ghi audit | ORGANIZATION | Org admin policy | Không có audit producer | Status tests không khẳng định audit | Platform status chưa có | API_EXISTS_AUDIT_MISSING |
| 14 Account | Current operator identity/permissions | GET /auth/platform/me trả id/email/name/context/permissions | Self / PLATFORM context | Token verified + active context | Read | Controller/application tests | Có | READY |
| 14 Account | Current session status/metadata | /auth/platform/me thiếu session ID/status/expiry/IP/UA | Self, partial | Authenticated Platform context | N/A | Identity tests; metadata contract thiếu | Profile projection hạn chế | PARTIAL |
| 14 Account | Sign out | POST /api/v1/auth/logout, revoke token hiện tại, clear cookies | Self | Authenticated self | Không tìm thấy logout audit | Application/controller tests | Có | READY |

## 23. Missing Backend APIs

1. Platform user list/search/filter, detail, status lifecycle, User-centric memberships/effective permissions.
2. Organization metadata update/lifecycle.
3. Platform membership invite/resend/revoke/remove/restore, role change/history.
4. Platform project directory và safe metadata/access-policy projection.
5. Session list/detail/revoke của user khác, bulk revoke và security events.
6. User/project aggregate, active/inactive summary và operational event feed.
7. Service registry/status/dependency readiness/diagnostics, jobs/queue list/detail/retry/cancel/health.
8. Platform integration list/test/reconnect/redacted error projection.
9. Platform diagnostics/request lookup.
10. Audit server-side filters, pagination, detail và per-resource history.

RAG/AI operational API được phân loại riêng là UNSUPPORTED_BY_CURRENT_ARCHITECTURE, không trộn với API thiếu thuần túy.

## 24. Missing Permissions

Không phát hiện route Platform hiện hữu nào thiếu permission: đủ 8/8 route PlatformController khai báo một trong bảy permission registry. Permission defect trên endpoint đã triển khai: 0.

Capability chưa có API cũng chưa có permission được định nghĩa/đăng ký. Đây là policy/design gap, không phải bằng chứng permission code cụ thể bị bỏ sót. Khi capability được phê duyệt, cần xác định action, resource, scope và người được cấp; không tái sử dụng quyền Organization để làm Platform UI hoạt động.

## 25. Missing Audit Contracts

1. User status mutation qua PATCH /api/v1/iam/users/:userId thiếu audit producer dù API Organization-scope tồn tại.
2. Platform session revoke/security-event audit chưa có do API/domain chưa có.
3. Jobs retry/cancel, integration reconnect/test, incident lifecycle và diagnostics action audit contract chưa có.
4. Platform invitation/revoke/remove/restore/role change chưa có Platform event/API projection. Invitation audit hiện tenant-scope, không vào Platform whitelist.
5. Platform authority grant/revoke có action trong audit reader/producer path nhưng không có HTTP lifecycle route.

Mutation Platform hiện có và đã audited: Organization create, Membership suspend.

## 26. Missing Tests

1. Chỉ 1/8 handler Platform có HTTP integration test trực tiếp; bảy handler còn lại chưa exercise qua đúng route/controller trong tests đã kiểm tra.
2. Platform GET contract cần test 401/403, response schema, pagination/filter, 404 và cache/no-store tại HTTP boundary.
3. Health Platform route cần test handler + permission; evidence hiện chủ yếu route metadata và generic guard/health tests.
4. Không có test cho Platform user/status/session/project/job/queue/integration/incident/diagnostics vì API chưa có.
5. Không tìm thấy 429 coverage cho Platform API trong test đã kiểm tra.
6. Cần assertion audit rõ cho Organization user status; hiện thiếu event là defect, không chỉ test gap.

## 27. FE Integration Gaps

FE src/lib/queries/platform/usePlatformConsole.ts gọi /auth/platform/me, login, Platform organizations GET/POST/detail, user lookup, memberships GET/suspend, health và audit; logout dùng auth endpoint. Các API này có đối ứng backend, trừ sai khác OpenAPI được ghi dưới đây.

FE có Users, Projects, Sessions/Security, Jobs, AI/RAG, Integrations, Incidents và Diagnostics ở dạng placeholder/shell. Organization metadata/lifecycle, invitations và role change cũng chưa có backend Platform API. Dashboard lấy org total và IAM liveness; User/Project count ghi unavailable. Audit filter hiện local trên mảng đã giới hạn.

Không đánh dấu shell là API có sẵn hoặc FE_NOT_CONNECTED khi backend Platform API chưa tồn tại. Với lookup/health/audit/org/membership hiện hữu, FE đã kết nối một phần hoặc đầy đủ theo field hiện có.

## 28. Security Risks

1. **Không dùng tenant route như Platform route.** User/Project/membership APIs Organization-scope có guards riêng; bỏ qua scope tạo cross-tenant access ngoài contract.
2. **Readiness dễ bị hiểu sai.** Gateway /health/ready trả kết quả IAM /internal/health và không kiểm tra DB/queue dependencies.
3. **User status không audit.** Status mutation có thể đổi access mà không có event trail.
4. **Thiếu session administration.** Không thể điều tra/revoke session account khác bằng API hiện tại.
5. **Audit có giới hạn quan sát.** Tối đa 100 records, bốn actions, không filter/history; UI local filter không mở rộng dữ liệu server.
6. **Projection hiện hữu có ranh giới dữ liệu.** Organization summary bỏ settings; user lookup/membership projection bỏ password hash và effective permission arrays; Platform audit bỏ metadata. Repository tests kiểm tra redaction.
7. **Jira credential boundary.** Schema có encrypted credentials/webhook secret. Không có Platform projection; không lấy raw schema làm response contract.
8. **Project content boundary.** Không có Platform API expose documents/chunks/retrieval payload; Project routes nằm sau Organization/Project guards.
9. **Contract drift.** OpenAPI route có thể khiến client gọi endpoint không tồn tại hoặc hiểu sai permission/field contract.

Không ghi nhận Platform read projection hiện trả password/token/raw tenant content; tests projection/audit xác nhận các trường đó bị loại ở endpoint đã kiểm tra.

### OpenAPI discrepancies

- docs/openapi/iam-v1.openapi.json chỉ mô tả POST /iam/platform/organizations, GET /iam/platform/health và GET /iam/platform/audit, nhưng controller còn GET organizations, GET organization detail, POST users/lookup, GET memberships và POST suspend.
- OpenAPI cũng không mô tả GET /api/v1/auth/platform/me trong khi FE gọi route này.
- OpenAPI có PATCH /api/v1/iam/projects/{projectId} và PATCH /api/v1/iam/projects/{projectId}/memberships/{membershipId}; ProjectController không có generic PATCH, ProjectAccessController không có PATCH membership.
- docs/openapi/README.md nói Project hỗ trợ partial update, không khớp controller.
- src/contracts/iam-openapi.spec.ts chỉ kiểm tra ba A-04 Platform permissions/routes và không phát hiện hết các route trên.

## 29. Implementation Backlog

Thứ tự gợi ý theo rủi ro vận hành và dependency; mỗi capability cần policy/API/domain design riêng trước implementation.

**P0**

1. Chốt Platform account/session security: list/revoke other sessions, security event/audit, response redaction, permission và resource-hiding policy.
2. Chốt User directory/detail/status requirements và scope; thêm audit contract cho status mutation hiện tại trước khi mở rộng khả năng quản trị.
3. Sửa readiness semantics/contract để Gateway không báo “ready” chỉ dựa vào IAM liveness.
4. Đồng bộ OpenAPI với tám Platform routes đang chạy và sửa/xóa PATCH Project routes không được implement.

**P1**

1. Quyết định Organization metadata/lifecycle và Membership lifecycle còn thiếu; xác định action scope và safeguards.
2. Nếu yêu cầu Platform project oversight, thiết kế metadata-only projection với Organization association/visibility/access policy; không dùng Organization APIs bằng principal giả.
3. Xác định aggregate dashboard/service readiness, queue/job projection, retry/cancel permission, idempotency, audit và redaction.
4. Thêm HTTP contract/integration tests cho bảy PlatformController handler chưa được exercise tại route boundary.

**P2**

1. Làm rõ SAG/FastAPI ownership/contract cho AI/RAG operational status, index/model health và content-safe projection.
2. Quyết định integration support, incident source of truth/lifecycle và diagnostics/request trace redaction.
3. Mở rộng audit filters/pagination/detail/history theo retention và authorization policy đã duyệt.

## 30. Final Verdict

**Câu hỏi:** “Backend hiện tại đã đủ API cho toàn bộ Platform Administration Console chưa?”

**Trả lời: PARTIAL.**

### BACKEND READINESS

PARTIAL

### CAPABILITY COUNTS

- Total required capabilities: 54.
- Implemented (READY): 5.
- Partial: 14.
- Missing API: 18.
- Missing permission on an existing Platform route: 0. Permissions for missing capabilities are not counted as registered defects.
- Missing audit (primary matrix status): 1, the existing Organization-scoped User status mutation.
- Missing tests (primary matrix status): 1. Separately, 7/8 PlatformController handlers lack direct HTTP integration coverage.
- Wrong scope: 7.
- Domain missing: 5.
- Unsupported by current architecture: 3.
- FE-only missing: User management beyond exact lookup; Organization lifecycle/invitations/roles; project oversight; session/security administration; dashboard aggregates; services/readiness; jobs/queues; AI/RAG; integrations; incidents; diagnostics.
- Unknown: 0.

### PLATFORM API COVERAGE

20 / 54 capability có ít nhất một Platform API hỗ trợ một phần hoặc đầy đủ. Trong đó 5 READY, 14 PARTIAL và 1 có API nhưng thiếu đúng route-level test để kết luận READY. Bảy capability khác chỉ có API Organization/Project scope; không tính vào Platform coverage.

### PERMISSION COVERAGE

8 / 8 route dưới /api/v1/iam/platform có Platform permission và guard. GET /auth/platform/me và POST /auth/logout là self-scoped authentication endpoints. Không phát hiện route Platform thiếu permission. Permission cho API chưa tồn tại chưa được định nghĩa.

### AUDIT COVERAGE

2 / 2 mutation HTTP Platform hiện có ghi audit bắt buộc. Audit reader chỉ hiển thị bốn action, tối đa 100 dòng. Organization user status mutation hiện có nhưng thiếu audit.

### TEST COVERAGE

1 / 8 PlatformController handler có HTTP integration test trực tiếp; 8/8 được kiểm tra static route/permission inventory. Repository/service integration và authorization tests bổ sung được liệt kê ở mục 21. Không chạy tests trong audit.

### SECURITY GAPS

- Không có Platform session revoke/security event API.
- User status mutation Organization-scope thiếu audit.
- /health/ready không kiểm tra dependencies.
- Platform audit thiếu filter/pagination/history; phần lớn route thiếu HTTP contract test.
- Project/Jira/diagnostic future projection phải giữ tenant content và credential secrets ngoài response.

### MISSING PLATFORM APIs

1. User directory/detail/status và User-centric membership/effective permission.
2. Organization metadata/lifecycle và Platform membership invite/remove/restore/role/history.
3. Platform-safe project directory/access metadata.
4. Session/security administration; dashboard aggregates; service/dependency diagnostics.
5. Job/queue admin; integration management; incidents; request diagnostics; audit query/history.

### MISSING PERMISSIONS

1. Không có permission defect trên 8 route hiện hữu.
2. API chưa có cũng chưa có action/scope permission được đăng ký; policy cần phê duyệt trước khi đặt tên code.

### MISSING AUDIT CONTRACTS

1. User status mutation.
2. Future session, job, integration, incident và Platform membership lifecycle mutations.
3. Authority grant/revoke lifecycle chưa có HTTP route dù audit actions đã được reader nhận diện.

### FE-ONLY ITEMS

1. User directory/detail/status/session administration.
2. Project oversight, Organization lifecycle/invitations/role changes.
3. Dashboard User/Project aggregates, service readiness, jobs/queues, AI/RAG, integrations, incidents, diagnostics.

### CRITICAL BLOCKERS

1. Thiếu User/session security administration và audit để quản trị/điều tra account toàn Platform.
2. Platform project-wide API không tồn tại; tenant routes không thể thay thế an toàn.
3. Service readiness/operational APIs chưa đủ cho dashboard vận hành; /health/ready hiện kiểm tra không đủ dependencies.

### RECOMMENDED IMPLEMENTATION ORDER

**P0:** Session/security, User lifecycle + audit, readiness semantics, OpenAPI parity.

**P1:** Organization/Membership lifecycle, safe Platform project metadata, operational dashboard/jobs/queues, controller HTTP tests.

**P2:** AI/RAG operational contract, integrations/incidents/diagnostics, audit query/history.

**Snapshot and delivery:** Báo cáo này là artifact duy nhất được yêu cầu trong audit. Không sửa source, FE, schema, permission, migration hay cấu hình; không tạo commit/branch và không push. Trạng thái .serena/ chưa commit có sẵn trong backend được bảo toàn.
