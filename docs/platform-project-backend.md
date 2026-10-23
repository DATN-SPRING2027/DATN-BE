# Platform Project administration backend

## Scope and existing contract

This capability uses the existing Platform Operations V2 contract in
`docs/decisions/platform-operator-console-v2.md` and
`docs/openapi/iam-v1.openapi.json`. Routes already existed on main; this change
hardens persisted ownership validation and extends verification. No frontend,
new permission bundle, migration, or automatic authority grant is introduced.

| Method and path (prefix `/api/v1/iam/platform`) | Exact PLATFORM permission | Purpose |
| --- | --- | --- |
| GET `/projects` | `platform.projects.project.read` | Cross-organization directory; page/pageSize, search, organizationId, visibility, status |
| GET `/projects/:projectId` | `platform.projects.project.read` | Project metadata, organization, active member count, bounded leader identities |
| GET `/projects/:projectId/memberships` | `platform.projects.project.read` | Safe member identities and membership status; page/pageSize, search, status |
| PATCH `/projects/:projectId` | `platform.projects.project.manage` | Update name, code, visibility with expectedUpdatedAt and reasonCode |

Page sizes are 1–100. Project search matches name/code and organization
name/slug. Member search matches email/fullName; status is ACTIVE or INACTIVE.
Responses have `Cache-Control: no-store`. Platform projections exclude project
description, tenant content, credentials, tokens and role assignment internals.
Metadata mutation accepts ACCESS_REVIEW or SECURITY_INCIDENT as reasonCode.
Code must match `^[A-Z][A-Z0-9_-]{1,31}$`; name is trimmed and 1–200 characters.
Unknown fields are rejected. PATCH does not archive projects, transfer ownership,
or alter project members/roles.

## Runtime and database analysis

Gateway forwards IAM requests to the owning IAM process; PlatformController
checks PlatformAuthorizationGuard, then PlatformAdministrationService validates
input and the MongoPlatformAdministrationRepository accesses IAM persistence.
The database owner is `continuum_iam`, with the following relevant collections:

- `projects`: organizationId, name, code, description, visibility, status,
  createdAt, updatedAt; unique index on `(organizationId, code)`.
- `organizations`: resolves the persisted Project-to-Organization association.
- `project_memberships`: organizationId/projectId/userId, status, joinedAt;
  unique `(projectId, userId)`. Membership queries fence both project and
  organization identifiers. The service derives organizationId from the Project.
- `users`: safe identity lookup only. Missing user records project as null.
- `role_assignments`: bounded TEAM_LEADER identity summaries; assignment
  internals are excluded from the API.
- `platform_authority_assignments`: current exact PLATFORM permission evidence,
  separate from Organization ADMIN and Project TEAM_LEADER roles.

Required mutation audits are stored in `continuum_audit.audit_logs_iam` with
`platform.project.metadata.changed`, actor, target project, owning organization,
reason, safe before/after fields and optional request ID.

The Platform principal does not require an Organization membership. It requires
verified PLATFORM authentication and current explicit permission evidence.
An Organization ADMIN role or a client header claiming PLATFORM_OPERATOR grants
no Platform access. Mutation authority is checked again inside the transaction.
Cookie-based writes also require the existing CSRF cookie/header pair.

## Transaction behavior and fix

PATCH uses an updatedAt compare-and-set. Concurrent different edits allow one
winner; stale competing changes return PROJECT_VERSION_STALE (409). Repeating
an already applied change returns the current result without another audit.
Duplicate project codes within an organization return PROJECT_CODE_CONFLICT
(409). Mutation and audit commit atomically; audit failure rolls back metadata.

Previously an orphan Project could be changed and audited before the final
projection discovered its missing Organization and returned 404. The repository
now resolves that Organization inside the transaction before any project write.
Missing ownership returns null, mapped by the service to PROJECT_NOT_FOUND
(404), with no metadata change or success audit.

## Verification

Tests cover the HTTP authentication/permission boundary, revoked authority,
cookie CSRF, filters, pagination validation, unsafe fields, metadata parsing,
server-derived organization scope, missing/malformed IDs, database failure,
safe Mongo projections, cross-organization membership isolation, successful
metadata/audit, stale CAS, concurrent writes, replay, revoked mutation authority,
orphan ownership, and rollback when audit fails.

Mongo integration tests create a disposable MongoDB 7.0.24 replica set and isolated
fixture databases. They do not use the application's configured database.
Run `npm run check` for lint, types, safety tests, unit/Mongo integration tests,
HTTP e2e and build.

Validation on 2026-10-23: `npm run check` passed, including build. Jest reported
1,338 passing unit/integration tests and 108 passing HTTP e2e tests. The repository's
existing environment-gated suites skipped 135 unit/integration and 4 e2e cases;
these are not counted as verified. All 32 newly added tests ran and passed,
including the disposable MongoDB Project transaction cases.
