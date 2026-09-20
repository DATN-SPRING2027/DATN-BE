# Continuum AI Backend Agent Guide

## Architecture

- This repository is one NestJS `backend-core` modular monolith, not a collection of deployable microservices.
- Domain boundaries are `iam`, `capture`, `jira`, `lifecycle`, `chat`, `handover`, `ingestion`, and `notification`.
- FastAPI/SAG is an external service behind `integrations/ai-engine`; do not embed Python or SAG persistence here.
- Keep repositories and persistence adapters private to their owning module. Cross-module collaboration uses an exported application contract or an approved domain event.

## Mandatory Gates

- Do not add MongoDB schemas, migrations, indexes, or backfills until the database ownership ADR is accepted.
- Do not choose LanceDB, PostgreSQL/pgvector, or Qdrant here until the SAG storage ADR is accepted.
- Business APIs are contract-first. Approve OpenAPI request, response, error, scope, pagination, and streaming semantics before implementation.
- Treat files, webhooks, Jira data, user input, and AI output as untrusted.
- Permission filtering happens before evidence is sent to the AI engine.

## Development Workflow

- Use strict TypeScript and dependency injection.
- Write a failing test before adding behavior.
- Run `npm run check` before handoff.
- Never commit secrets; update `.env.example` only with safe placeholders.
- After the initial root commit, use a focused branch and pull request for every change.
