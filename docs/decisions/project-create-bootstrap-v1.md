# Project Create bootstrap V1

- **Status:** Requester-approved and current for the Project Foundation work package
- **Decision date:** 2026-10-04
- **Scope:** `POST /api/v1/iam/projects`

## Decision

An authenticated User with an `ACTIVE` Organization Membership in the trusted
Organization Context may create a Project in that Organization. The Project
defaults to `PRIVATE`. Creation records the User as `createdBy`; that field
does not itself grant Project access.

Project creation creates only:

- the Project; and
- the existing `project.create` audit event.

It does not automatically create a `ProjectMembership`, a project-scoped
`RoleAssignment`, a Team, a Project Leader appointment, or another project
role for the creator. Existing Project visibility and authorization rules
continue to determine whether the creator can read the new Private Project.

## Persistence and audit

The Project is stored in `continuum_iam`; the existing audit event is stored in
`continuum_audit.audit_logs_iam`. Both writes remain in one MongoDB
transaction/session on the configured replica set. The event keeps its
established IAM audit fields (`organizationId`, `projectId`, `actorUserId`,
`action`, `targetResource`, `targetResourceId`, and `occurredAt`). It does not
record bootstrap membership or role-assignment IDs because those records are
not created.

If Project persistence or the required audit write fails, the transaction
rolls back. Unique Project code behavior, input validation, response shape,
and `project.create` authorization are unchanged.

## Supersession

This current decision reaffirms the earlier `PROJECT_CREATE_BOOTSTRAP_V1`
rule and supersedes the 2026-09-30 creator Member bootstrap recorded in
[`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md).
That historical decision must not be used as current implementation
authority. This decision does not change Project Access APIs, Project read
policies, database topology, or any other capability policy.
