# DEC-ACCESS-09 — Platform Operator Authorization

**Status:** DECIDED — bounded A-04 authorization policy baseline
**Decision gate:** A. DECISION CLOSED for the policy scope in this record
**Decision date:** 2026-10-05
**Approval authority:** Leader approval conveyed in the A-04 decision-closure request; the Leader's name was not provided
**Backend source revision reviewed:** main at 1f28bb3143bd216b2a7a107b4ef527ee127baf58
**A-04 branch context before this documentation update:** feat/A-04-platform-operator-authorization at d9f1eeb7e28b3b98b62e3bf53d4cdca435cb5e30

> Leader review approval received on 2026-10-05. This approval closes the A-04 authorization policy baseline described below and authorizes implementation work to proceed in a subsequent implementation PR. It does not approve implementation details or close DEC-ACCESS-10.

This record closes the approved policy scope only. The implementation/persistence contract, assignment workflow mechanics, detailed audit event schema, and DEC-ACCESS-10 problem codes and response bodies remain follow-ups. A-04 authorization enforcement is not implemented by this documentation change.

## 1. Approved decision

### Principal, authority, and scope

- **Principal:** Human DATN User.
- **Authority:** PLATFORM_OPERATOR, separate from Organization roles and Organization membership.
- **Scope:** PLATFORM.
- A PLATFORM_OPERATOR does not thereby become an Organization ADMIN, Organization member, or Project member, and receives no Organization-content access.
- Organization ADMIN does not imply PLATFORM_OPERATOR.
- A person who holds both authorities must hold them separately and each authority is evaluated in its own scope.

### Approved permission set

The complete approved A-04 permission set is exactly:

| Permission code | Approved meaning |
|---|---|
| organization.create | Create an Organization, including the first Organization ADMIN bootstrap as part of that creation workflow. |
| platform.health.read | Read-only platform health and operational-readiness metadata. |
| platform.audit.read | Read platform operational metadata only, subject to the boundary in this decision. |

No additional A-04 permission code is approved here. In particular, platform.configuration.read and platform.configuration.write remain **FUTURE / DECISION_REQUIRED**. Do not introduce platform.admin, system.admin, a broad super-admin permission, or Organization membership/role-management or Organization-content permissions for platform authority.

### Organization creation and first-ADMIN bootstrap

organization.create includes first Organization ADMIN bootstrap as part of the Organization creation workflow. Bootstrap applies only to the first Organization ADMIN.

This bootstrap does not grant the PLATFORM_OPERATOR Organization membership management, Organization role management, later ADMIN replacement, ongoing Organization administration, or Organization-content access.

Organization creation, first ADMIN membership, first ADMIN role assignment, and required audit records must succeed consistently within one provisioning workflow/transaction boundary, according to existing DATN consistency mechanisms. This policy does not define new transaction, API, persistence, or audit implementation mechanics.

### Platform audit and health boundaries

platform.audit.read is limited to **platform operational metadata**. It does not authorize access to Organization security events, private Organization content, Project content, knowledge content, tokens, secrets, credentials, or sensitive security data. This decision does not define a new audit API.

platform.health.read means read-only platform health and operational-readiness metadata. It does not imply configuration write, secret retrieval, credential retrieval, or Organization-content access.

### Grant and revocation policy

- Platform Operator authority is assigned to a Human DATN User through a controlled assignment mechanism.
- Self-grant is not allowed.
- Revoked authority must not authorize requests.
- Expired authority must not authorize requests.
- Revoked or expired authority must not remain effective through stale cache or session state.

The identity of the authorized grant issuer, detailed assignment/approval workflow, expiry duration, public grant/revoke API, and technical cache/session invalidation mechanism are not decided here. Do not infer a PIM/JIT workflow, approval chain, duration, or API.

### Persistence boundary

The business decision is that platform authority is separate and platform-scoped. It must not be represented by the Organization-scoped role_assignments or organization_capability_grants models.

