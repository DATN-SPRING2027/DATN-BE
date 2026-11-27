# Continuum System-Wide MCP Server & Production Deployment Guide

## 1. Feature Overview

Continuum exposes a stateless **Streamable HTTP JSON-RPC 2.0 Model Context Protocol (MCP)** server across all 6 core subsystems so external AI coding assistants (**Google Antigravity, Claude Code CLI, Cursor, Claude Desktop, VS Code Copilot, Windsurf**) can read context, execute governed workflows, and query grounded SAG knowledge using personal SHA-256 API keys (`ctm_mcp_...`).

### Key Implemented Components (`DATN-BE`)

| Layer | Module / File | Responsibility |
| :--- | :--- | :--- |
| **MCP Protocol Server** | `src/mcp/mcp.controller.ts`, `src/mcp/mcp.service.ts` | Handles `GET` discovery (or `405` on passive `text/event-stream` probe), `POST` JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `202` notifications), and `DELETE` on `/api/v1/mcp` & `/internal/mcp`. |
| **Catalog & Runtime Validation** | `src/mcp/mcp-tools.catalog.ts`, `src/mcp/mcp-schema-validator.ts` | Canonical registry of **28 tools**, **2 resources**, and **4 prompts** with strict JSON Schema validation (`additionalProperties: false`, bounded depth `<= 32` + `WeakSet` cycle guard). |
| **Tool Dispatcher & Guardrails** | `src/mcp/mcp-tools.service.ts` | Executes all 6 subsystems, auto-resolves optimistic concurrency `If-Match` ETags, enforces `READ_ONLY` / `READ_WRITE` / `FULL_OPERATIONS` scope checks (including dynamic escalation for `continuum_ask_knowledge` `persistThread: true`, `continuum_save_work_report_draft` `submit: true`, `continuum_chat` `SEND_MESSAGE`, `continuum_notifications` `MARK_READ`/`MARK_ALL_READ`), and checks `allowedProjectIds`. |
| **Personal MCP API Key Vault** | `src/services/iam/controllers/mcp-api-keys.controller.ts`, `src/services/iam/application/mcp-api-keys/mcp-api-keys.service.ts` | Generates `ctm_mcp_<43-char-base64url>` secrets (32-byte CSPRNG), stores only SHA-256 digest + 16-char `keyPrefix` in MongoDB `continuum_iam.mcp_api_keys`, supports list / mint / revoke with live RBAC intersection. |
| **REST Mutation Boundary** | `src/common/http/mcp-key-rest-guard.middleware.ts` | Blocks `ctm_mcp_` tokens from mutating non-MCP REST endpoints (`POST`, `PUT`, `PATCH`, `DELETE` outside `/api/v1/mcp` and `/internal/mcp`) with `403 MCP_KEY_DIRECT_MUTATION_FORBIDDEN`. |
| **API Gateway Proxy** | `src/gateway/gateway-mcp.controller.ts`, `src/gateway/gateway-iam.controller.ts` | Forwards `/api/v1/mcp` (`GET`/`POST`/`DELETE`) and `/api/v1/iam/mcp-api-keys` to upstream MCP/IAM hosts with `SAG_CHAT_STREAM_TIMEOUT_MS` budget (`120s` default) and preserves MCP session/protocol/auth headers. |
| **SAG Bridge Upgrades** | `src/integrations/ai-engine/ai-chat.service.ts`, `src/integrations/ai-engine/http-ai-engine.client.ts` | Adds project-scoped `searchKnowledge` (`POST /api/v1/search`) and `askKnowledgeQuestion` (`persistThread?: boolean`, returning `threadPersisted`). |

### Capability Matrix Summary

- **28 Tools:**
  - *IAM & Projects (4):* `continuum_get_context`, `continuum_list_projects`, `continuum_get_project`, `continuum_list_project_members`
  - *Tasks & Sprints (8):* `continuum_list_tasks`, `continuum_get_task`, `continuum_get_project_task_summary`, `continuum_list_sprints`, `continuum_create_task`, `continuum_update_task`, `continuum_transition_task`, `continuum_add_task_comment`
  - *Work Notes, Documents & Reports (7):* `continuum_list_work_notes`, `continuum_get_work_note`, `continuum_create_work_note`, `continuum_list_documents`, `continuum_create_document`, `continuum_list_work_reports`, `continuum_save_work_report_draft`
  - *Knowledge Handover (5):* `continuum_list_handovers`, `continuum_get_handover`, `continuum_preview_departing_handover`, `continuum_create_and_bundle_handover`, `continuum_act_on_handover`
  - *SAG Knowledge & Grounded Q&A (2):* `continuum_search_knowledge`, `continuum_ask_knowledge` (supports optional `persistThread: true` under `READ_WRITE` scope)
  - *Team Chat & Notifications (2):* `continuum_chat` (blocked when key is project-restricted), `continuum_notifications` (scoped by `allowedProjectIds`)
