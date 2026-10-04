# Project creator Member bootstrap — Project Foundation

- **Status:** Current requester-approved Project Create bootstrap policy; reaffirmed on 2026-10-04 during PR #17 review
- **Decision date:** 2026-09-30; reaffirmed 2026-10-04
- **Scope:** Creator bootstrap performed by `POST /api/v1/iam/projects`

## Decision

Every authenticated User with an `ACTIVE` Organization Membership may create a Project under the existing `project.create` rule. A new Project is `PRIVATE`. As part of the same creation operation, the creator receives:

- one `ACTIVE` ProjectMembership; and
- one project-scoped RoleAssignment to the current `MEMBER` Role.

The creator is an ordinary Project member, not a Project Leader, owner, or Team. The creator receives the documented Project member rights, including creating and editing tasks when those APIs are available. Project Leader appointment and management remain separate actions.

For the current Private Project metadata API, the project-scoped RoleAssignment must resolve to the current `MEMBER` Role and that Role's `permissions` must contain `project.read`, as required by the accepted `project.read` policy. The Role is provisioned configuration; this work does not create a Role seed or invent a permission matrix. If the Role is missing or lacks `project.read`, creation fails and the entire transaction is rolled back.

## Supersession and audit

This decision supersedes the earlier requester-approved `PROJECT_CREATE_BOOTSTRAP_V1` rule, which created only a Project and audit event and explicitly omitted creator membership and RoleAssignment. That earlier bootstrap rule must no longer be treated as authoritative.

Project, creator ProjectMembership, and project-scoped `MEMBER` RoleAssignment are stored in `continuum_iam`; the existing `project.create` audit event in `continuum_audit.audit_logs_iam` is committed in the same MongoDB transaction/session. The event's `metadata.bootstrap` records the generated membership and RoleAssignment IDs. A failure of any write leaves none of these records committed. Cross-database atomicity is verified by replica-set integration tests.

The `project.create` authorization rule remains unchanged: no organization role or `project.create` grant is required beyond authenticated active subject, trusted matching Organization Context, and `ACTIVE` Organization Membership. This decision does not change `project.read` for other users or Projects, public visibility behavior, request/response schemas, or other capability policies.

## Verification

Unit and MongoDB integration tests verify the creator receives the active membership and scoped MEMBER assignment, can list and read the new Private Project, and that bootstrap and audit writes roll back together. CI runs the MongoDB integration test against a single-node replica set.