A separate platform authority assignment record is the preferred architecture boundary. Its exact collection/entity, schema, indexes, identifiers, and migration are implementation design decisions, not decisions made in this document. The implementation/persistence contract will be handled in the A-04 implementation work package, with separate DB work if required. This PR authorizes no DB changes.

### HTTP status semantics

For the approved status-code semantics:

- **401** means unauthenticated.
- **403** means authenticated but insufficient authorization.
- **404** applies only when the applicable resource-hiding policy requires hiding resource existence.

DEC-ACCESS-10 is **not closed**. Exact problem codes, response bodies, and detailed error envelopes remain a DEC-ACCESS-10 dependency.

### Decision-field matrix

| Decision field | DECIDED policy | Remaining classification |
|---|---|---|
| Principal | Human DATN User. | Exact server-side identity binding mechanism: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Authority | PLATFORM_OPERATOR, separate from Organization roles and membership. | None for this policy boundary. |
| Permission codes | Exactly organization.create, platform.health.read, and platform.audit.read. | No other code is authorized by A-04. |
| Scope | PLATFORM semantic scope. | Physical field/enum representation: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Allowed actions | Organization create and first-ADMIN bootstrap; read-only platform health/readiness; platform operational audit metadata only. | API shapes and implementation details: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Explicitly denied through platform authority alone | Organization membership/role mutation except first-ADMIN bootstrap; Organization, Project, and knowledge/private content access; implicit Organization ADMIN. | A separate Organization authority may permit its own scoped actions. |
| Grant control | Controlled assignment; self-grant is prohibited. | Specific authorized issuer and workflow: FUTURE DECISION. |
| Revocation | Revoked authority cannot authorize; stale cache/session state cannot preserve its effect. | Propagation and invalidation mechanics: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Expiry | Expired authority cannot authorize. | Expiry duration and whether assignments must be time-bound: FUTURE DECISION. |
| Persistence | Separate platform authority model; no reuse of Organization-scoped role/grant models. | Entity/schema/index/migration: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Provisioning consistency | Organization, first-ADMIN membership/role assignment, and required audit records succeed consistently in one provisioning workflow/transaction boundary. | Existing DATN transaction mechanism and audit producer details: IMPLEMENTATION DESIGN FOLLOW-UP. |
| Audit visibility | Platform operational metadata only, subject to the exclusions above. | Exact event set, API, fields, retention, and redaction: IMPLEMENTATION DESIGN FOLLOW-UP. |
| HTTP semantics | 401 unauthenticated; 403 authenticated but insufficient authorization; 404 only under an applicable resource-hiding policy. | Problem codes, response body, error envelope: DEC-ACCESS-10 DEPENDENCY; DEC-ACCESS-10 remains open. |

## 2. Context and authority evidence

