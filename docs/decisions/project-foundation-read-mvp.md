# Project Foundation read policy — work package decision

**Status:** Accepted for the Project Foundation / Create-Read MVP by the requester's explicit decisions on 2026-09-29. This repository copy records the rules used by the implementation. Broader DEC-001 onboarding and approval workflow remains open.

## Contract used

- The requester accepted only the Project create/list/detail portion of `docs/openapi/iam-v1.openapi.json` for this MVP: existing paths, request/response schemas, validation, and documented status/error mappings. Team, Project Membership lifecycle, archive/restore, and other IAM operations were not accepted by that approval.
- Authentication revalidates the active User and `ACTIVE` Organization Membership and resolves a trusted Organization Context. A client-supplied Organization selector must match it. RoleAssignment is not evidence of Organization Membership.
- Organization `ADMIN` may list and read metadata for every Project in the trusted Organization without Project Membership or project-scoped RoleAssignment. This grants no Project content access.
- `TEAM_LEADER` and `MEMBER` need an `ACTIVE` ProjectMembership for the target Project, a matching project-scoped RoleAssignment, a current Role whose code matches the assignment, and `project.read` in that Role's permissions. Organization-level assignment and ProjectMembership alone do not grant `project.read`.
- List filters invisible Projects in the backend before pagination. Detail of an invisible or nonexistent Project returns 404; unauthenticated calls return 401. A mismatched client Organization selector is invalid for list (422), while detail conceals the target with 404. Backend checks remain authoritative.
- The existing DEC-002 order remains: default deny; applicable explicit deny wins; otherwise allow only with valid, active permission evidence. The current membership/role sources have no deny field.

## Small implementation choices

- The existing `AuthorizationPolicy` calculates Project metadata visibility from server-collected evidence. The MongoDB repository applies its result to Organization-scoped Project queries. Both role ID and role code must resolve to a current Role, so a stale assignment cannot authorize.
- Project list sorts by `createdAt` then `_id`, descending, for stable pagination. Malformed Project IDs return the same 404 as invisible Projects. Responses set `Cache-Control: no-store`.

## Project creation bootstrap and audit decision

- `PROJECT_CREATE_BOOTSTRAP_V1` was supplied by the requester: POST creates only the Project in the trusted Organization Context. The creator receives no automatic ProjectMembership, project-scoped RoleAssignment, TEAM_LEADER role, owner/leader record, or Team. Any later bootstrap is a separate DEC-001 decision.
- Creation requires current `project.create` authorization with `ACTIVE` OrganizationMembership and valid grant lifecycle/scope. The merged Authorization Foundation guard remains the evaluator.
- The requester selected a dedicated `audit_logs_iam` collection in shared `continuum_db` for the required project-create audit event. The Project and audit event are written in one MongoDB transaction; failure of either write aborts the mutation. The event uses the existing IAM audit shape (`organizationId`, `projectId`, `actorUserId`, `action`, `targetResource`, `targetResourceId`, `occurredAt`).

This MVP does not establish a Project owner, leader, Team, or membership lifecycle operation.
