# Implementation Plan: Continuum AI Backend Bootstrap

## Overview

Initialize a production-oriented NestJS repository for the Continuum `backend-core`. The result is a runnable modular monolith with configuration, health, Swagger and eight explicit domain boundaries. Business APIs, persistence and third-party behavior remain outside this bootstrap.

## Architecture Decisions

- One NestJS application and deployment contains all eight bounded contexts.
- Pin Nest CLI 11.0.24 and Nest core 11.2.x for the root scaffold; treat a Nest 12 upgrade as an isolated dependency task after the supported Node runtime is available.
- FastAPI/SAG remains a separate service reached later through `integrations/ai-engine`.
- Domain modules export only deliberate application contracts; their persistence remains private.
- HTTP routes use the `/api/v1` prefix. Swagger documents only implemented contracts.
- Environment configuration fails fast; no runtime secret has an insecure source default.
- No persistence package or schema is introduced before the database conflict gate is resolved.

## Dependency Graph

```text
NestJS strict scaffold
  ├── runtime configuration
  │     └── application bootstrap
  │            ├── global validation
  │            ├── Helmet
  │            └── Swagger
  ├── health module
  │     └── unit + e2e verification
  └── domain module boundaries
        └── future contract-first vertical slices
```

## Phase 1: Specification and Toolchain

### Task 1: Record bootstrap specification

**Acceptance criteria:**

- Objective, commands, structure, testing and boundaries are documented.
- Database, SAG and API contract gates are explicit.

**Verification:**

- Review `docs/SPEC.md` against the canonical Document repository.

**Dependencies:** None

**Files:** `docs/SPEC.md`, `tasks/plan.md`, `tasks/todo.md`

**Scope:** Medium

### Task 2: Generate strict NestJS project

**Acceptance criteria:**

- NestJS TypeScript project uses strict compiler settings.
- npm is the only package manager and one lockfile is committed.
- Project name and scripts identify Continuum `backend-core`.

**Verification:**

- `npm ci`
- `npm run typecheck`

**Dependencies:** Task 1

**Files:** Nest CLI root configuration files

**Scope:** Medium

### Checkpoint A: Toolchain

- Project installs from lockfile.
- No competing package manager or secret file exists.

## Phase 2: Safe Application Bootstrap

### Task 3: Add validated runtime configuration

**Acceptance criteria:**

- `PORT`, `NODE_ENV` and Swagger toggle are parsed and validated.
- Invalid required configuration fails during startup.
- `.env.example` contains placeholders only.

**Verification:**

- Unit test accepts valid configuration and rejects invalid values.

**Dependencies:** Task 2

**Files:** `.env.example`, `src/config/*`

**Scope:** Medium

### Task 4: Configure HTTP platform defaults

**Acceptance criteria:**

- Global prefix is `/api/v1`.
- Global ValidationPipe whitelists fields, transforms input and rejects unknown fields.
- Helmet is active and Swagger is created only when enabled.

**Verification:**

- Application compiles and e2e startup succeeds.

**Dependencies:** Task 3

**Files:** `src/main.ts`, bootstrap helpers

**Scope:** Small

### Task 5: Implement health vertical slice

**Acceptance criteria:**

- `GET /api/v1/health` returns `{ "status": "ok" }` with HTTP 200.
- Health response is documented in Swagger.
- Unit and end-to-end tests assert the public behavior.

**Verification:**

- `npm test`
- `npm run test:e2e`

**Dependencies:** Task 4

**Files:** `src/health/*`, `test/*`

**Scope:** Medium

### Checkpoint B: Runnable Core

- Lint, type-check, tests and build pass.
- Application starts without MongoDB, Redis, R2 or SAG.

## Phase 3: Modular-Monolith Boundaries

### Task 6: Establish IAM and Capture boundaries

**Acceptance criteria:**

- `IamModule` and `CaptureModule` exist and are imported by `AppModule`.
- Modules expose no placeholder HTTP endpoints or persistence models.

**Verification:**

- Nest testing module compiles.

**Dependencies:** Task 2

**Files:** `src/modules/iam/*`, `src/modules/capture/*`, `src/app.module.ts`

**Scope:** Medium

### Task 7: Establish Jira and Lifecycle boundaries

**Acceptance criteria:**

- `JiraModule` and `LifecycleModule` exist and are imported.
- External Jira behavior and knowledge state transitions remain unimplemented.

**Verification:**

- Nest testing module compiles.

**Dependencies:** Task 2

**Files:** corresponding module files and `src/app.module.ts`

**Scope:** Medium

### Task 8: Establish Chat and Handover boundaries

**Acceptance criteria:**

- `ChatModule` and `HandoverModule` exist and are imported.
- No unapproved SSE, WebSocket or SAG payload is invented.

**Verification:**

- Nest testing module compiles.

**Dependencies:** Task 2

**Files:** corresponding module files and `src/app.module.ts`

**Scope:** Medium

### Task 9: Establish Ingestion and Notification boundaries

**Acceptance criteria:**

- `IngestionModule` and `NotificationModule` exist and are imported.
- No R2, BullMQ or mail provider implementation is introduced.

**Verification:**

- Nest testing module compiles.

**Dependencies:** Task 2