| Class | Evidence | Finding and effect |
|---|---|---|
| APPROVAL | Leader review approval conveyed in the user-provided A-04 decision-closure request on 2026-10-05. | Authority event for this bounded policy decision. The Leader's name was not supplied; no name is inferred. |
| DECISION | product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md, Accepted MVP authorization baseline. | PLATFORM_OPERATOR is a distinct human platform actor; Organization provisioning/first-ADMIN bootstrap is its boundary; platform status grants no default Organization-content access; audit visibility is limited to platform operational metadata. |
| DECISION | product_docs/research-docs/Workspace/00-organization-and-access-contract-readiness.md, DEC-ORG-04. | Organization provisioning and first-ADMIN bootstrap are an approved baseline; self-service Organization creation is outside the MVP model. |
| DECISION / OPEN REGISTER | Same readiness register, DEC-ACCESS-09 and DEC-ACCESS-10. | This artifact records the Leader-approved A-04 policy closure. The separate readiness entry is not edited by this DATN-BE-only PR. DEC-ACCESS-10 remains open for exact error contracts and concealment details. |
| DECISION | docs/decisions/decision-register.md, DEC-002. | Default DENY; a matching explicit DENY overrides a valid ALLOW when the applicable policy source supports explicit DENY. DEC-002 does not itself define the A-04 permission codes or storage. |
| DESIGN, not a platform schema decision | Generic role/assignment guidance in the actor baseline. | Generic records mention subject, scope, validFrom, optional validUntil, assignedBy, and an audit reference; expired/revoked grants have no effect. This does not define the platform assignment schema or workflow. |
| FACT | DATN-BE/src/services/iam/infrastructure/mongodb/mongodb.schemas.ts. | Existing Organization roles are ADMIN, TEAM_LEADER, and MEMBER; current role_assignments and organization_capability_grants are Organization-scoped. No platform authority record exists. |
| FACT | DATN-BE authorization policy/evidence provider and Mongo authorization evidence provider. | Existing evaluation covers Organization and Project contexts; no Platform Operator runtime authority path is implemented. |
| FACT, HISTORICAL | Earlier SAGE IAM review records, including authorization-foundation-be-20260929.json and authorization-foundation-be-pr9-expiry-20260929.json. | Dated review evidence only; it is not the Leader approval recorded here and does not authorize this decision. |
| EXTERNAL RESEARCH | Official Keycloak, Microsoft Entra, and AWS references in section 12. | Comparative evidence for architecture rationale only; it is not DATN authority. |

The earlier evidence-only A-04 review recorded missing decision authority and a blocked gate at that time. That historical finding is retained as the state of the earlier review, not as the current decision status. The Leader approval above is the later authority event for the bounded policy scope in this revision.

## 3. Security invariants

1. Default DENY applies; missing, malformed, expired, revoked, or untrusted evidence cannot produce ALLOW.
2. PLATFORM_OPERATOR is not Organization ADMIN and is not Organization Membership.
3. Organization ADMIN does not imply PLATFORM_OPERATOR.
4. Platform authority alone grants no Organization, Project, or knowledge/private-content access.
5. Organization-scoped operations continue to require the applicable active Organization Membership, trusted Organization Context, and scope checks.
6. A FE title/display state is not authorization.
7. Arbitrary request headers are not authorization.
8. Unverified token claims are not authorization.
9. Revoked/expired authority cannot remain effective through stale cache/session state.
10. Explicit DENY precedence follows DEC-002 where an applicable policy source represents that deny.

## 4. Action matrix

The matrix distinguishes an **explicit policy DENY through platform authority alone** from an action that is simply **not authorized by A-04**. “FUTURE / DECISION_REQUIRED” is not a newly declared DATN deny rule. Under DEC-002, an unapproved action still cannot produce ALLOW until its policy is decided.

