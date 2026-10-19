# Project Foundation read policy — work package decision

**Status:** Accepted API and authorization contract for the Project Foundation endpoints by the requester's explicit decisions on 2026-09-29 and follow-ups dated 2026-09-30. The creator-bootstrap rule below is the latest accepted rule and supersedes the earlier `PROJECT_CREATE_BOOTSTRAP_V1` rule. Broader DEC-001 onboarding and approval workflow remains open.

The creator bootstrap is governed by [`project-creator-team-leader-bootstrap-v1.md`](project-creator-team-leader-bootstrap-v1.md), which supersedes the earlier creator-MEMBER policy.

## Contract used

- The requester accepted only the Project create/list/detail portion of `docs/openapi/iam-v1.openapi.json` for this MVP: existing paths, request/response schemas, validation, and documented status/error mappings. Team, Project Membership lifecycle, archive/restore, and other IAM operations were not accepted by that approval.
- Authentication revalidates the active User and `ACTIVE` Organization Membership and resolves a trusted Organization Context. A client-supplied Organization selector must match it. RoleAssignment is not evidence of Organization Membership.
- Any authenticated User with an `ACTIVE` Organization Membership in the trusted Organization Context may create a Project. The 2026-09-30 decision supersedes the previous `ADMIN` or `TEAM_LEADER` plus `project.create` capability-grant condition for this permission only. Other grants and capabilities keep their existing policies; this change does not alter `project.read`.
- Every new Project is `PRIVATE`. The creator is bootstrapped with an `ACTIVE` ProjectMembership and project-scoped RoleAssignment to the current `TEAM_LEADER` Role. The bootstrap creates no separate Project owner or Team record.
- Organization `ADMIN` may list and read metadata for every Project in the trusted Organization without Project Membership or project-scoped RoleAssignment. This grants no Project content access.
- An authenticated User with an `ACTIVE` Organization Membership may read metadata for a `PUBLIC` Project in that Organization without Project Membership or `project.read` RoleAssignment. This is read-only Project metadata access through these endpoints. Nested Project resources remain outside this endpoint contract and follow their separately supplied public/private content rules. A User without an `ACTIVE` Organization Membership cannot read a Project even when it is `PUBLIC`.
- For `PRIVATE` Projects, `TEAM_LEADER` and `MEMBER` need an `ACTIVE` ProjectMembership for the target Project, a matching project-scoped RoleAssignment, a current Role whose code matches the assignment, and `project.read` in that Role's permissions. Organization-level assignment and ProjectMembership alone do not grant access to a `PRIVATE` Project.
- List filters invisible Projects in the backend before pagination. Detail of an invisible or nonexistent Project returns 404; unauthenticated calls return 401. A mismatched client Organization selector is invalid for list (422), while detail conceals the target with 404. Backend checks remain authoritative.
- The existing DEC-002 order remains: default deny; applicable explicit deny wins; otherwise allow only with valid, active permission evidence. The current membership/role sources have no deny field.

## Small implementation choices

- The existing `AuthorizationPolicy` calculates Project metadata visibility from server-collected evidence, including whether an active Organization member may include `PUBLIC` Projects. The MongoDB repository applies that scope before filtering and pagination. Both role ID and role code must resolve to a current Role, so a stale assignment cannot authorize a `PRIVATE` Project.
- Project list sorts by `createdAt` then `_id`, descending, for stable pagination. Malformed Project IDs return the same 404 as invisible Projects. Responses set `Cache-Control: no-store`.

## Project creation bootstrap and audit decision

- The current creator policy supersedes both the earlier `PROJECT_CREATE_BOOTSTRAP_V1` and creator-MEMBER policy: POST creates a `PRIVATE` Project, an `ACTIVE` ProjectMembership for its creator, and a project-scoped `TEAM_LEADER` RoleAssignment. It creates no separate owner or Team record.
- Creation authorization still requires an authenticated active User, matching trusted Organization Context, `ACTIVE` OrganizationMembership and no applicable explicit deny. It does not require an `ADMIN`/`TEAM_LEADER` role or `organization_capability_grants.project.create`. Project payload validation and unique code enforcement remain required.
- Private Project metadata access still requires the active ProjectMembership, project-scoped RoleAssignment, and a current matching Role whose permissions include `project.read`. The creator bootstrap resolves `TEAM_LEADER` and requires `project.read`, `project.members.list`, `project.members.add`, and `project.members.remove` before writing. If the current `TEAM_LEADER` Role is missing or lacks a required permission, the transaction fails without creating the Project, membership, assignment, or audit event. The existing Role provisioning prerequisite remains; this decision does not invent a role-permission matrix or add a seed.
- The requester selected the dedicated `audit_logs_iam` collection for the required project-create audit event. Under the later accepted database-per-service topology, this collection is in `continuum_audit`; Project, membership, and RoleAssignment are in `continuum_iam`. The writes use one MongoDB transaction/session on the configured replica set; failure of any write aborts the mutation. The event uses the existing IAM audit shape and its `metadata.bootstrap` records the created membership and RoleAssignment IDs.

This MVP creates no separate Project owner or Team record and adds no Project Membership lifecycle operation beyond bootstrapping the creator as an active member with the `TEAM_LEADER` RoleAssignment.

## Project visibility read-policy follow-up — requester decision, 2026-09-30

- New Projects default to `PRIVATE`. The Project create request does not accept a visibility override.
- Only the requester's separately defined `Leader Tổng` authority may change a Project to `PUBLIC`. No visibility-update endpoint or Leader Tổng role mapping is added by this create/list/detail MVP.
- `PUBLIC` grants read-only Project metadata access through the accepted list/detail endpoints to Users with an `ACTIVE` Organization Membership in the same trusted Organization. This change does not implement nested Project content endpoints or broaden mutation permissions; their public/private read and sensitive-data rules remain as separately supplied by the requester.
- `PRIVATE` Projects retain the existing `ADMIN` metadata rule and the resolved project-scoped Role plus active ProjectMembership rule. Non-members, inactive Organization Memberships, and cross-Organization users cannot read either visibility.
- This follow-up supersedes the earlier `project.read` bullets only for `PUBLIC` Project metadata. It does not change `project.create`, private Project role semantics, response schemas, payload validation, or content permissions.

## Readiness and provisioning

- The creator can list and read the new `PRIVATE` Project through the bootstrapped membership and scoped RoleAssignment, provided the configured current `TEAM_LEADER` Role includes the required Project permissions.
- Organization `ADMIN` metadata reads still require an organization-scoped assignment whose `roleId` resolves to a current `ADMIN` Role. `TEAM_LEADER` and `MEMBER` reads additionally require a resolved current Role whose `permissions` contains `project.read`, plus the scoped assignment and active ProjectMembership already listed above.
- This branch contains no system Role seed or role provisioning path. Deployment must provision the current `TEAM_LEADER` Role with `project.read`, `project.members.list`, `project.members.add`, and `project.members.remove` so creator bootstrap can succeed. A missing or misconfigured Role is treated as a configuration failure and rolls back creation. This create/list/detail MVP adds no task endpoints.
- Separately assigning or changing Project Leaders for existing members remains governed by its accepted policy and APIs.
