# Authorization Foundation: documented minimum

The backend authorization evaluator is wired to `POST /api/v1/iam/projects`.
For this route, the requester-approved decision in
[`project-create-active-membership-v1.md`](decisions/project-create-active-membership-v1.md)
supersedes the older role and capability-grant rule for `project.create` only.

## Governing rules

- `docs/decisions/ORGANIZATION-MEMBERSHIP-CONTEXT-DECISION-V1.md` (DEC-016): only an `ACTIVE` Organization Membership establishes Organization Context; RoleAssignment alone does not prove membership.
- `docs/decisions/decision-register.md` (DEC-002): default deny; a matching explicit deny from a source that supports deny takes precedence; otherwise allow requires valid positive evidence. `DENY`, `UNKNOWN`, and missing evidence refuse access.
- `product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md` records the previous `project.create` role/grant baseline. That rule is superseded for this permission only by the accepted work-package decision. Other capabilities and their grant policies are unchanged.
- `docs/openapi/iam-v1.openapi.json` keeps the accepted Project paths, payloads, validation and error mappings. Its `POST /projects` security description now requires an authenticated User, trusted matching Organization Context and `ACTIVE` Organization Membership; it does not require a role or `project.create` grant.

## `project.create` evaluation

The policy requires an active authenticated User, a valid matching trusted Organization Context, an `ACTIVE` Organization Membership for that User and Organization, and `CLEAR` deny evidence. A request with no membership, a non-`ACTIVE` membership, mismatched membership evidence, invalid context, or `DENY`/`UNKNOWN` evidence is denied. No RoleAssignment, Role record, or `organization_capability_grants.project.create` record is loaded or required.

The guard revalidates the User and active membership through the existing authentication service. It rejects any client-provided Organization selector that differs from the trusted context. Project payload validation, unique `(organizationId, code)` enforcement, and the transactional `project.create` event in `audit_logs_iam` remain required.

The current [`PROJECT_CREATE_BOOTSTRAP_V1`](decisions/project-create-bootstrap-v1.md), reaffirmed on 2026-10-04, supersedes the later creator Member bootstrap rule. Creation writes only the `PRIVATE` Project and its `project.create` audit event in one transaction. It creates no ProjectMembership, project-scoped RoleAssignment, Team, Project Leader appointment, owner, or special project role. Project Create authorization remains unchanged; it still requires an authenticated active subject, trusted matching Organization Context, and `ACTIVE` Organization Membership. Private Project reads continue to use the existing Project Access policy; `createdBy` is not access evidence.

## Other grants and open work

Existing capability-grant issuance data and any policy for a capability other than `project.create` remain unchanged. Historical `project.create` grant records are preserved but no longer authorize Project creation. This change adds no grant API, schema, migration, or role-permission mapping.

Future deny-capable sources must be added to the evidence provider before their deny rules can be effective. No deny representation is inferred from Organization Membership or another source that lacks one.