| Area | Action | A-04 disposition | Approved permission / boundary |
|---|---|---|---|
| Organization lifecycle | Create Organization | ALLOW | organization.create; platform provisioning workflow. |
| Organization lifecycle | Bootstrap first Organization ADMIN | ALLOW | Included only in organization.create; first ADMIN only, within the same provisioning workflow. |
| Platform operations | Read platform health/readiness | ALLOW | platform.health.read; read-only operational metadata. |
| Platform operations | Read platform audit metadata | ALLOW | platform.audit.read; platform operational metadata only. |
| Organization administration | Mutate Organization membership through platform authority | EXPLICIT DENY through platform authority alone | First-ADMIN bootstrap above is the only approved provisioning exception; no ongoing membership management. |
| Organization administration | Mutate Organization roles through platform authority | EXPLICIT DENY through platform authority alone | First-ADMIN role assignment is part of bootstrap; no later role management or ADMIN replacement. |
| Organization access | Access Organization content through platform authority | EXPLICIT DENY through platform authority alone | No Organization-content access or implicit Organization membership/ADMIN. |
| Project access | Access Project content through platform authority | EXPLICIT DENY through platform authority alone | No Project membership or content access follows from platform authority. |
| Knowledge access | Access knowledge/private content through platform authority | EXPLICIT DENY through platform authority alone | No knowledge, evidence, or private-content access. |
| Platform configuration | Read platform configuration | FUTURE / DECISION_REQUIRED | platform.configuration.read is not approved; values and sensitive/secret boundary are undefined. |
| Platform configuration | Write platform configuration | FUTURE / DECISION_REQUIRED | platform.configuration.write is not approved; mutable settings boundary is undefined. |
| Organization lifecycle | Initialize Organization as a separate action | FUTURE / DECISION_REQUIRED | Work inseparable from approved create/bootstrap remains within the provisioning workflow; no separate action permission is defined. |
| Organization lifecycle | Suspend, reactivate, delete, or decommission Organization | FUTURE / DECISION_REQUIRED | No separate lifecycle authority is approved. |
| Organization administration | Inspect general Organization metadata, users, directory, or membership | FUTURE / DECISION_REQUIRED | No general inspection authority is approved; access necessary to perform the approved provisioning workflow is not a general read grant. |
| Organization administration | Read Organization roles | FUTURE / DECISION_REQUIRED | No general role-inspection authority is approved. |
| Other administration | Change authorization policy, perform emergency recovery, impersonation, or elevation | FUTURE / DECISION_REQUIRED | No such authority or workflow is approved. |

## 5. Scope and identity model

| Field | Decision |
|---|---|
| Authority scope | PLATFORM, distinct from Organization, Project, and Team scopes. |
| User identity | Human DATN User; the runtime must use trusted server-side authenticated identity/evidence. |
| Organization target during create | The target Organization belongs to the provisioning operation; it does not narrow the platform authority or create Organization membership/content access for the operator. |
| Coexisting Organization authority | A separate active Organization Membership and Organization-scoped authority is required when the same human acts as an Organization user. |
| Untrusted inputs | UI labels, arbitrary headers, and unverified token claims cannot establish platform authority. |

Exact identity-provider mapping and request contract are **IMPLEMENTATION DESIGN FOLLOW-UPS**. They do not alter the approved principal, authority, or scope boundary.

## 6. Grant and revocation follow-up

The policy decisions are controlled assignment, no self-grant, and no authorization by revoked or expired authority. The technical realization remains open:

| Follow-up | Classification |
|---|---|
| Name the role or process authorized to issue/revoke a platform assignment; define any approval chain | FUTURE DECISION |
| Decide whether assignments are permanent or time-bound and choose a duration if time-bound | FUTURE DECISION |
| Define assignment states/transitions and disabled/deleted-user handling | IMPLEMENTATION DESIGN FOLLOW-UP, subject to any required future policy decision |
| Ensure revocation/expiry immediately stops authorization despite cache/session state | IMPLEMENTATION DESIGN FOLLOW-UP |
| Define any grant/revoke API, if one is needed | IMPLEMENTATION DESIGN FOLLOW-UP; no public API is authorized by this decision |

No PIM/JIT workflow, approval chain, expiry duration, or public grant/revoke API is inferred here.

## 7. Persistence boundary and follow-up

Platform authority is not represented through Organization-scoped role_assignments or organization_capability_grants. A separate platform authority assignment record is the preferred model. Exact persistence remains implementation design:

- collection/entity and schema;
- identifier and persisted scope representation;
- indexes, uniqueness, idempotency, and concurrent assignment behavior;
- migration or backfill, if required;
- assignment lifecycle fields and ownership.

The implementation/persistence contract will be handled in the A-04 implementation work package, with separate DB work if required. This PR makes no schema or migration change.

## 8. Provisioning consistency and audit follow-up

Organization creation, first-ADMIN membership, first-ADMIN role assignment, and required audit records must succeed consistently as one provisioning workflow/transaction boundary, according to existing DATN consistency mechanisms. No new implementation mechanics are defined here.

