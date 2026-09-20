# Continuum AI Backend

NestJS `backend-core` for Continuum AI, an organizational knowledge-continuity platform. This repository starts as one modular monolith; FastAPI/SAG remains a separate service.

## Current scope

The initial repository provides:

- strict TypeScript and validated environment configuration;
- HTTP security headers, global input validation and `/api/v1` routing;
- Swagger for implemented contracts only;
- `GET /api/v1/health` with unit and end-to-end coverage;
- eight explicit domain-module boundaries;
- a provider-neutral boundary for the external AI engine.

It deliberately contains no business endpoint, database schema, queue, cloud-storage client or AI network call yet.

## Requirements

- Node.js 20 or later
- npm 10 or later

## Local development

```bash
npm ci
cp .env.example .env
npm run start:dev
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

- API health: `http://localhost:3001/api/v1/health`
- Swagger UI: `http://localhost:3001/docs` when `SWAGGER_ENABLED=true`

## Quality commands

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run check
```

## Module boundaries

| Module       | Responsibility                                                         |
| ------------ | ---------------------------------------------------------------------- |
| IAM          | Identity, project/team membership, roles, assignments and capabilities |
| Capture      | Manual daily notes and future work-activity capture                    |
| Jira         | Jira import, synchronization and webhook boundary                      |
| Lifecycle    | Proposed knowledge, verification, ownership and version lifecycle      |
| Chat         | Permission-aware, evidence-grounded knowledge assistant                |
| Handover     | Knowledge transfer and successor workflow                              |
| Ingestion    | Files, parsing, OCR and background ingestion orchestration             |
| Notification | Reminders and delivery orchestration                                   |

These are bounded contexts inside one NestJS deployment, not independent microservices. See [the bootstrap specification](docs/SPEC.md) and [implementation plan](tasks/plan.md).

## Architecture gates

Database ownership and SAG storage are unresolved in the source documents. Do not add persistence until those decisions are recorded in accepted ADRs. Business routes must start from approved OpenAPI contracts so FE and BE do not independently invent payloads.

## Environment

| Variable          |       Default | Meaning                                    |
| ----------------- | ------------: | ------------------------------------------ |
| `NODE_ENV`        | `development` | `development`, `test`, or `production`     |
| `PORT`            |        `3001` | HTTP port from 1 through 65535             |
| `SWAGGER_ENABLED` |       `false` | Enables `/docs`; the local example opts in |

Never commit `.env` or credentials.
