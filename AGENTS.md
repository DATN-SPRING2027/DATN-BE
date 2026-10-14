# Continuum AI Backend Agent Guide

## Architecture

- **Current runtime:** The existing backend-core runtime is a NestJS modular monolith under workspace DEC-013. This describes the current runtime and remains the general default for existing domains.
- **Target architecture:** Microservices are the Continuum AI target. Workspace DEC-018 scopes the accepted Task service boundary in ADR-010: Task is intended to run as an independently runnable process in this repository, with its own logical database continuum_task.
- **Activation gate:** Task is not currently an active runtime or database owner. Do not register or deploy Task, add its runtime handlers/controllers/APIs, or connect production callers until its D-03 foundation is reviewed and merged and ADR-003's accountable runtime owner and migration/seed workflow are established. Disposable database initialization used by D-03 tests does not activate or provision the production database.
- Domain boundaries are `iam`, `capture`, `jira`, `lifecycle`, `chat`, `handover`, `ingestion`, and `notification`.
- FastAPI/SAG is an external service behind `integrations/ai-engine`; do not embed Python or SAG persistence here.
- Keep repositories and persistence adapters private to their owning module. Cross-module collaboration uses an exported application contract or an approved domain event.

## Mandatory Gates

- Database ownership follows accepted ADR-003/DEC-011: MongoDB 7.0 is the operational source of truth; each active bounded service owns its logical database on the configured cluster, with cross-cutting audit in `continuum_audit`. Do not add a shared `continuum_db` runtime path. Keep service collection, index and migration ownership local.
- Task's continuum_task is a target logical database only. Keep it out of the active runtime inventory until the Task runtime owner and migration/seed workflow required by ADR-003 are established.
- Do not choose LanceDB, PostgreSQL/pgvector, or Qdrant here until the SAG storage ADR is accepted.
- Business APIs are contract-first. Approve OpenAPI request, response, error, scope, pagination, and streaming semantics before implementation.
- Treat files, webhooks, Jira data, user input, and AI output as untrusted.
- Permission filtering happens before evidence is sent to the AI engine.
- Every authenticated endpoint that reads or changes organization-scoped data (including future project/task APIs) must validate the User's `ACTIVE` Organization Membership on the server; a client context or RoleAssignment alone is insufficient.

## Development Workflow

- Use strict TypeScript and dependency injection.
- Write a failing test before adding behavior.
- Run `npm run check` before handoff.
- Never commit secrets; update `.env.example` only with safe placeholders.
- After the initial root commit, use a focused branch and pull request for every change.
