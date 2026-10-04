# Project Create bootstrap V1 — superseded historical decision

- **Status:** Superseded on 2026-10-04 by [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md)
- **Original decision date:** 2026-10-04
- **Scope:** Earlier proposal for `POST /api/v1/iam/projects`

> This file records a former Project Create proposal. It is historical context,
> not the current implementation contract. The current requester-approved
> behavior is documented in
> [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md):
> Project creation also creates an `ACTIVE` ProjectMembership and a
> project-scoped `MEMBER` RoleAssignment for the creator in the same
> transaction as the Project and audit event.

## Former decision — superseded

The earlier proposal allowed an authenticated User with an `ACTIVE`
Organization Membership in the trusted Organization Context to create a
`PRIVATE` Project. Under that proposal, creation recorded the creator in
`createdBy` but wrote only the Project and its `project.create` audit event.
It did not create a ProjectMembership, project-scoped RoleAssignment, Team,
Project Leader appointment, or owner for the creator. The `createdBy` field
was not considered Project access evidence.

This proposal was superseded by the creator Member bootstrap decision. It must
not be used to determine current Project visibility or authorization behavior.

## Former persistence and audit behavior

Under the superseded proposal, the Project was stored in `continuum_iam` and
the audit event in `continuum_audit.audit_logs_iam`; those two writes shared a
MongoDB transaction/session on the configured replica set. Because that
proposal created no membership or role assignment, its audit event had no
`metadata.bootstrap` fields. These details describe the former proposal only.

The current decision writes the Project, creator membership, project-scoped
`MEMBER` RoleAssignment, and audit event atomically. See
[`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md)
for the authoritative policy and verification requirements.