**Files:** corresponding module files and `src/app.module.ts`

**Scope:** Medium

### Task 10: Add provider-neutral AI integration boundary

**Acceptance criteria:**

- `AiEngineModule` reserves the external-service boundary.
- No SAG-specific DTO leaks into domain modules.
- The module performs no network request in the bootstrap.

**Verification:**

- Nest testing module compiles without FastAPI/SAG running.

**Dependencies:** Task 2

**Files:** `src/integrations/ai-engine/*`, `src/app.module.ts`

**Scope:** Small

### Checkpoint C: Architecture

- One Nest application contains all eight domain modules.
- FastAPI/SAG remains an external integration boundary.
- No schema, migration or business API exists.

## Phase 4: Quality and Initial Delivery

### Task 11: Run quality and security gates

**Acceptance criteria:**

- Lint, type-check, tests, e2e and build pass.
- Package audit has no unmitigated reachable high/critical vulnerability.
- Secret scan and staged diff review pass.

**Verification:**

- `npm run check`
- `npm audit --audit-level=high`
- manual staged diff review

**Dependencies:** Tasks 3–10

**Files:** verification only

**Scope:** Small

### Task 12: Publish root commit

**Acceptance criteria:**

- Git history contains one Continuum-owned root commit.
- `origin/main` points to that commit.
- No pull request or merge is created for the explicit repository-initialization exception.

**Verification:**

- `git rev-list --max-parents=0 HEAD`
- `git ls-remote origin refs/heads/main`

**Dependencies:** Task 11

**Files:** Git metadata only

**Scope:** Small

## Risks and Mitigations

| Risk                                                 | Impact | Mitigation                                                                  |
| ---------------------------------------------------- | -----: | --------------------------------------------------------------------------- |
| Documentation suggests nine deployable Nest services |   High | Enforce one `backend-core`; treat names as bounded contexts only.           |
| DB docs conflict with operational topology           |   High | Do not install persistence/schema code; require explicit ADR first.         |
| Endpoint examples become accidental contracts        |   High | Expose only health; require shared OpenAPI for business APIs.               |
| Empty modules create false progress                  | Medium | Treat them as ownership boundaries, not completed features.                 |
| Early external integrations leak credentials or data |   High | Add each integration in a separate threat-modeled task with contract tests. |
| Cross-module collection access couples domains       |   High | Export application contracts/domain events; keep repositories private.      |

## Future Vertical-Slice Order After Bootstrap

1. Resolve DB/SAG ADRs and approve shared API/error/auth conventions.
2. IAM authentication plus membership/permission enforcement.
3. Manual daily note capture and author confirmation.
4. Jira backfill, webhook idempotency and note prefill.
5. R2 upload plus ingestion job orchestration.
6. Proposed Knowledge lifecycle and human verification.
7. Permission-aware cited chat and insufficient-evidence handling.
8. Handover package and successor learning workflow.

Each slice must receive its own DB/BE/FE branches as applicable.

## Active Follow-up: IAM API Contract v1

### Objective

Define the reviewable OpenAPI contract that allows frontend and backend work on
authentication, users, projects, project memberships, teams and team
memberships to proceed independently. This change documents HTTP behavior only;
it does not add controllers, DTOs, persistence or seed data.

### Contract decisions

- The public base path is `/api/v1`; resource paths use plural nouns.
- JSON fields and query parameters use `camelCase`.
- Resource identifiers are opaque strings; timestamps are ISO-8601 UTC strings.
- List operations use `page` and `pageSize`, defaulting to `1` and `20`, with a
  maximum `pageSize` of `100`.
- Successful single-resource responses return the resource directly. Successful
  list responses return `{ data, pagination }`.
- Errors always return `code`, `message`, `details` and `requestId`.
- Protected operations use bearer JWT access tokens. Login and refresh return
  token pairs to the trusted BFF; browser code must not store tokens in web
  storage.
- Membership deletion is idempotent and returns `204`; it removes the active
  relationship from the API view. Persistence semantics remain an
  implementation decision as long as the public behavior is preserved.

### Task 13: Add contract conformance tests

**Acceptance criteria:**

- The OpenAPI document is valid JSON and declares OpenAPI 3.1.
- Tests enforce the base path, pagination bounds, opaque string IDs, UTC
  timestamps, unique operation IDs and the standard error shape.

**Verification:** `npm test -- --runInBand`

**Dependencies:** Approved task requirements

**Files:** `src/contracts/iam-openapi.spec.ts`

**Scope:** Small

### Task 14: Define IAM OpenAPI document

**Acceptance criteria:**

- Auth, User, Project, Project Membership, Team and Team Membership schemas and
  operations are documented.
- Authentication, authorization and `401/403/404/409/422/429` semantics are
  explicit per operation.
- The document contains no server URI, credential value or secret.

**Verification:** focused contract tests plus manual OpenAPI review

**Dependencies:** Task 13

**Files:** `docs/openapi/iam-v1.openapi.json`

**Scope:** Medium

### Checkpoint D: Contract review readiness

- `npm run check` passes.
- Secret scan and final diff review pass.
- No business endpoint or database behavior has been implemented.
- The PR targets `main` and remains open for human contract review.