The approved audit visibility is limited to platform operational metadata. Exact event names, fields, redaction, retention, API, transaction/outbox producer, and ownership are **IMPLEMENTATION DESIGN FOLLOW-UPS**. This decision does not define a new audit API and grants no visibility into Organization security events or sensitive data.

## 9. HTTP semantics and DEC-ACCESS-10 dependency

The approved status meanings are recorded in section 1: 401 for unauthenticated, 403 for authenticated but insufficient authorization, and 404 only where the applicable resource-hiding policy requires concealing resource existence.

DEC-ACCESS-10 remains open. Exact problem codes, response bodies, detailed error envelope, and the applicable resource-hiding policy are not closed by this document.

## 10. Consequences and implementation boundary

- The A-04 policy baseline is decided and may be implemented in a subsequent, separately reviewed PR.
- No backend authorization enforcement, guards, controllers, services, schemas, indexes, seed, FE behavior, or production-data changes are included here.
- Implementations must use only the three approved permission codes and preserve the approved scope/content boundaries.
- The separate assignment persistence, controlled grant/revoke mechanism, stale-state invalidation, audit producer, and API/error details must follow the classified items above.
- Configuration permissions remain future decisions.
- DEC-ACCESS-10 remains open where exact error details or resource-hiding policy are needed.

## 11. Historical alternatives and rationale

| Alternative | Disposition | Rationale |
|---|---|---|
| Treat Organization ADMIN as PLATFORM_OPERATOR, or vice versa | REJECTED | Conflates platform and Organization authority. |
| Treat PLATFORM_OPERATOR as Organization membership | REJECTED | Contradicts the approved platform-scoped boundary. |
| Grant Organization/private content access from platform authority | REJECTED | Platform provisioning must not imply content access. |
| Reuse Organization-scoped role/grant records for platform authority | REJECTED | Their Organization scope does not represent platform authority. |
| Use UI display state, arbitrary headers, or unverified claims as authority | REJECTED | These are not trusted authorization evidence. |
| Add a broad super-admin permission | REJECTED | It would combine approved and unapproved actions and erase least-privilege boundaries. |
| Import external product roles, schema, or lifecycle | REJECTED | External research cannot decide DATN policy. |

Separate Platform Operator authority is approved because platform provisioning is a platform concern while Organization administration belongs to Organization authority; combining them conflates privilege and scope. Provisioning must not imply content access, and action-specific permissions preserve least privilege.

Configuration permissions are not approved because the visible/mutable configuration boundary, especially for secrets and sensitive values, is undefined. First-ADMIN bootstrap is part of Organization creation because it initializes a usable Organization; it applies only to the first ADMIN and does not establish ongoing Organization administration authority.

## 12. EXTERNAL RESEARCH / COMPARATIVE EVIDENCE

External research supports the architectural rationale only: separate platform from tenant scope, name explicit permissions, apply least privilege/default deny, and consider assignment lifecycle/audit. It is not DATN decision authority. No external product name, schema, lifecycle, or permission code is imported into DATN.

