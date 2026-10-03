# Project creation authorization — ACTIVE Organization Membership

- **Status:** Requester-approved for the Project Foundation work package
- **Decision date:** 2026-09-30
- **Scope:** `POST /api/v1/iam/projects` and the `project.create` evaluator used by that route

## Decision

Any authenticated User with an `ACTIVE` Organization Membership in the trusted Organization Context may create a Project in that Organization.

The request must have:

- an authenticated active subject;
- a trusted Organization Context matching the requested Organization;
- an `ACTIVE` Organization Membership for that User and Organization;
- valid Project input;
- a unique Project code within that Organization; and
- a `project.create` audit event in `continuum_audit.audit_logs_iam` committed with the Project through the accepted cross-database MongoDB transaction/session.

No `ADMIN` or `TEAM_LEADER` role and no `organization_capability_grants.project.create` grant is required. Missing or non-`ACTIVE` membership, invalid or cross-Organization context, invalid Project input, or an explicit deny where a deny-capable source applies results in denial.

## Supersession and boundaries

This decision **supersedes** the older `ADMIN` or `TEAM_LEADER` plus explicit `project.create` grant rule from `product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md`, DEC-002 grant-use guidance, and the previous OpenAPI description, **only for `project.create`**. The old rule must not be treated as authoritative for Project creation. Other grants and capabilities retain their existing policies. No grant schema, grant issuance flow, or other Authorization Foundation behavior is removed or redesigned by this decision.

`project.read` remains governed by the existing private Project policy. The `createdBy` field does not itself grant Project access. Project creation does not add the creator to a ProjectMembership or project-scoped RoleAssignment; access remains governed by the existing Project Access rules.

## Bootstrap and audit

The current [`PROJECT_CREATE_BOOTSTRAP_V1`](project-create-bootstrap-v1.md), reaffirmed by the requester on 2026-10-04, supersedes the creator Member bootstrap recorded in [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md). Creation atomically writes only the `PRIVATE` Project and its existing `project.create` event in `audit_logs_iam`. It creates no ProjectMembership, project-scoped RoleAssignment, Team, Project Leader appointment, owner, or special project role. A `MEMBER` Role with `project.read` is not a Project Create prerequisite. Both writes remain in one MongoDB transaction/session.

## Contract and verification

The existing Project create path, payload, validation, response and error mappings remain unchanged. Its authorization description is updated to the rule above. Tests cover allow for `MEMBER`, `TEAM_LEADER` and `ADMIN` with an `ACTIVE` Organization Membership and no required grant; denial for missing, `PENDING_INVITE`, `SUSPENDED` or `REMOVED` membership, inactive subject, cross-Organization context, invalid evidence, and explicit `DENY`/`UNKNOWN`. Persistence tests verify that only the Project and audit event are written and that the creator receives no implicit access to the new Private Project.

No FE, database schema, migration, or role-permission matrix change is part of this decision.
