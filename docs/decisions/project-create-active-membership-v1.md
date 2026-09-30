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
- a `project.create` audit event in `audit_logs_iam` committed with the Project.

No `ADMIN` or `TEAM_LEADER` role and no `organization_capability_grants.project.create` grant is required. Missing or non-`ACTIVE` membership, invalid or cross-Organization context, invalid Project input, or an explicit deny where a deny-capable source applies results in denial.

## Supersession and boundaries

This decision **supersedes** the older `ADMIN` or `TEAM_LEADER` plus explicit `project.create` grant rule from `product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md`, DEC-002 grant-use guidance, and the previous OpenAPI description, **only for `project.create`**. The old rule must not be treated as authoritative for Project creation. Other grants and capabilities retain their existing policies. No grant schema, grant issuance flow, or other Authorization Foundation behavior is removed or redesigned by this decision.

`project.read` is unchanged. A successful create does not grant Project read access.

## Bootstrap and audit

`PROJECT_CREATE_BOOTSTRAP_V1` remains in force. The mutation creates only the Project and its audit event. It does not automatically create ProjectMembership, RoleAssignment, Team, owner, or leader records. The Project and `project.create` audit event remain transactional.

## Contract and verification

The existing Project create path, payload, validation, response and error mappings remain unchanged. Its authorization description is updated to the rule above. Tests cover allow for `MEMBER`, `TEAM_LEADER` and `ADMIN` with an `ACTIVE` Organization Membership and no required grant; denial for missing, `PENDING_INVITE`, `SUSPENDED` or `REMOVED` membership, inactive subject, cross-Organization context, invalid evidence, and explicit `DENY`/`UNKNOWN`.

No FE, database schema, migration, or role-permission matrix change is part of this decision.
