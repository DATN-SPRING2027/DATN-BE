# Visibility completion amendment — 2026-10-14

> **Current Project MVP policy — 2026-10-20:** [Project MVP contract V1 in the sibling Document repository](../../../Document/research-docs/Workspace/13-project-mvp-contract-v1.md) supersedes conflicting Project-specific decisions below. Project-scoped Leaders may update name/description and both visibility directions with their exact permission. Leader list/appointment remains Organization Admin-only. A Project may have zero or multiple Leaders.

The requester authorized resolving all blockers and completing the visibility UI
following the approved bidirectional mutation. GET on the existing visibility
path now provides a read-only access signal using exactly the existing PATCH
guard and permission policy. 200 returns {canManageVisibility:true}; 403 is denial.
It neither mutates nor grants a later PATCH. No new authorization rule, role,
schema, permission provisioning or database migration is introduced. This resolves
the pre-mutation permission-signal gap and supersedes the earlier no-GET restriction
below. FE enables actions only after a fresh API allow response and still handles
mutation denial; no client role/ownership inference is allowed. Both PRIVATE to
PUBLIC and PUBLIC to PRIVATE retain the approved transaction and audit behavior.

---

# Minimal visibility amendment — 2026-10-14

The requester approved minimal backend changes allowing PUBLIC to PRIVATE as well
as PRIVATE to PUBLIC. This amendment supersedes only the historical one-way
restriction below. Both directions use the existing PATCH visibility endpoint,
project.visibility.manage permission, Organization-scoped ADMIN assignment,
ACTIVE OrganizationMembership and transactional PROJECT_VISIBILITY_CHANGED audit.
A same-state request returns 409 after authorization. Archived, cross-organization
and unauthorized requests retain existing fail-closed semantics. There is no
schema, migration, permission provisioning or new endpoint. Existing OpenAPI
operation/schema identifiers are retained for client compatibility; the visibility
request now accepts the existing ProjectVisibility enum.

PUBLIC to PRIVATE removes metadata access granted solely by PUBLIC visibility;
content ACLs are unchanged. Clients must revalidate Project reads after that change.
The accepted contract still has no pre-mutation permission signal; this gap remains
flagged and must not be filled by roles/client state or a new capability endpoint.

Verification of this amendment: lint/typecheck, 25 development smoke-safety tests,
468 enabled unit tests, the disposable MongoDB mutation/audit integration test and
production build passed. E2e passed 55 tests with infrastructure disabled from a
working directory without .env. The repo-root npm run check exposes the existing
missing-JWT test environment issue: ConfigModule reloads JWT_SECRET from the
development .env after the test deletes it. Runtime configuration was not changed.
No development Project data, schema or permission records were changed. All code
changes remain local; no branch, commit, push or PR was created for this amendment.

---

# Project Access & Visibility V1 — work package decision

**Status:** Accepted V1 business decisions and authorization mapping; permission provisioning is tracked as a separate DB work package.
**Decision date:** 2026-10-02
**Authority:** Requester's SAGE Decision Closure in the task conversation.

## Scope

This decision adds Project visibility and Project Membership management to the accepted Project Foundation create/list/detail contract. It does not change project creation, the existing `project.read` rule, nested Project content ACLs, Team behavior, or database role codes.

## Accepted role mapping

- `Leader Tổng` is the current `ADMIN` RoleAssignment at Organization scope. Do not create `LEADER_TONG`.
- `Leader Project` is the current `TEAM_LEADER` RoleAssignment at Project scope. Do not create `LEADER_PROJECT`.
- An authenticated actor must have an active User and `ACTIVE` OrganizationMembership in the trusted Organization Context.
- A Project Leader must also have `ACTIVE` ProjectMembership and a project-scoped RoleAssignment whose current Role code matches the assignment.
- Authorization uses the resolved `Role.permissions` value at the assignment's required scope. Role names alone never grant Project administration.

## Permission codes

The following exact V1 action codes are used with the existing `Role.permissions` model:

