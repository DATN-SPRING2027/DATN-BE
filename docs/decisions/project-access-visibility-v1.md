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
| `project.visibility.manage` | Organization-scoped `ADMIN` | Transition a Project from `PRIVATE` to `PUBLIC` only. |
| `project.leader.manage` | Organization-scoped `ADMIN` | Assign, replace, or revoke a project-scoped `TEAM_LEADER` appointment for active Project members. |
| `project.members.list` | Project-scoped `TEAM_LEADER` | List members for that Project. |
| `project.members.add` | Project-scoped `TEAM_LEADER` | Add an active Organization member as an ordinary Project `MEMBER`. |
| `project.members.remove` | Project-scoped `TEAM_LEADER` | Deactivate ProjectMembership for a member in that Project. |
| `project.members.role.change` | Disabled in V1 | No role-change operation is authorized or exposed. Do not provision this permission. |

`ADMIN` at Organization scope grants only the two listed V1 permissions. It does not grant Project Membership list/add/remove or role-change operations by implication. `TEAM_LEADER` at Project scope grants only the three listed membership operations when all scope and membership evidence is valid. `TEAM_LEADER` never authorizes self-escalation, appointment/change/revocation of another Project Leader, or assignment beyond its permission ceiling. Those appointment operations require an Organization-scoped `ADMIN` assignment and `project.leader.manage`.

## Visibility

- New Projects remain `PRIVATE`.
- V1 authorizes `PRIVATE` → `PUBLIC` only. `PUBLIC` → `PRIVATE` is `UNKNOWN` and must not be implemented by this decision.
- The existing public-read rule remains read-only Project metadata for authenticated Users with `ACTIVE` OrganizationMembership in the same trusted Organization. It does not authorize nested resources or expose private/internal content.
- Only `PRIVATE` → `PUBLIC` is a V1 mutation. `PUBLIC` → `PRIVATE` remains `UNKNOWN` and is not implemented.
- A visibility mutation requires the current Project to be `PRIVATE`, active Organization context, an Organization-scoped `ADMIN` assignment, and `project.visibility.manage` in the resolved Role. Project membership is not required for this Organization-scoped action. A Project-scoped `TEAM_LEADER` cannot publish by role name or scope alone.

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

The accepted V1 contract is limited to:

- returning the existing stored `visibility` value in Project responses;
- a visibility-only mutation for the approved `PRIVATE` → `PUBLIC` transition;
- Project member list/add/remove operations;
- assign/replace/revoke Project Leader operations.

Project metadata update, archive/restore, all member role transitions, and `PUBLIC` → `PRIVATE` remain outside the accepted contract. The OpenAPI's proposed membership `PATCH` remains explicitly proposed and is not enabled by this decision.

All enabled V1 visibility, Leader Project, and Project Membership mutations must persist to `continuum_audit.audit_logs_iam`, following ADR-003/DEC-011. Required actions are `PROJECT_VISIBILITY_CHANGED`, `PROJECT_LEADER_ASSIGNED`, `PROJECT_LEADER_CHANGED`, `PROJECT_LEADER_REVOKED`, `PROJECT_MEMBER_ADDED`, and `PROJECT_MEMBER_REMOVED`. `PROJECT_MEMBER_ROLE_CHANGED` is not a V1 event because role changes are disabled. IAM and audit writes use a shared MongoDB client session and require replica-set integration verification.

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
