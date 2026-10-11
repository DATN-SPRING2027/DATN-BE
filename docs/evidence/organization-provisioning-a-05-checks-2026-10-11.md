# DATN-80 / A-05 Organization Provisioning — Acceptance Evidence

Date: 2026-10-11, Asia/Saigon. Jira was read directly: [DATN-80](https://trankimthang0207.atlassian.net/browse/DATN-80), its six children, and [DATN-79](https://trankimthang0207.atlassian.net/browse/DATN-79), including comments and dependencies. The children have no separate description or comments; their titles are checkpoints for the parent scope, not six independent features.

Base: `origin/main`, `38ef95c0f114daf6c5dca35eb0ce9f41102f1c29` (merged A-04 PR #21). Branch: `feat/Phuc-datn-80-organization-provisioning-be-api`.

## Existing implementation and A-05 delta

A-04 already implements `POST /api/v1/iam/platform/organizations`: server-verified active account, fresh `organization.create` evidence at PLATFORM scope, validated input, distinct active first ADMIN, and one transaction for Organization, ACTIVE OrganizationMembership, organization-scoped ADMIN RoleAssignment and `organization.create` audit in the audit database. A-05 reuses this implementation; no second endpoint, new role, permission, schema, migration or policy is introduced.

Authority and implementation sources:

- [Leader-approved DEC-ACCESS-09 A-04 sub-scope](../decisions/dec-access-09-platform-operator-authorization.md).
- [Organization Membership / DEC-016](../decisions/organization-membership-context.md): four approved states; only ACTIVE establishes context.
- [Accepted Project Access & Visibility V1](../decisions/project-access-visibility-v1.md): first-admin access is demonstrated with `project.visibility.manage`, an existing approved Organization ADMIN permission. This is not a blanket content-access grant or a new Organization administration API.
- [IAM OpenAPI](../openapi/iam-v1.openapi.json), [controller](../../src/services/iam/controllers/platform.controller.ts), [service](../../src/services/iam/application/organizations/organization-provisioning.service.ts), [transaction repository](../../src/services/iam/infrastructure/mongodb/organization-provisioning.repository.ts).

The A-04 login HTTP suite now uses the real provisioning service with a mocked repository, adding input boundary, self-bootstrap and permission-denial coverage. The new MongoDB suite runs the real HTTP controller, token verification, active-account lookup, platform guard, authorization evidence provider, service and repository against MongoDB 7.0.41 replica set. Redis token revocation and password login are outside this MongoDB fixture: its security store is stubbed, and the fixture signs synthetic tokens. Existing authentication/guard suites cover those independent boundaries.

## Six-checkpoint mapping

`HTTP` = [platform login/provisioning HTTP suite](../../test/platform-operator-login.e2e-spec.ts). `Mongo` = [A-05 replica-set suite](../../src/services/iam/infrastructure/mongodb/organization-provisioning.mongodb.spec.ts).

| Checkpoint | Already implemented in A-04 | A-05 completion evidence |
| --- | --- | --- |
| [DATN-195 — Organization creation](https://trankimthang0207.atlassian.net/browse/DATN-195) | Existing controller/service/repository and Organization schema | Mongo asserts 201 response, normalized name/slug, timestamps, one Organization, and no extra User/Role/ProjectMembership records. |
| [DATN-196 — First administrator](https://trankimthang0207.atlassian.net/browse/DATN-196) | Existing current ADMIN Role lookup and scoped assignment | Mongo checks correct User/Role/Organization, no Project scope, assignedBy provenance, missing/inactive User and missing Role rejection. HTTP and Mongo reject operator self-bootstrap. |
| [DATN-197 — Membership bootstrap](https://trankimthang0207.atlassian.net/browse/DATN-197) | Existing ACTIVE OrganizationMembership creation | Mongo checks real context resolution for the first ADMIN, no operator context, and denial for PENDING_INVITE/SUSPENDED/REMOVED or missing membership despite retained role evidence. |
| [DATN-198 — Validation and duplicates](https://trankimthang0207.atlassian.net/browse/DATN-198) | Allowlisted input parser, unique slug index, conflict mapping | HTTP tests malformed/missing/oversized fields, documented bounds and injected role/status/tenant. Mongo tests normalized duplicate and concurrent duplicate: one 201, one 409, exactly one committed bootstrap and audit. |
| [DATN-199 — Authorization tests](https://trankimthang0207.atlassian.net/browse/DATN-199) | A-04 platform guard and accepted Project authorization policy | HTTP/Mongo deny invalid credentials, Organization ADMIN claims alone, health/audit-only permission, revoked assignment and unavailable operator account. Persisted first ADMIN permits the documented action only with ACTIVE membership, matching scope/Role and current Role.permissions; removal of that permission denies. |
| [DATN-200 — Integration tests](https://trankimthang0207.atlassian.net/browse/DATN-200) | Earlier A-04 Mongo test covers atomic bootstrap/audit failure | New Mongo suite proves HTTP-to-persistence success/denials, missing configuration, duplicate/concurrent creation, rollback on membership/assignment/audit failure, and transient transaction retry without duplicate records/audit. |

## Parent acceptance criteria

1. Approved records and invariants: success creates exactly one Organization, one ACTIVE membership, one organization-scoped current ADMIN assignment and one audit; operator gains no membership/role. Existing Users and Roles are reused.
2. Safe duplicate/unauthorized/invalid failure: HTTP rejection avoids persistence; Mongo assertions show zero partial bootstrap writes. Duplicate/concurrent requests preserve one committed bootstrap. Membership/assignment failures are injected inside the transaction; audit failure is a real database validator rejection in the disposable audit database. A transient driver error exercises transaction retry.
3. First-admin access: the real membership resolver, evidence provider and accepted Project policy read the records just provisioned. `project.visibility.manage` requires ACTIVE OrganizationMembership and current documented Role.permissions at matching Organization scope. Empty permissions, wrong scope, missing resolved Role or assignment deny. Project creation has its separately accepted membership-only rule; this test does not add a Role gate to Project creation.

## Checks and reproduction

- Focused HTTP suite: **22 passed**.
- Replica-set suites: **18 passed** (17 A-05, 1 existing A-04).
- Mutation experiment: temporarily removed the current Role.permissions gate from the production Project access evaluator. The new first-admin test failed when an empty-permissions Role was allowed. The evaluator was restored byte-for-byte; it has no task diff.
- Full `npm run check` with `INFRA_ENABLED=false`: **PASS** — lint, typecheck, 25 smoke-safety tests, 317 unit tests (21 opt-in tests skipped), 53 E2E tests (4 skipped), and build. No `TS_NODE_TRANSPILE_ONLY` override was used for this final run. Initial run hit the existing IAM bootstrap subprocess's 15-second timeout (52 E2E passed, 4 skipped, 1 failed). Isolated retry and the complete final run passed without changing that test or production source. Existing Mongoose duplicate-index warnings remain outside this delta.

PowerShell, from the DATN-BE repository:

```powershell
$env:INFRA_ENABLED = 'false'
npm run check
npm run test:e2e -- --runInBand platform-operator-login

# Start a disposable local MongoDB 7 replica set before enabling integration.
# The A-05 fixture rejects non-loopback URIs and verifies MongoDB major version/replica set.
$env:MONGODB_INTEGRATION = 'true'
$env:MONGODB_URI = 'mongodb://127.0.0.1:28780/?replicaSet=datn80-rs'
npx jest --runInBand --runTestsByPath src/services/iam/infrastructure/mongodb/organization-provisioning.mongodb.spec.ts src/services/iam/infrastructure/mongodb/platform-operator.mongodb.spec.ts
```

The A-05 fixture does not load `.env`, uses random `datn80_*` databases, drops only those databases after tests and closes connections. Tests ran against a dedicated loopback process with synthetic data. No shared/production database was targeted. Default unit runs skip opt-in MongoDB suites; the 17 A-05 tests were executed separately above.

## Operational follow-ups and tracking

No production code, OpenAPI, schema/index, package dependency or historical migration changes. Test-only audit validator changes are confined to the disposable database. No DB rollout or team notification is required for this delta.

Deployment still requires the already documented A-04 authority collection/index migration, controlled operator assignment, existing active target account and appropriately provisioned current ADMIN Role.permissions. This verification does not apply those operations or claim deployed environment acceptance. DEC-ACCESS-09 remains PARTIAL overall; DEC-ACCESS-10 and ongoing Membership/invitation API details remain separate decisions and are not changed by A-05.

Latest Jira read: DATN-80 To Do; DATN-195–200 In Progress; DATN-79 Done. Agent has not changed status. Recommend In Review for the parent and all six checkpoints once the final checks/review evidence is available; user controls status and acceptance. PR creation remains pending the user's inspection and explicit request; no merge is authorized.
