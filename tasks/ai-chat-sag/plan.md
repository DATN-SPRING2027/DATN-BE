# AI Chat BFF <-> SAG Integration Plan (Approved)

## Status

Approved by Thang on 2026-10-28. Promoted OpenAPI 3.1 contract: `docs/openapi/ai-chat-sag.openapi.json`.

## Verified Repository Baselines

- `DATN_BE`: branch `feat/Thang-ai-chat-sag-bff-be-api` from `main` (`2325a8e`).
- `DATN_FE`: branch `feat/Thang-ai-chat-sag-bff-fe-ui` from `main` (`aa9e03c`).
- `sag-laya-integration`: `main` (`7f25331`) — includes `POST /api/v1/auth/continuum-login`, Project-scoped `conversation_owner_key`, and SAG-ECCE Dual Citations (`[1]` + `[S1]`). Zero SAG code changes required.

## Approved BFF Contract (`/api/v1/ai-chat/projects/{projectId}/...`)

1. `GET /threads?limit=20&offset=0` -> `Thread[]`
2. `POST /threads` (`{ title?: string }`) -> `201 Thread`
3. `PATCH /threads/{threadId}` (`{ title: string }`) -> `200 Thread`
4. `DELETE /threads/{threadId}` -> `204 No Content`
5. `GET /threads/{threadId}/messages?limit=40&cursor=...` -> `200 MessagePage`
6. `POST /threads/{threadId}/ask` (`{ query: string }`) -> `200 text/event-stream` (`started`, `step`, `delta`, and single terminal `completed` or `failed`)

## Security & Operational Invariants

- Every request validates Continuum session (`auth.getCurrentIdentity`) and Project read access (`projects.get(actor, projectId)`) before touching SAG.
- Cookie-authenticated mutations (`POST`, `PATCH`, `DELETE`) enforce constant-time CSRF double-submit validation (`__Host-csrf` / `continuum_csrf` / `csrf_token` vs `x-csrf-token`).
- Short-lived SAG tokens (`POST /api/v1/auth/continuum-login`) stay strictly in backend request memory; never logged, persisted, or returned to clients.
- `SAG_CHAT_STREAM_TIMEOUT_MS` (default `120000` ms) governs `/ask` SSE streams without auto-retrying LLM generation; `BACKEND_TIMEOUT_MS` governs fast JSON calls.
- Output DTOs strictly whitelist safe fields (`citations`, `sessionCitations`, `retrievalSteps`), stripping `prompt_preview`, raw tool `arguments`, and upstream stack traces.
