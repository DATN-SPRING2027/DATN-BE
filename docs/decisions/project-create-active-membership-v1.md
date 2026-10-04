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

`project.read` remains governed by the existing private Project policy. The creator is bootstrapped with the Project membership and scoped `MEMBER` RoleAssignment needed to satisfy that policy when the configured current `MEMBER` Role includes `project.read`.

## Bootstrap and audit

The earlier `PROJECT_CREATE_BOOTSTRAP_V1` is superseded by the requester's later Project Foundation decision, recorded in [`project-creator-member-bootstrap-v1.md`](project-creator-member-bootstrap-v1.md): creation atomically creates the `PRIVATE` Project, an `ACTIVE` ProjectMembership for the creator, and a project-scoped `MEMBER` RoleAssignment. It does not create a Project Leader, owner, or Team. The existing `project.create` event remains in `audit_logs_iam`; its metadata records the bootstrap membership and RoleAssignment IDs. All writes share one MongoDB transaction. Missing or misconfigured current `MEMBER` Role (including missing `project.read`) aborts the transaction. Role provisioning remains an operational prerequisite; no new permission matrix or seed is introduced.

## Contract and verification

The existing Project create path, payload, validation, response and error mappings remain unchanged. Its authorization description is updated to the rule above. Tests cover allow for `MEMBER`, `TEAM_LEADER` and `ADMIN` with an `ACTIVE` Organization Membership and no required grant; denial for missing, `PENDING_INVITE`, `SUSPENDED` or `REMOVED` membership, inactive subject, cross-Organization context, invalid evidence, and explicit `DENY`/`UNKNOWN`. Persistence tests also verify atomic creator bootstrap and that the creator can list and read the new Private Project.

No FE, database schema, migration, or role-permission matrix change is part of this decision.