| Permission | Required assignment | Allowed operation |
|---|---|---|
| `project.update` | Project-scoped `TEAM_LEADER` with active ProjectMembership | Update only Project name and description. Organization `ADMIN` does not gain this action by role name. |
| `project.visibility.manage` | Organization-scoped `ADMIN`, or Project-scoped `TEAM_LEADER` with active ProjectMembership | Transition an active Project between `PRIVATE` and `PUBLIC`. |
| `project.leader.manage` | Organization-scoped `ADMIN` | Assign, replace, or revoke a project-scoped `TEAM_LEADER` appointment for active Project members. |
| `project.members.list` | Project-scoped `TEAM_LEADER` | List members for that Project. |
| `project.members.add` | Project-scoped `TEAM_LEADER` | Add an active Organization member as an ordinary Project `MEMBER`. |
| `project.members.remove` | Project-scoped `TEAM_LEADER` | Deactivate ProjectMembership for a member in that Project. |
| `project.members.role.change` | Disabled in V1 | No role-change operation is authorized or exposed. Do not provision this permission. |

`ADMIN` at Organization scope grants Project metadata reads and the explicit visibility and Project Leader actions provisioned to that Role. It does not grant Project detail update or Project Membership list/add/remove by implication. `TEAM_LEADER` at Project scope may use only the exact Project permissions provisioned to its Role when scope and active membership evidence are valid. `TEAM_LEADER` never authorizes appointment/change/revocation of another Project Leader or assignment beyond its permission ceiling. Those appointment operations require an Organization-scoped `ADMIN` assignment and `project.leader.manage`.

## Visibility

- New Projects remain `PRIVATE`.
- Current Project MVP authorizes `PRIVATE` → `PUBLIC` and `PUBLIC` → `PRIVATE` through `project.visibility.manage`.
- The existing public-read rule remains read-only Project metadata for authenticated Users with `ACTIVE` OrganizationMembership in the same trusted Organization. It does not authorize nested resources or expose private/internal content.
- Both visibility directions are audited mutations. A mutation requires an active Project, active Organization context, and a current matching `ADMIN` assignment at Organization scope or `TEAM_LEADER` assignment at Project scope, with `project.visibility.manage` in the resolved Role. Project Leaders also require active ProjectMembership. Same-state requests conflict after authorization.

## Membership operations

- Membership add targets must be active Users with `ACTIVE` OrganizationMembership in the Project's Organization. The created ProjectMembership is `ACTIVE` and receives the existing current `MEMBER` RoleAssignment; this is the least-privilege ordinary-member default and does not create a leader appointment.
- Removal changes ProjectMembership to `INACTIVE`; it does not delete the membership or RoleAssignment. Every Project-scoped authorization must continue to require an `ACTIVE` ProjectMembership, so removal immediately removes effective Project access while preserving records.
- Organization-scoped `ADMIN` does not implicitly authorize Project Membership list/add/remove. These operations require the actor's own `ACTIVE` ProjectMembership, project-scoped `TEAM_LEADER` RoleAssignment resolving to the current `TEAM_LEADER` Role, and the exact corresponding `Role.permissions` code.
- Project Leaders may list, add, and remove members. They may not assign `TEAM_LEADER`, revoke/change another Leader Project, change a role to create/change a Leader Project, or elevate themselves.
- `project.members.role.change` is disabled in V1 and must not be provisioned. No member-role change operation is enabled in the V1 API. Any future role transitions require a separate decision.
- A Project Leader appointment can only target a User who already has `ACTIVE` OrganizationMembership and `ACTIVE` ProjectMembership for the exact Project. The decision does not create either membership as a side effect of appointing a leader.
- A Leader change atomically replaces one current Project Leader with a different active Project member who has a current project-scoped `MEMBER` RoleAssignment. It changes two assignments and no memberships. Multiple Project Leaders may otherwise remain appointed.
- All Project Access V1 endpoints fail closed for an archived Project, including member listing. This is a conservative implementation choice; archive read and mutation behavior remains unresolved outside this V1 decision.

## API contract and audit

The current Project MVP contract supports:

- returning Project metadata and stored `visibility`;
- patching only supplied `name` and/or `description` under `project.update`;
- permission-backed visibility mutations in either direction;
- Project member list/add/remove operations;
- listing and assign/replace/revoke Project Leaders for Organization Admins.

