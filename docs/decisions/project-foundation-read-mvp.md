# Project Foundation read policy — work package decision

**Status:** Accepted API and authorization contract for the Project Foundation endpoints by the requester's explicit decisions on 2026-09-29 and follow-ups dated 2026-09-30. The creator-bootstrap rule below is the latest accepted rule and supersedes the earlier `PROJECT_CREATE_BOOTSTRAP_V1` rule. Broader DEC-001 onboarding and approval workflow remains open.

The creator bootstrap is recorded separately in [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md).

## Contract used

- The requester accepted only the Project create/list/detail portion of `docs/openapi/iam-v1.openapi.json` for this MVP: existing paths, request/response schemas, validation, and documented status/error mappings. Team, Project Membership lifecycle, archive/restore, and other IAM operations were not accepted by that approval.
- Authentication revalidates the active User and `ACTIVE` Organization Membership and resolves a trusted Organization Context. A client-supplied Organization selector must match it. RoleAssignment is not evidence of Organization Membership.
- Any authenticated User with an `ACTIVE` Organization Membership in the trusted Organization Context may create a Project. The 2026-09-30 decision supersedes the previous `ADMIN` or `TEAM_LEADER` plus `project.create` capability-grant condition for this permission only. Other grants and capabilities keep their existing policies; this change does not alter `project.read`.
- Every new Project is `PRIVATE`. The creator is bootstrapped as an ordinary Project `MEMBER`: an `ACTIVE` ProjectMembership and project-scoped RoleAssignment to the current `MEMBER` Role are created. The creator does not become a Project Leader, owner, or Team.
- Organization `ADMIN` may list and read metadata for every Project in the trusted Organization without Project Membership or project-scoped RoleAssignment. This grants no Project content access.
- An authenticated User with an `ACTIVE` Organization Membership may read metadata for a `PUBLIC` Project in that Organization without Project Membership or `project.read` RoleAssignment. This is read-only Project metadata access through these endpoints. Nested Project resources remain outside this endpoint contract and follow their separately supplied public/private content rules. A User without an `ACTIVE` Organization Membership cannot read a Project even when it is `PUBLIC`.
- For `PRIVATE` Projects, `TEAM_LEADER` and `MEMBER` need an `ACTIVE` ProjectMembership for the target Project, a matching project-scoped RoleAssignment, a current Role whose code matches the assignment, and `project.read` in that Role's permissions. Organization-level assignment and ProjectMembership alone do not grant access to a `PRIVATE` Project.
- List filters invisible Projects in the backend before pagination. Detail of an invisible or nonexistent Project returns 404; unauthenticated calls return 401. A mismatched client Organization selector is invalid for list (422), while detail conceals the target with 404. Backend checks remain authoritative.
- The existing DEC-002 order remains: default deny; applicable explicit deny wins; otherwise allow only with valid, active permission evidence. The current membership/role sources have no deny field.

## Small implementation choices

- The existing `AuthorizationPolicy` calculates Project metadata visibility from server-collected evidence, including whether an active Organization member may include `PUBLIC` Projects. The MongoDB repository applies that scope before filtering and pagination. Both role ID and role code must resolve to a current Role, so a stale assignment cannot authorize a `PRIVATE` Project.
- Project list sorts by `createdAt` then `_id`, descending, for stable pagination. Malformed Project IDs return the same 404 as invisible Projects. Responses set `Cache-Control: no-store`.

## Project creation bootstrap and audit decision

- The requester's latest Project Foundation rule supersedes the earlier `PROJECT_CREATE_BOOTSTRAP_V1`: POST creates a `PRIVATE` Project, an `ACTIVE` ProjectMembership for its creator, and a project-scoped `MEMBER` RoleAssignment. It does not create a `TEAM_LEADER` role, owner/leader record, or Team. The creator receives the ordinary Project member rights documented by the product rules, including task creation and editing when those APIs are available.
- Creation authorization still requires an authenticated active User, matching trusted Organization Context, `ACTIVE` OrganizationMembership and no applicable explicit deny. It does not require an `ADMIN`/`TEAM_LEADER` role or `organization_capability_grants.project.create`. Project payload validation and unique code enforcement remain required.
- Private Project metadata access still requires the active ProjectMembership, project-scoped RoleAssignment, and a current `MEMBER` Role whose permissions include `project.read`. Therefore the bootstrap resolves that Role before writing. If the current `MEMBER` Role is missing or does not include `project.read`, the transaction fails without creating the Project, membership, assignment, or audit event. The existing Role provisioning prerequisite remains; this decision does not invent a role-permission matrix or add a seed.
- The requester selected a dedicated `audit_logs_iam` collection in shared `continuum_db` for the required project-create audit event. The Project, membership, RoleAssignment, and audit event are written in one MongoDB transaction; failure of any write aborts the mutation. The event uses the existing IAM audit shape and its `metadata.bootstrap` records the created membership and RoleAssignment IDs.

This MVP does not establish a Project owner, Project Leader, Team, or a Project Membership lifecycle operation beyond bootstrapping the creator as an active member.

## Project visibility read-policy follow-up — requester decision, 2026-09-30

- New Projects default to `PRIVATE`. The Project create request does not accept a visibility override.
- Only the requester's separately defined `Leader Tổng` authority may change a Project to `PUBLIC`. No visibility-update endpoint or Leader Tổng role mapping is added by this create/list/detail MVP.
- `PUBLIC` grants read-only Project metadata access through the accepted list/detail endpoints to Users with an `ACTIVE` Organization Membership in the same trusted Organization. This change does not implement nested Project content endpoints or broaden mutation permissions; their public/private read and sensitive-data rules remain as separately supplied by the requester.
- `PRIVATE` Projects retain the existing `ADMIN` metadata rule and the resolved project-scoped Role plus active ProjectMembership rule. Non-members, inactive Organization Memberships, and cross-Organization users cannot read either visibility.
- This follow-up supersedes the earlier `project.read` bullets only for `PUBLIC` Project metadata. It does not change `project.create`, private Project role semantics, response schemas, payload validation, or content permissions.

## Readiness and provisioning

- The creator can list and read the new `PRIVATE` Project through the bootstrapped membership and scoped RoleAssignment, provided the configured current `MEMBER` Role includes `project.read`.
- Organization `ADMIN` metadata reads still require an organization-scoped assignment whose `roleId` resolves to a current `ADMIN` Role. `TEAM_LEADER` and `MEMBER` reads additionally require a resolved current Role whose `permissions` contains `project.read`, plus the scoped assignment and active ProjectMembership already listed above.
- This branch contains no system Role seed or role provisioning path. Deployment must provision the current `MEMBER` Role with `project.read` so creator bootstrap can succeed. A missing or misconfigured Role is treated as a configuration failure and rolls back creation. The same Role configuration must include the documented task permissions when task APIs are implemented; this create/list/detail MVP adds no task endpoints.
- The bootstrap decision does not assign Project Leader authority. Project Leader appointments and other membership lifecycle changes remain governed by their separately accepted policy and APIs.
