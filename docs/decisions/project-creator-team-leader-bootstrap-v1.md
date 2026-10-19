# Project creator Team Leader bootstrap — Project Foundation

- **Status:** Current requester decision, selected during the PR #60 fix review
- **Decision date:** 2026-10-19
- **Scope:** Creator bootstrap performed by `POST /api/v1/iam/projects`
- **Supersedes:** [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md)

## Decision

Any authenticated User with an `ACTIVE` Organization Membership may create a
Project under the existing `project.create` rule. A new Project is `PRIVATE`.
Creation bootstraps the creator with:

- one `ACTIVE` ProjectMembership; and
- one project-scoped RoleAssignment to the current `TEAM_LEADER` Role.

The current `TEAM_LEADER` Role must include `project.read`,
`project.members.list`, `project.members.add`, and `project.members.remove`. If
the Role is absent or lacks any required permission, creation fails and the
whole transaction rolls back. The bootstrap creates no separate Project owner
or Team record. The Project Leader RoleAssignment grants the existing
permission-backed Project member operations; later leader assignment or
replacement for existing members remains governed by the Project Access API.

No organization role or `project.create` capability grant is required to
create a Project. This decision changes only the creator bootstrap and does
not change request authorization, other capability policies, or public/private
Project visibility rules.

## Persistence and existing Projects

The Project, creator ProjectMembership, and project-scoped `TEAM_LEADER`
RoleAssignment are written to `continuum_iam` in the same MongoDB transaction
as the existing `project.create` audit event in
`continuum_audit.audit_logs_iam`. The audit metadata records the created
membership and RoleAssignment IDs.

Existing active Projects whose creators have a current project-scoped `MEMBER`
RoleAssignment may be promoted by the report-first
`20261019-project-creator-leader.mjs` data migration. The migration changes
existing RoleAssignment data only; it adds no schema, indexes, or collections.
It requires a reviewed, target-bound dry-run hash and applies each reviewed
promotion in one MongoDB transaction. It has no automatic rollback command.

## Verification and operations

Tests verify creator bootstrap, the required `TEAM_LEADER` permission set,
member operations, and migration preflight and transaction guards. Deployment
must provision the current `TEAM_LEADER` Role with the required permissions
before enabling Project creation. Review a target-specific migration report
and confirm the project data before applying it to an environment.
