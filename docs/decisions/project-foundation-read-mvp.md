# Project Foundation read policy — work package decision

**Status:** Accepted API and authorization contract for the Project Foundation endpoints by the requester's explicit decisions on 2026-09-29, with the `project.create` rule superseded by the requester-approved decision dated 2026-09-30. This is not an end-to-end creator bootstrap or deployment-readiness decision. Broader DEC-001 onboarding and approval workflow remains open.

## Contract used

- The requester accepted only the Project create/list/detail portion of `docs/openapi/iam-v1.openapi.json` for this MVP: existing paths, request/response schemas, validation, and documented status/error mappings. Team, Project Membership lifecycle, archive/restore, and other IAM operations were not accepted by that approval.
- Authentication revalidates the active User and `ACTIVE` Organization Membership and resolves a trusted Organization Context. A client-supplied Organization selector must match it. RoleAssignment is not evidence of Organization Membership.
- Any authenticated User with an `ACTIVE` Organization Membership in the trusted Organization Context may create a Project. The 2026-09-30 decision supersedes the previous `ADMIN` or `TEAM_LEADER` plus `project.create` capability-grant condition for this permission only. Other grants and capabilities keep their existing policies; this change does not alter `project.read`.
- Organization `ADMIN` may list and read metadata for every Project in the trusted Organization without Project Membership or project-scoped RoleAssignment. This grants no Project content access.
- `TEAM_LEADER` and `MEMBER` need an `ACTIVE` ProjectMembership for the target Project, a matching project-scoped RoleAssignment, a current Role whose code matches the assignment, and `project.read` in that Role's permissions. Organization-level assignment and ProjectMembership alone do not grant `project.read`.
- List filters invisible Projects in the backend before pagination. Detail of an invisible or nonexistent Project returns 404; unauthenticated calls return 401. A mismatched client Organization selector is invalid for list (422), while detail conceals the target with 404. Backend checks remain authoritative.
- The existing DEC-002 order remains: default deny; applicable explicit deny wins; otherwise allow only with valid, active permission evidence. The current membership/role sources have no deny field.

## Small implementation choices

- The existing `AuthorizationPolicy` calculates Project metadata visibility from server-collected evidence. The MongoDB repository applies its result to Organization-scoped Project queries. Both role ID and role code must resolve to a current Role, so a stale assignment cannot authorize.
- Project list sorts by `createdAt` then `_id`, descending, for stable pagination. Malformed Project IDs return the same 404 as invisible Projects. Responses set `Cache-Control: no-store`.

## Project creation bootstrap and audit decision

- `PROJECT_CREATE_BOOTSTRAP_V1` was supplied by the requester: POST creates only the Project in the trusted Organization Context. The creator receives no automatic ProjectMembership, project-scoped RoleAssignment, TEAM_LEADER role, owner/leader record, or Team. Any later bootstrap is a separate DEC-001 decision.
- Creation requires an authenticated active User, matching trusted Organization Context, `ACTIVE` OrganizationMembership and no applicable explicit deny. It does not require an `ADMIN`/`TEAM_LEADER` role or `organization_capability_grants.project.create`. Project payload validation, unique code enforcement, and the audit event remain required.
- The requester selected a dedicated `audit_logs_iam` collection in shared `continuum_db` for the required project-create audit event. The Project and audit event are written in one MongoDB transaction; failure of either write aborts the mutation. The event uses the existing IAM audit shape (`organizationId`, `projectId`, `actorUserId`, `action`, `targetResource`, `targetResourceId`, `occurredAt`).

This MVP does not establish a Project owner, leader, Team, or membership lifecycle operation.

## Readiness limits and deferred provisioning

- Project creation does not confer read visibility. Under `PROJECT_CREATE_BOOTSTRAP_V1`, any creator gets no ProjectMembership or project-scoped RoleAssignment. A creator who does not independently satisfy the unchanged `project.read` policy cannot list or read the new Project: list filters it out and detail returns 404. This work package does not claim a usable end-to-end create/read workflow for that actor.
- Organization `ADMIN` metadata reads still require an organization-scoped assignment whose `roleId` resolves to a current `ADMIN` Role. `TEAM_LEADER` and `MEMBER` reads additionally require a resolved current Role whose `permissions` contains `project.read`, plus the scoped assignment and active ProjectMembership already listed above.
- This branch contains no system Role seed or role provisioning path. The Role schema defaults `permissions` to an empty array, and the repository's implementation plan records that role seeds and the role-to-permission mapping are absent. On a clean database with no pre-provisioned Role documents, read authorization fails closed; this affects `project.read`, not `project.create` under the 2026-09-30 decision.
- Deployment therefore requires Role documents to be provisioned and RoleAssignments to reference those current Role IDs. For `TEAM_LEADER`/`MEMBER`, the approved permission configuration must explicitly place `project.read` in the resolved Role's permissions. No default mapping is inferred here. A separate decision and provisioning change, with authenticated MongoDB integration coverage, is required before claiming clean-database create/read readiness.
- The accepted product actor document describes initial Project membership/team-leader assignment through an audited bootstrap policy, while this work-package decision explicitly forbids automatic creator bootstrap. This implementation follows the narrower requester-supplied `PROJECT_CREATE_BOOTSTRAP_V1` contract. It does not edit or supersede the canonical product document or close DEC-001; the broader lifecycle conflict remains open for its appropriate decision process.
