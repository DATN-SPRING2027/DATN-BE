# DATN-291 — Organization Membership administration follow-up

## Source of truth and readiness

- Branch starts from updated `origin/main` at `d2138f2`; the existing membership list/detail reads remain unchanged.
- The approved Organization Membership contract is authoritative for request/response schemas, authorization, lifecycle, audit, idempotency, quota, and errors.
- Jira follow-up DATN-291 tracks the mutation work and blocks DATN-88 until integration is available.
- Implement the contract-ready admin read flows and ACTIVE membership suspension. V2 invite/resend/cancel handlers are strict and transactional, but remain fail-closed with 503 until the approved A7 notification evidence and A8 coordinated cutover are accepted; no mutation is reported as successful while blocked.
- Keep unsafe recipient acceptance and A7-dependent remove/resume/reinvite/rights-review disabled until the required evidence/provider/cutover prerequisite is accepted and available.
- Legacy roleCode invitation creation, legacy DELETE revoke, and legacy accept must not remain alternate paths around the V2 schema, permissions, versions, idempotency, or audit.

## Ordered implementation plan

1. **Contract and code inventory** — inspect IAM routes, current read authorization, lifecycle schemas, user-status and role-assignment writers, audit/outbox persistence, frontend service, and existing test fixtures.
2. **V2 command boundary** — add strict transport validation and a dedicated application/repository boundary for invitation listing, invite, resend, cancel, and suspend. Resolve current Organization context from the authenticated ACTIVE membership and current ADMIN Role permissions on the server.
3. **Invitation list and gated commands** — read only current, unexpired V2 invitations. Keep V2 invite/resend/cancel schemas, transactional handlers, quota and replay semantics behind the A7/A8 readiness gate; while blocked, return the documented 503 before domain, audit, operation or outbox writes.
4. **Resend/cancel/suspend** — enforce organization-scoped target lookup, version CAS, supported state transitions, self-action policy, last-eligible-ADMIN protection, replay semantics, and one atomic audit/operation record per committed command.
5. **Legacy path cutover** — reject legacy `{email, roleCode}` writes and DELETE revocation; disable legacy acceptance while A7 is blocked, so it cannot create memberships or RoleAssignments outside the accepted flow.
6. **Gateway and contract documentation** — forward Idempotency-Key and expose only the accepted commands; synchronize implemented OpenAPI and work-package status.
7. **Tests alongside each command** — controller strict-schema/auth tests, Mongo replica-set transaction/audit/idempotency/quota/race tests, denied/inactive/cross-org tests, and atomic rollback checks.
8. **FE integration check** — retain the existing C-03 PR branch and existing API service/UI contract; verify the FE request paths match the BE routes. Modify FE only for an evidenced mismatch, then run its full check.
9. **Handoff gates** — run BE `npm run check`, FE `npm run check`, disposable Mongo 7 replica-set integration tests when available, browser smoke when configured, full diff/secret/review checks. Do not push, merge, or mark C-02/C-03 Done from this branch.

## Completion tracking

- [x] Contract and caller inventory complete.
- [x] Existing membership list/detail reads remain unchanged; V2 admin invitation list and recipient invitation list/detail use scoped DTOs.
- [x] V2 invitation command and suspend schemas, authorization, CSRF, idempotency, version and error checks are implemented; invite/resend/cancel and recipient accept return no-write 503 while gates remain blocked.
- [x] Suspend is implemented with ACTIVE state/version CAS, self-action denial, shared Organization ADMIN fence, last eligible ADMIN protection, transactional operation/audit, and unit/controller tests.
- [x] Legacy `{email, roleCode}` writes are rejected, the legacy Organization DELETE/revoke route is removed, and accept only accepts the V2 shape then fails closed.
- [x] Gateway forwarding and OpenAPI synchronized with runtime readiness, permission split, CSRF pair, and recipient DTO privacy.
- [x] MongoDB 7 replica-set integration: 8/8 membership-command tests passed, including audit rollback, duplicate replay, cross-Organization/inactive actor denial, last-ADMIN and cross-writer fence.
- [x] FE PR branch kept intact and its contract/service paths reviewed against the BE routes; FE full check passed (35 files, 255 tests, build).
- [ ] Live FE-to-BE integration and browser smoke remain unverified; no authenticated runtime session/Chrome DevTools MCP was available.
- [ ] Default BE `npm run check` is not fully green in this checkout: 549 unit tests, lint, typecheck, smoke checks and build pass; 58/58 other E2E tests pass, but `test/iam-secret.e2e-spec.ts` is environment-dependent on the local `.env` and fails its missing-secret expectation. Keep the `.env` untouched; verify that suite in an isolated CI environment.
- [ ] Independent human review and final handoff remain pending.

## Explicit blockers

- A7 evidence and operational cutover are not yet accepted. Normal remove, resume, reinvite/rejoin, rights-review, and unsafe first acceptance remain blocked.
- No database migration is planned; lifecycle schema and index foundation already exist on `main`. Any required schema/index change must be proposed as a separate DB task and must not be applied by this implementation.
- User/account/role/assignment writers must share the Organization ADMIN fence and use the contract's eligible-ADMIN predicate before the last-ADMIN guarantee can be considered fully integrated. The known account-status writer now shares it and the replica-set race test passes; any other writer that changes Organization ADMIN eligibility must be audited before the guarantee is declared globally complete.
