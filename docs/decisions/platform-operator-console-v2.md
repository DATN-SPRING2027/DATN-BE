# Platform Operator Console Operations (V2)

## Status and authority

This implementation decision records the expanded Platform Operator backend
scope explicitly requested for the `feat/Thang-platform-operator-v1-be-api`
task. It is a successor implementation contract; it does not amend the accepted
historical scope of DATN-79 or DEC-ACCESS-09. A-04 remains exactly
`organization.create`, `platform.health.read`, and `platform.audit.read`.
The existing seven-permission V1 bundle also remains byte-for-byte stable.

No public authority grant/revoke endpoint is introduced. The current
DATN-295 issuer/MFA workflow stays disabled by default and continues to fail
closed until its independent trusted issuer and fresh-MFA evidence are
configured and approved. V2 permissions are recognized by server-side policy,
but no authority is assigned by this document or by an application seed.

## Permission model

Every Platform route uses the verified Platform principal, reloads the exact
permission assignment on every request, and requires one current, unexpired,
non-self-granted assignment at `PLATFORM` scope. Client role, organization,
permission, and UI state are not authorization evidence. Unknown or ambiguous
evidence denies. Organization resource identifiers in a path or body are
resolved against persisted records and checked against the requested action.

The API uses fixed, versioned authority bundles so an expansion cannot silently
change prior operators' access:

- **A-04**: the three accepted permissions above.
- **V1**: the existing seven-permission bundle; unchanged.
- **V2**: the complete Platform Operations bundle below, introduced separately
  from V1. Existing users do not receive V2 automatically.

V2 permissions:

| Capability                               | Permission                                                                           | Scope    |
| ---------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Organization provisioning                | `organization.create`                                                                | PLATFORM |
| IAM health and platform audit            | `platform.health.read`, `platform.audit.read`                                        | PLATFORM |
| Organization directory                   | `platform.organizations.organization.read`                                           | PLATFORM |
| Organization metadata and lifecycle      | `platform.organizations.organization.manage`                                         | PLATFORM |
| User directory and effective permissions | `platform.users.account.read`                                                        | PLATFORM |
| User lifecycle                           | `platform.users.account.manage`                                                      | PLATFORM |
| Session directory                        | `platform.sessions.session.read`                                                     | PLATFORM |
| Session revocation                       | `platform.sessions.session.manage`                                                   | PLATFORM |
| Membership directory and lifecycle       | `platform.memberships.membership.read`, `platform.memberships.lifecycle.manage`      | PLATFORM |
| Invitations and role changes             | `platform.memberships.invitation.manage`, `platform.memberships.role.manage`         | PLATFORM |
| Project metadata and access policy       | `platform.projects.project.read`, `platform.projects.project.manage`                 | PLATFORM |
| Dashboard                                | `platform.dashboard.summary.read`                                                    | PLATFORM |
| Service operations                       | `platform.services.service.read`                                                     | PLATFORM |
| Job and queue operations                 | `platform.jobs.job.read`, `platform.jobs.job.manage`                                 | PLATFORM |
| AI/RAG operational status                | `platform.ai.operations.read`                                                        | PLATFORM |
| Integration metadata and operations      | `platform.integrations.integration.read`, `platform.integrations.integration.manage` | PLATFORM |
| Incident lifecycle                       | `platform.incidents.incident.read`, `platform.incidents.incident.manage`             | PLATFORM |
| Safe diagnostics                         | `platform.diagnostics.trace.read`                                                    | PLATFORM |

Permissions are checked individually on each endpoint even though the current
issuer workflow operates on fixed bundles. Self-grant remains forbidden,
executor and issuer remain distinct, and any authority mutation keeps its
existing snapshot-CAS, idempotency, audit, and last-operator safeguards.

## Resource and data boundaries

- Platform projections return identity and operational metadata only. They do
  not return passwords, hashes, tokens, MFA secrets, credentials, encrypted
  credentials, webhook secrets, tenant documents, chunks, prompts, embeddings,
  raw job payloads, or arbitrary logs.
- An organization or project identifier is only a locator. The repository
  resolves the resource and its owning organization from persisted data before
  applying a Platform action; a caller-supplied organization never establishes
  ownership or scope.
- Organization membership and role changes must reuse their domain state
  machines, last-ADMIN safeguards, current-version checks, and audit semantics.
  They must not call an Organization Admin controller with a Platform guard
  bypass.
- Job status and commands are sourced from the owning BullMQ queues. AI/RAG
  operations remain behind the external SAG/FastAPI boundary. Provider
  integrations remain owned by their respective adapters.
- A missing incident or diagnostic owner is not represented as healthy or as a
  successful empty result. Its contract must identify the external dependency
  and return a bounded safe unavailable response until an owner exists.

## Audit contract

Every Platform mutation writes a projected audit event containing event ID,
occurrence time, actor, action, resource type and ID, PLATFORM scope, result,
reason code where applicable, and request/correlation ID when available.
Sensitive mutation plus required audit failure is fail-closed; when MongoDB
transaction boundaries cover both writes, the mutation rolls back. Audit query
responses use a whitelisted projection with server-side bounded pagination and
filters; mixed event metadata is never serialized.

## API contract

Platform routes are rooted at `/api/v1/iam/platform`. Each route documents one
permission, `PLATFORM` scope, a strict request/response schema, bounded paging,
and safe `401/403/404/409/422/503` behavior as applicable. Mutations carrying
browser cookies require the existing CSRF pair. Side-effecting routes require
idempotency keys and a current-version precondition where the domain supports
them.

The OpenAPI document is the contract source for FE integration. It must match
the runtime route inventory exactly and must not claim runtime behavior for an
external dependency that is unavailable.

## Rollout and compatibility

All existing A-04 and V1 assignment records, permissions, session behavior, and
routes remain valid. New persisted fields or collections require additive,
reviewed-hash migrations; existing migrations are never edited. No production
records are silently adopted or rewritten. External authority assignment stays
out of the API and out of bootstrap seeds. Database changes and API/runtime
changes are handed off as separate deliverables when they require separate
migration ownership.