Archive/restore/delete and generic member role transitions remain outside this MVP. The OpenAPI's proposed membership `PATCH` remains explicitly proposed and is not enabled. Zero or multiple Project Leaders are valid.

All enabled Project settings, visibility, Leader, and Project Membership mutations persist to `continuum_audit.audit_logs_iam`, following ADR-003/DEC-011. Required actions include `PROJECT_SETTINGS_UPDATED`, `PROJECT_VISIBILITY_CHANGED`, `PROJECT_LEADER_ASSIGNED`, `PROJECT_LEADER_CHANGED`, `PROJECT_LEADER_REVOKED`, `PROJECT_MEMBER_ADDED`, and `PROJECT_MEMBER_REMOVED`. `PROJECT_MEMBER_ROLE_CHANGED` is not enabled because role changes are out of MVP. IAM and audit writes use a shared MongoDB client session and require replica-set integration verification.

The existing audit event shape supports `organizationId`, `projectId`, `actorUserId`, `action`, `targetResource`, `targetResourceId`, optional `metadata`, and `occurredAt`. No new audit fields are introduced here. The contract does not define before/after role values, target-user snapshot semantics, retention, or indexes. Implementations use only the existing fields and stable Project, ProjectMembership, or RoleAssignment IDs; they do not claim an event records a before/after diff. A leader replacement emits `PROJECT_LEADER_CHANGED` for each of the two affected RoleAssignment IDs. This persists the mutation and both affected assignment identities; the existing contract has no approved snapshot or correlation field.

## Persistence and provisioning

- Existing Project visibility schema and ProjectMembership/RoleAssignment unique indexes are reused; this decision creates no new role code or schema.
- Runtime permission checks fail closed if the required current Role, matching assignment, scope, membership, or permission is missing or stale.
- The repository has no system Role seed/provisioning path; `Role.permissions` defaults to an empty array. The exact desired codes are accepted here. The separate [DB work package](../work-packages/project-access-permission-provisioning-v1.md) defines how to add them idempotently to the existing `ADMIN` and `TEAM_LEADER` Role records without creating duplicate roles or changing a runtime database in this BE task.
- Until the separate DB work package is implemented and applied through its own DB branch/PR and environment workflow, actions fail closed where provisioned `Role.permissions` lack the required code. No live database, schema, seed, or migration was changed here.

## Tests and boundaries

Tests must cover the allow/deny matrix in this decision, including visibility for ordinary members, Project Leaders, and Organization ADMIN; explicit ADMIN denial for membership management; cross-Organization/Project scope; inactive memberships; self-escalation; attempted Project Leader changes by a Project Leader; and persisted audit events for every enabled mutation. Team, Team Membership, task/content authorization, new deny storage, new persistent roles, and generic Project member-role transitions remain outside this decision.

## External research (non-authoritative)

| System | Documented fact | Source | DATN relevance |
|---|---|---|---|
| GitHub Projects | Organization-level Project admins can manage access for the organization; base permissions distinguish no access, read, write, and admin, while organization owners are also admins. | [Managing access to your projects](https://docs.github.com/en/enterprise-cloud%40latest/issues/planning-and-tracking-with-projects/managing-your-project/managing-access-to-your-projects) | Shows organization-level administration can coexist with narrower project access levels. It does not define DATN's ADMIN mapping. |
| Jira Cloud | Team-managed projects use project roles whose permissions are configurable and assigned to people; role permissions apply to members assigned that role. | [Manage access to a team-managed project](https://support.atlassian.com/jira-software-cloud/docs/manage-how-people-access-your-team-managed-project/) | Supports keeping role-assignment scope and permission evaluation explicit. It does not authorize a DATN permission code. |
| Asana | Project visibility distinguishes members-only, team-only, and organization-wide access; the privacy setting affects who can access project content. | [Project privacy settings](https://help.asana.com/s/article/project-privacy-settings) | Confirms visibility is an access boundary that must remain separate from content ACL decisions. Asana's content behavior is not DATN's policy. |

These official product sources are external practice only. The requester's decisions above remain the authority for DATN.