- **2 Resources:** `continuum://server/manifest`, `continuum://projects/{projectId}/overview`
- **4 Prompts:** `continuum_daily_standup`, `continuum_capture_engineering_decision`, `continuum_handover_readiness_audit`, `continuum_project_onboarding_pack`

---

## 2. Local vs. Production DNS & Domain Checklist (DO NOT SKIP ON DEPLOY)

What works automatically on `http://localhost:3001` / `http://localhost:3000` requires explicit environment, DNS, proxy, and database index configuration when deploying behind real production domains.

### A. Choose Your Production DNS Topology

#### Topology A — Single Domain (Recommended Simplicity)
- **Public URL:** `https://app.yourdomain.com`
- **Routing:** Browser + IDE clients call `https://app.yourdomain.com/api/backend/mcp` (Next.js BFF proxies internally over Docker/VPC to `CONTINUUM_API_BASE_URL`, e.g. `http://api-gateway:3000` or `http://backend:3001`).
- **Required Env Vars:**
  - **BE:** `CORS_ALLOWED_ORIGINS=https://app.yourdomain.com`, `CONTINUUM_WEB_BASE_URL=https://app.yourdomain.com`, `WEB_APP_URL=https://app.yourdomain.com`
  - **FE:** Leave `NEXT_PUBLIC_CONTINUUM_API_URL` empty (blank). `/docs` and `/organization/integrations` automatically resolve `window.location.origin + "/api/backend/mcp"`.

#### Topology B — Split Domain / Dedicated API Subdomain (Lowest Latency for MCP Clients)
- **Public URLs:** `https://app.yourdomain.com` (FE) + `https://api.yourdomain.com` (BE / Nginx / Gateway)
- **Routing:**
  - Web UI / Integrations Manager calls Same-Origin BFF (`https://app.yourdomain.com/api/backend/iam/mcp-api-keys`), OR browser CORS hits `https://api.yourdomain.com`.
  - IDE/CLI clients (`Antigravity`, `Cursor`, `Claude Code`) connect directly to `https://api.yourdomain.com/api/v1/mcp` without hopping through Next.js.
- **Required Env Vars:**
  - **BE:**
    - `CORS_ALLOWED_ORIGINS=https://app.yourdomain.com` (now wired dynamically in `src/bootstrap.ts` via `resolveCorsAllowedOrigins`)
    - `CONTINUUM_WEB_BASE_URL=https://app.yourdomain.com`
    - `WEB_APP_URL=https://app.yourdomain.com`
    - `CHAT_ALLOWED_ORIGINS=https://app.yourdomain.com`
  - **FE:**
    - `NEXT_PUBLIC_CONTINUUM_API_URL=https://api.yourdomain.com` (causes `/docs` and `/organization/integrations` to generate IDE snippets pointing straight to `https://api.yourdomain.com/api/v1/mcp` and recommend Direct API mode).

---

### B. Required Backend Environment Variables for MCP & SAG

| Variable | Why Needed in Production | Example Value |
| :--- | :--- | :--- |
| `CORS_ALLOWED_ORIGINS` | Without this, `enableCors` previously defaulted only to `localhost:3000`. Required when FE runs on a real domain (`https://app.yourdomain.com`). | `https://app.yourdomain.com` |
| `MCP_SERVICE_URL` | **Critical in Microservices Mode (`docker-compose.microservices.yml`)!** Standalone `dist/services/iam/main.js` does **not** mount `McpModule` (only `AppModule` `dist/main.js` mounts all 6 domain services + `McpModule`). Point `api-gateway`'s `MCP_SERVICE_URL` to a monolith/MCP runner container so `GatewayMcpController` does not fail calling standalone IAM. | `http://mcp-server:3001` |
| `GATEWAY_TRUSTED_PROXY_CIDRS` | Required in `NODE_ENV=production` by `src/gateway/main.ts` so client IPs and rate limits work behind Nginx/ALB/Cloudflare. | `172.16.0.0/12,10.0.0.0/8` |
| `SAG_API_BASE_URL` | Required for `continuum_search_knowledge` & `continuum_ask_knowledge` to talk to SAG AI Engine over private network. | `http://sag-engine:8000` |
| `SAG_BFF_SERVICE_TOKEN` | Shared 32+ char secret matching SAG server config. | `<32+ char secret>` |
| `SAG_CHAT_STREAM_TIMEOUT_MS` | Budget for `GatewayMcpController` & SSE collection inside `askKnowledgeQuestion`. Keep `>= 120000`. | `120000` |
| `JWT_SECRET` & `IAM_GATEWAY_SECRET` | Distinct 32+ char secrets for IAM auth and Gateway ↔ IAM internal verification. | `<32+ char secrets>` |
| `MONGODB_AUTO_INDEX` | Keep `false` in production; run the manual `mcp_api_keys` index creation script below! | `false` |