| Source | Comparative evidence only |
|---|---|
| [Keycloak Server Administration Guide 26.8.0](https://www.keycloak.org/docs/26.8.0/server_admin/) | Separates server-level and realm-scoped administration and describes fine-grained administrative permissions. |
| [Microsoft Entra custom roles overview](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/custom-overview) | Separates permission sets from assignment principal and scope. |
| [Microsoft Entra PIM assignment](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-add-role-to-user) and [audit log](https://learn.microsoft.com/en-us/entra/id-governance/privileged-identity-management/pim-how-to-use-audit-log) | Illustrates assignment lifecycle and audit concepts that require explicit DATN choices. |
| [AWS IAM best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) | Comparative least-privilege guidance. |
| [AWS policy evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_AccessPolicyLanguage_Interplay.html) | Comparative implicit/explicit deny evaluation. |
| [AWS IAM/STS CloudTrail integration](https://docs.aws.amazon.com/IAM/latest/UserGuide/cloudtrail-integration.html) | Comparative audit integration example. |

## 13. SAGE traceability and decision history

### Traceability

| From | Relation | To |
|---|---|---|
| [A-04 / Jira DATN-79](https://trankimthang0207.atlassian.net/browse/DATN-79) | requires | [DEC-ACCESS-09 readiness entry](../../../product_docs/research-docs/Workspace/00-organization-and-access-contract-readiness.md) |
| DEC-ACCESS-09 | governed by | [Accepted actor baseline](../../../product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md) and DEC-ORG-04 in that readiness register |
| A-04 / DEC-ACCESS-09 | governed by | [DEC-002 default-DENY and supported explicit-DENY precedence](../../../docs/decisions/decision-register.md) |
| Leader approval, 2026-10-05 | authorizes policy closure | Bounded approved policy in sections 1 and 4 of this record |
| A-04 policy closure | documentation source for | Subsequent A-04 implementation work package / separate implementation PR |
| This decision record | compares | Official external research in section 12; sources are non-authoritative |
| Earlier A-04 proposal | historical evidence only | [Evidence-only proposal](a-04-platform-operator-authorization-proposal.md); it is not rewritten as approval |
| DEC-ACCESS-09 | remains dependent on | DEC-ACCESS-10 exact problem codes, response bodies, and resource-hiding policy |

### Approval and history

- **Authority event:** Leader review approval received on 2026-10-05, conveyed in the user-provided “A-04 DECISION DOCUMENT UPDATE ONLY” request.
- **Approved target scope:** Human DATN User; separate PLATFORM_OPERATOR authority at PLATFORM scope; exactly the three permission codes in section 1; first-ADMIN bootstrap and content/audit/health boundaries; controlled assignment, no self-grant, revoked/expired fail-closed behavior; separate platform persistence boundary; and the status-code meanings recorded above.
- **Approval identity:** The Leader's name was not provided and is not inferred.
- **Approval limit:** This records policy approval; it is not approval of a specific schema, code revision, API body, implementation, or closure of DEC-ACCESS-10.
- **Prior review trail:** The earlier evidence-only A-04 review at branch context d9f1eeb7e28b3b98b62e3bf53d4cdca435cb5e30 was self-reviewed, recorded no approval, and had a blocked gate at that time. That historical record is retained; it is superseded only as to the policy scope explicitly approved above.
- **SAGE source selection:** The SAGE baseline remains null in [SAGE config](../../../.sage/config.yaml). Historical review records remain review evidence, not this approval. SAGE traceability is recorded here with ordinary linked relations; no historical SAGE records or baseline selection were changed.

### Work record

- **Task / mode / date:** A-04 DEC-ACCESS-09 decision documentation closure; documentation-only; 2026-10-05.
- **Authority reference:** Leader approval as conveyed in the user-provided task request; no Leader name was given.
- **Read scope:** SAGE project context and Governance Model; DEC-002; DEC-ORG-04, DEC-ACCESS-09 and DEC-ACCESS-10 readiness entries; accepted actor/authorization baseline; relevant DATN-BE decision and IAM evidence; official external references for comparison only.
- **Write scope:** This decision artifact only. No source code, guards, controllers, services, schemas, indexes, seed, migration, FE, production data, other decisions, SAGE historical record, or product authority document was edited.
- **Historical evidence review:** Earlier A-04 proposal and historical SAGE review records were retained as non-approving evidence.
- **Decision result:** DECIDED for the bounded policy scope in sections 1 and 4. Remaining matters are individually classified as FUTURE DECISION, IMPLEMENTATION DESIGN FOLLOW-UP, or DEC-ACCESS-10 dependency.
- **Implementation status:** Not started by this documentation change. No implementation commit is recorded.
- **Validation and delivery:** Documentation-only validation and Git/PR details are recorded in the PR and final handoff.
