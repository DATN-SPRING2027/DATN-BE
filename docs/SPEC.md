# Spec: Continuum AI Backend Bootstrap

## Objective

Create the first runnable backend repository for Continuum AI. The repository hosts one NestJS `backend-core` modular monolith with eight bounded-context module boundaries and a separate integration boundary for the external FastAPI/SAG engine.

This bootstrap proves the application can start, validate configuration, expose health status and generate Swagger documentation. It intentionally does not implement business endpoints, MongoDB schemas, queues or external integrations whose contracts have not been approved.

## Tech Stack

- Node.js 20 or later.
- NestJS 11.2.x and TypeScript in strict mode. Nest CLI 11 is pinned for the initial scaffold because the current Nest CLI 12 toolchain requires a newer Node 24 patch than the development host provides.
- Jest and Supertest for unit and end-to-end tests.
- Swagger/OpenAPI for HTTP contract documentation.
- `class-validator` and `class-transformer` for request-boundary validation.
- `@nestjs/config` with fail-fast environment validation.
- Helmet for baseline HTTP security headers.

Approved future infrastructure is MongoDB/Mongoose, Redis/BullMQ and Cloudflare R2. Those adapters are not added in this bootstrap.

## Commands

- Install: `npm ci`
- Develop: `npm run start:dev`
- Lint: `npm run lint`
- Type-check: `npm run typecheck`
- Unit tests: `npm test`
- End-to-end tests: `npm run test:e2e`
- Build: `npm run build`
- Full verification: `npm run check`

## Project Structure

```text
src/
├── common/                    # Cross-cutting HTTP primitives with no domain ownership
├── config/                    # Typed and validated runtime configuration
├── health/                    # Infrastructure health endpoint
├── integrations/
│   └── ai-engine/             # Future internal client boundary for FastAPI/SAG
└── modules/
    ├── iam/                   # Identity, membership, role and capability boundary
    ├── capture/               # Daily work-note capture boundary
    ├── jira/                  # Jira synchronization boundary
    ├── lifecycle/             # Knowledge lifecycle and verification boundary
    ├── chat/                  # Evidence-grounded assistant boundary
    ├── handover/              # Knowledge transfer boundary
    ├── ingestion/             # Source and document ingestion boundary
    └── notification/          # Notification boundary
test/                          # End-to-end tests
docs/                          # Repository-local specifications and decisions
tasks/                         # Plans and executable task checklists
```

Each domain module owns its future controllers, application services and persistence adapters. One module must not directly access another module's internal collection or repository. Cross-domain collaboration uses an exported application contract or an approved domain event.

## Code Style

```ts
@Controller('health')
export class HealthController {
  @Get()
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
```

Use strict TypeScript, dependency injection, descriptive domain names and small modules. Controllers map transport input/output; application services own use-case orchestration; infrastructure adapters own external systems.

## Testing Strategy

- Unit-test deterministic application behavior close to the owning module.
- Use end-to-end tests for HTTP status, response shape, validation and global middleware.
- Add contract tests before integrating Jira, R2 or FastAPI/SAG.
- Add authorization-denial tests before exposing protected resources.
- Bootstrap coverage proves `/api/v1/health`, Swagger generation and application startup.

## Boundaries

### Always

- Validate all external input at the transport boundary.
- Use the global `/api/v1` prefix and a consistent structured-error contract once approved.
- Treat user, Jira, file, webhook and AI output as untrusted.
- Run `npm run check` before every handoff.
- Keep secrets in runtime configuration and commit only `.env.example`.

### Ask first

- Add or change MongoDB schema, index, migration or backfill.
- Add a public endpoint or change request/response/error semantics.
- Add Jira, R2, email, LLM or SAG credentials and network integrations.
- Add a dependency not already approved by the bootstrap specification.
- Change CORS, authentication, authorization or rate-limit policy.

### Never

- Split the eight contexts into independent NestJS deployments without an accepted ADR.
- Let one module read another module's internal persistence directly.
- Let AI output write directly to MongoDB or become verified knowledge.
- Retrieve unauthorized evidence and filter it only after it reaches an LLM.
- Commit secrets or persist plaintext refresh tokens/external credentials.

## Success Criteria

- A clean checkout installs reproducibly with `npm ci`.
- Lint, type-check, unit tests, end-to-end tests and production build pass.
- `GET /api/v1/health` returns HTTP 200 with a stable minimal response.
- Swagger starts without defining unapproved business contracts.
- All eight backend domain boundaries exist inside one NestJS application.
- The repository history starts with a Continuum-owned root commit on `main`.

## Open Questions and Mandatory Gates

1. Database ownership is unresolved: operational docs describe one MongoDB-backed modular monolith while database design describes database-per-service. Stop before schema or migration work.
2. SAG persistence is unresolved between LanceDB and PostgreSQL/pgvector or Qdrant. This repo may expose only a provider-neutral integration boundary until an ADR is accepted.
3. Endpoint examples are not contracts. Approve shared OpenAPI request, response, error, auth/scope, pagination and streaming semantics before FE and BE implement a business API independently.
4. Jira OAuth/webhook verification, R2 signing and LLM provider decisions require focused security/contract tasks.
