# Project Foundation read policy — work package decision

**Status:** Accepted API and authorization contract for the Project Foundation endpoints by the requester's explicit decisions on 2026-09-29 and follow-ups. The current creator rule is [`PROJECT_CREATE_BOOTSTRAP_V1`](project-create-bootstrap-v1.md), reaffirmed on 2026-10-04. Broader DEC-001 onboarding and approval workflow remains open.

The creator rule is recorded separately in [`project-create-bootstrap-v1.md`](project-create-bootstrap-v1.md). The prior creator Member bootstrap document is historical and superseded.

## Contract used

- The requester accepted only the Project create/list/detail portion of `docs/openapi/iam-v1.openapi.json` for this MVP: existing paths, request/response schemas, validation, and documented status/error mappings. Team, Project Membership lifecycle, archive/restore, and other IAM operations were not accepted by that approval.
- Authentication revalidates the active User and `ACTIVE` Organization Membership and resolves a trusted Organization Context. A client-supplied Organization selector must match it. RoleAssignment is not evidence of Organization Membership.
- Any authenticated User with an `ACTIVE` Organization Membership in the trusted Organization Context may create a Project. The 2026-09-30 decision supersedes the previous `ADMIN` or `TEAM_LEADER` plus `project.create` capability-grant condition for this permission only. Other grants and capabilities keep their existing policies; this change does not alter `project.read`.
- Every new Project is `PRIVATE`. The creator is recorded only in `createdBy`. Project creation does not automatically create a ProjectMembership, project-scoped RoleAssignment, Team, Project Leader appointment, owner, or special project role. `createdBy` does not itself grant Project access.
- Organization `ADMIN` may list and read metadata for every Project in the trusted Organization without Project Membership or project-scoped RoleAssignment. This grants no Project content access.
- An authenticated User with an `ACTIVE` Organization Membership may read metadata for a `PUBLIC` Project in that Organization without Project Membership or `project.read` RoleAssignment. This is read-only Project metadata access through these endpoints. Nested Project resources remain outside this endpoint contract and follow their separately supplied public/private content rules. A User without an `ACTIVE` Organization Membership cannot read a Project even when it is `PUBLIC`.
- For `PRIVATE` Projects, `TEAM_LEADER` and `MEMBER` need an `ACTIVE` ProjectMembership for the target Project, a matching project-scoped RoleAssignment, a current Role whose code matches the assignment, and `project.read` in that Role's permissions. Organization-level assignment and ProjectMembership alone do not grant access to a `PRIVATE` Project.
- List filters invisible Projects in the backend before pagination. Detail of an invisible or nonexistent Project returns 404; unauthenticated calls return 401. A mismatched client Organization selector is invalid for list (422), while detail conceals the target with 404. Backend checks remain authoritative.
- The existing DEC-002 order remains: default deny; applicable explicit deny wins; otherwise allow only with valid, active permission evidence. The current membership/role sources have no deny field.

## Small implementation choices

- The existing `AuthorizationPolicy` calculates Project metadata visibility from server-collected evidence, including whether an active Organization member may include `PUBLIC` Projects. The MongoDB repository applies that scope before filtering and pagination. Both role ID and role code must resolve to a current Role, so a stale assignment cannot authorize a `PRIVATE` Project.
- Project list sorts by `createdAt` then `_id`, descending, for stable pagination. Malformed Project IDs return the same 404 as invisible Projects. Responses set `Cache-Control: no-store`.

## Project creation bootstrap and audit decision

- The current requester-approved `PROJECT_CREATE_BOOTSTRAP_V1`, reaffirmed on 2026-10-04, supersedes the 2026-09-30 creator Member bootstrap. POST creates a `PRIVATE` Project and the required audit event only. It does not create a ProjectMembership, project-scoped RoleAssignment, `TEAM_LEADER` appointment, owner/leader record, Team, or special project role. Project member rights require the existing membership and role assignment flows.
- Creation authorization still requires an authenticated active User, matching trusted Organization Context, `ACTIVE` OrganizationMembership and no applicable explicit deny. It does not require an `ADMIN`/`TEAM_LEADER` role or `organization_capability_grants.project.create`. Project payload validation and unique code enforcement remain required.
- Private Project metadata access still requires the active ProjectMembership, project-scoped RoleAssignment, and a current `MEMBER` Role whose permissions include `project.read`. Project creation does not resolve that Role or create either relationship. A missing `MEMBER` Role or `project.read` permission can affect Project Access, but does not prevent an otherwise-authorized Project Create. This decision does not invent a role-permission matrix or add a seed.
- The requester selected the dedicated `audit_logs_iam` collection for the required project-create audit event. Under the accepted database-per-service topology, this collection is in `continuum_audit` and the Project is in `continuum_iam`. Project and audit writes use one MongoDB transaction/session on the configured replica set; failure of either write aborts the mutation. The event keeps the existing IAM audit shape and has no bootstrap metadata.

This MVP does not establish a Project owner, Project Leader, Team, or a Project Membership lifecycle operation. Project creator status does not imply ProjectMembership.

## Project visibility read-policy follow-up — requester decision, 2026-09-30

- New Projects default to `PRIVATE`. The Project create request does not accept a visibility override.
- Only the requester's separately defined `Leader Tổng` authority may change a Project to `PUBLIC`. No visibility-update endpoint or Leader Tổng role mapping is added by this create/list/detail MVP.
- `PUBLIC` grants read-only Project metadata access through the accepted list/detail endpoints to Users with an `ACTIVE` Organization Membership in the same trusted Organization. This change does not implement nested Project content endpoints or broaden mutation permissions; their public/private read and sensitive-data rules remain as separately supplied by the requester.
- `PRIVATE` Projects retain the existing `ADMIN` metadata rule and the resolved project-scoped Role plus active ProjectMembership rule. Non-members, inactive Organization Memberships, and cross-Organization users cannot read either visibility.
- This follow-up supersedes the earlier `project.read` bullets only for `PUBLIC` Project metadata. It does not change `project.create`, private Project role semantics, response schemas, payload validation, or content permissions.

## Readiness and provisioning

- The creator's `createdBy` record does not grant `project.read`. The creator can list/read a new `PRIVATE` Project only if the existing Project Access policy independently grants access.
- Organization `ADMIN` metadata reads still require an organization-scoped assignment whose `roleId` resolves to a current `ADMIN` Role. `TEAM_LEADER` and `MEMBER` reads additionally require a resolved current Role whose `permissions` contains `project.read`, plus the scoped assignment and active ProjectMembership already listed above.
- Project creation does not require the current `MEMBER` Role to exist or contain `project.read`. Existing Project membership and role provisioning requirements still apply to their respective Project Access flows. This create/list/detail MVP adds no task endpoints.
- The bootstrap decision does not assign Project Leader authority. Project Leader appointments and other membership lifecycle changes remain governed by their separately accepted policy and APIs.