---

### C. Reverse Proxy, TLS & WAF Rules (Nginx / Cloudflare / ALB)

1. **HTTPS Required for IDE Clients:** Remote MCP hosts (Cursor, Claude Code, VS Code, Antigravity) expect valid TLS certificates (`TLS 1.2/1.3`) when connecting over public DNS. Do **not** terminate HTTP-only on public domains.
2. **Disable Request/Response Buffering & Raise Timeout (`>= 180s`):**
   - `continuum_ask_knowledge` aggregates SAG SSE reasoning streams that can run 30–120 seconds.
   - Ensure `nginx/nginx.conf` (updated in this PR with a dedicated `location ~ ^/api/v1/mcp/?$` block) sets `proxy_buffering off`, `proxy_request_buffering off`, `proxy_read_timeout 180s`, and `proxy_send_timeout 180s` on **both** `/api/v1/mcp` (BE) and `/api/backend/mcp` (if proxying FE in Topology A).
3. **Preserve MCP & Auth Headers Through CDN / Reverse Proxy:**
   - Do **not** strip `Authorization`, `Mcp-Session-Id`, `MCP-Protocol-Version`, `Last-Event-ID`, or `X-Request-Id`.
   - Allow `GET`, `POST`, `DELETE`, `OPTIONS` on `/api/v1/mcp` and `/api/backend/mcp`.
4. **Cloudflare / WAF Bot Protection Exception (Common Silent Production Bug!):**
   - Non-browser IDE agents (`Antigravity`, `Cursor`, `Claude Code`, `curl`, `mcp-remote`) do **not** execute JavaScript Turnstile/Bot-Fight challenges and do not send browser `User-Agent` cookies.
   - Add a **WAF Skip Rule** on `/api/v1/mcp*` and `/api/backend/mcp*` for Bot Fight Mode / JS Challenge while retaining TLS and DDoS rate limiting.

---

### D. MongoDB Production Index Migration (`MONGODB_AUTO_INDEX=false`)

In production, Mongoose automatic indexing is disabled (`MONGODB_AUTO_INDEX=false`). **Before releasing MCP API Keys to production users**, create both indexes in the `continuum_iam` database:

```javascript
use continuum_iam;

db.mcp_api_keys.createIndex(
  { keyHash: 1 },
  { unique: true, name: "mcp_api_key_hash_unique" }
);

db.mcp_api_keys.createIndex(
  { organizationId: 1, userId: 1, createdAt: -1, _id: -1 },
  { name: "mcp_api_key_owner_list" }
);
```

Without `mcp_api_key_hash_unique`, every Bearer `ctm_mcp_` request falls back to a full collection scan on `mcp_api_keys`.

---

## 3. Post-Deploy Production Verification Checklist

Run these smoke checks against your deployed domain immediately after rollout:

```bash
# 1. Unauthenticated discovery must reject with HTTP 401 + WWW-Authenticate: Bearer (NOT HTTP 403 CAPTCHA)
curl -i -X POST "https://api.yourdomain.com/api/v1/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# 2. Initialize & list all 28 tools with a personal key minted from /organization/integrations
curl -sS -X POST "https://api.yourdomain.com/api/v1/mcp" \
  -H "Authorization: Bearer ctm_mcp_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools | length'
# Expect: 28

# 3. Verify REST mutation boundary blocks ctm_mcp_ outside /api/v1/mcp (HTTP 403 MCP_KEY_DIRECT_MUTATION_FORBIDDEN)
curl -i -X POST "https://api.yourdomain.com/api/v1/iam/mcp-api-keys" \
  -H "Authorization: Bearer ctm_mcp_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"escape-attempt","scope":"READ_ONLY"}'
# Expect: 403 MCP_KEY_DIRECT_MUTATION_FORBIDDEN

# 4. Verify live SAG search & chat reachability (replace <PROJECT_ID>)
curl -sS -X POST "https://api.yourdomain.com/api/v1/mcp" \
  -H "Authorization: Bearer ctm_mcp_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"continuum_search_knowledge","arguments":{"projectId":"<PROJECT_ID>","query":"architecture"}}}'
```
