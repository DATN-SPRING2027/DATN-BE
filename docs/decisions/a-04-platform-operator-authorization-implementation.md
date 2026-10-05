# A-04 Platform Operator Authorization — Implementation Evidence

**Status:** Implemented on `feat/Danh-A-04-platform-operator-authorization-be-api`; awaiting review and operational database rollout.
**Policy authority:** [DEC-ACCESS-09](dec-access-09-platform-operator-authorization.md), A-04 sub-scope DECIDED; DEC-ACCESS-09 remains PARTIAL overall.
**Decision approval evidence:** Leader-approved decision documentation merged in [DATN-BE PR #20](https://github.com/DATN-SPRING2027/DATN-BE/pull/20).
**Implementation PR:** To be linked after publication.

This record classifies implementation evidence and choices. It does not amend
DEC-ACCESS-09, close DEC-ACCESS-10, select a SAGE baseline, or create product
policy.

## Evidence classification

| Class | Evidence | Effect |
|---|---|---|
| **DECISION** | DEC-ACCESS-09, A-04 policy sub-scope. | Human DATN User; separate `PLATFORM_OPERATOR` authority at `PLATFORM` scope; exactly `organization.create`, `platform.health.read`, `platform.audit.read`; no implicit Organization or content access; revoked and expired authority denies. |
| **DECISION** | DEC-ACCESS-09, HTTP semantics. | 401 unauthenticated; 403 authenticated but insufficient authorization; 404 only under an applicable resource-hiding policy. DEC-ACCESS-10 remains open. |
| **FACT** | Current DATN IAM authentication and authorization implementation on main at `7f5737399a4e997f3229e858219eb08daddf994a`. | Existing access-token verification checks the active User, token revocation, and the token’s active Organization Membership. Existing Project guards resolve trusted context and Organization/Project evidence server-side. |
| **FACT** | Current database runtime convention. | IAM owns `continuum_iam`; audit records use `continuum_audit.audit_logs_iam`; `MONGODB_AUTO_INDEX` defaults to false. Existing Project creation uses a Mongo transaction across IAM and audit collections. |
| **DESIGN** | `platform_authority_assignments` in IAM persistence. | One separate record is keyed uniquely by subject User, exact permission, and `PLATFORM` scope. It stores status, grant/revoke attribution and times, optional expiry, and timestamps. It does not reuse Organization assignments or capability grants. |
| **DESIGN** | Platform authorization evidence and guard. | Authentication uses the existing IAM token verification, revocation, and active-user checks through a platform subject method that does not require current Organization membership or use Organization role claims. Every request loads the selected permission’s assignment from MongoDB, evaluates the exact `PLATFORM` scope and lifecycle, requires a valid non-future grant time, rejects self-granted evidence, and ignores role/display/request-header claims. No authority cache or JWT role claim is used. Unknown evidence denies. |
| **DESIGN** | `POST /api/v1/iam/platform/organizations`. | Minimal request fields are `name`, `slug`, `plan`, and a distinct active `firstAdminUserId`, derived from existing Organization/User/Role persistence. The controller is permission-guarded. Organization, first ADMIN membership, first ADMIN role assignment, and `organization.create` audit record share the existing Mongo transaction pattern. The Platform Operator is not made a member or ADMIN. This API shape is implementation design, not an additional business decision. |
| **DESIGN** | `GET /api/v1/iam/platform/health`. | Uses the existing IAM health response (`status: ok`), adds no second health framework, and returns no configuration or secrets. |
| **DESIGN** | `GET /api/v1/iam/platform/audit`. | Reads only `organization.create`, `platform.authority.granted`, and `platform.authority.revoked` operational event types; projects only action, resource identifiers, actor identifier, and time. It never returns mixed event metadata. |
| **DESIGN** | Database rollout. | IAM schema and dev initializer declare the new collection/indexes. A reviewed-hash migration creates only the collection and indexes, and blocks on duplicate or malformed assignments. It does not mutate production records. |
| **UNKNOWN / FOLLOW-UP** | No approved controlled Platform Operator assignment/bootstrap mechanism exists in current DATN code or contracts. | No public grant/revoke API or seed was added. Initial assignment and any controlled lifecycle operation remain an operational follow-up. The audit reader is ready for lifecycle event records; this PR does not invent a lifecycle workflow or event producer. |
| **UNKNOWN / FOLLOW-UP** | DEC-ACCESS-10 problem detail codes/bodies remain open. | Implemented endpoints use existing DATN 401/403/409/422 conventions. Exact shared problem codes and detailed bodies remain subject to DEC-ACCESS-10. |
| **FACT** | SAGE source selection. | [`.sage/config.yaml`](../../../.sage/config.yaml) continues to have no active baseline. This implementation consumes the explicit Leader-approved DEC-ACCESS-09 A-04 decision; it does not infer authority from historical SAGE inventory or review results. |

## Traceability

| From | Relation | To |
|---|---|---|
| A-04 / Jira DATN-79 | governed by | DEC-ACCESS-09 A-04 policy sub-scope and Leader approval merged in PR #20 |
| DEC-ACCESS-09 | constrains | [Platform authorization policy](../../src/services/iam/application/authorization/authorization.policy.ts), [platform evidence provider contract](../../src/services/iam/application/authorization/authorization-evidence.provider.ts), and [Mongo evidence provider](../../src/services/iam/infrastructure/mongodb/authorization-evidence.provider.ts) |
| Platform authority persistence | implemented by | [IAM schemas and persistence indexes](../../src/services/iam/infrastructure/mongodb/mongodb.schemas.ts) and [IAM persistence definition](../../src/services/iam/infrastructure/persistence.ts) |
| `organization.create` | enforced by | [Platform authorization guard](../../src/services/iam/application/authorization/platform-authorization.guard.ts) and [Platform controller](../../src/services/iam/controllers/platform.controller.ts) |
| Organization bootstrap | implemented by | [Provisioning service](../../src/services/iam/application/organizations/organization-provisioning.service.ts) and [Mongo transaction repository](../../src/services/iam/infrastructure/mongodb/organization-provisioning.repository.ts) |
| `platform.health.read` | enforced by | Platform controller, reusing `IamApplicationService.getHealth()` |
| `platform.audit.read` | enforced by | [Safe platform audit query](../../src/services/iam/infrastructure/mongodb/platform-audit.repository.ts) |
| Policy/evidence | verified by | [Policy tests](../../src/services/iam/application/authorization/platform-authorization.policy.spec.ts), [guard HTTP tests](../../src/services/iam/application/authorization/platform-authorization.guard.spec.ts), [evidence freshness tests](../../src/services/iam/infrastructure/mongodb/authorization-evidence.provider.spec.ts), and [MongoDB transaction/audit integration test](../../src/services/iam/infrastructure/mongodb/platform-operator.mongodb.spec.ts) |
| IAM DB collection/indexes | deployed by reviewed operation | [A-04 collection/index migration](../../scripts/migrations/20261005-platform-authority-assignments.mjs) and [migration instructions](../../scripts/migrations/20261005-platform-authority-assignments.README.md) |
| This implementation | delivered through | A-04 implementation PR, to be linked after publication |

## External research / implementation reference

Official Keycloak authorization documentation, Microsoft Entra RBAC role
assignment/scope guidance, and AWS IAM policy evaluation were reviewed only as
implementation references. They support explicit scope, principal/permission
matching, least privilege, and default-deny patterns. No external role names,
permissions, schema, or lifecycle workflow were imported into DATN.

- [Keycloak Authorization Services](https://www.keycloak.org/docs/latest/authorization_services/index.html)
- [Microsoft Entra custom roles overview](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/custom-overview)
- [AWS policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_AccessPolicyLanguage_Interplay.html)

## Validation evidence

- `git diff --check`: PASS.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- Full unit suite: 306 passed, 4 skipped.
- Focused A-04 authorization, authentication, provisioning, Organization-user boundary, and evidence tests: 92 passed.
- Migration plan suite: 62 passed.
- MongoDB 7 replica-set integration for A-04: PASS on a disposable local database; tested immediate revocation, atomic Organization/first-ADMIN/audit creation, safe audit projection, rollback after audit failure, and unique assignment index.
- A-04 migration dry-run/apply: PASS on a disposable local MongoDB database; no production target or data was used.
- E2E: with `INFRA_ENABLED=false`, 30 passed, 4 skipped, and the pre-existing `iam-secret.e2e-spec.ts` failed because repository `.env` repopulates `JWT_SECRET` after the test deletes it. With infrastructure enabled, health/default-entrypoint suites also hit existing Redis/BullMQ `Connection is closed` errors. No E2E result is claimed as PASS.

## Database and operational follow-ups

- Review and apply the A-04 collection/index migration against the intended IAM database using its exact reviewed dry-run hash.
- Establish the separately controlled initial Platform Operator assignment and lifecycle operations when that operational mechanism is authorized; do not use this PR as a public grant/revoke API.
- Define grant/revoke audit event production alongside that controlled mechanism.
- Close DEC-ACCESS-10 independently if exact error codes/bodies are needed; this implementation does not reopen or expand the A-04 policy.
