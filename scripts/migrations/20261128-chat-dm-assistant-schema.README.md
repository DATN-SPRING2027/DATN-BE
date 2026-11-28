# Chat 1-1 `@continuumAI` Assistant — Additive MongoDB Schema & Index Migration

- **Migration:** `20261128-chat-dm-assistant-schema`
- **Owner:** Chat service (`continuum_chat`, MongoDB 7.0)
- **Branch:** `feat/Thang-continuum-ai-dm-db`
- **Canonical Contract:** `_docs-and-media/specs/continuum-ai-chat-rieng/tasks/contract.md` (§3)

## 1. Scope & Additive Storage Changes

This migration prepares the MongoDB foundation in `continuum_chat` for `@continuumAI` in 1-1 Direct Chat without mutating, backfilling, or dropping any existing human chat data or indexes:

| Collection | Change Type | Details |
| --- | --- | --- |
| `chat_conversation_messages` | Additive optional fields + `moderate` `$jsonSchema` validator + 2 partial indexes | Optional `contentVersion`, `authorType`, `assistantMention`, `triggerMessageId`, `assistantStatus`, `assistantFailureCode`, `assistantMeta`, `sourceReferences` (all assistant-only fields default to `undefined` in Mongoose so human documents remain untouched). |
| `chat_conversations` | Additive Mongoose field (no DDL needed) | Optional `contextRevision` (`int >= 0`, logical default `0`) for transactional optimistic concurrency checks. |
| `chat_members` | Additive Mongoose field (no DDL needed) | Optional `draftAssistantMention` (`boolean`, logical default `false`) to preserve `@continuumAI` draft selection across full/mini chat. |
| `chat_assistant_jobs` | New outbox collection + `strict` `$jsonSchema` validator + 4 indexes | Durable outbox/lease queue (`PENDING`, `PROCESSING`, `COMPLETED`, `INSUFFICIENT_EVIDENCE`, `CANCELLED`, `FAILED`) keyed uniquely by `triggerMessageId`. |

### Existing Indexes Preserved Untouched

All existing indexes on `chat_conversation_messages`, `chat_conversations`, `chat_members`, `chat_blocks`, `chat_notifications`, `chat_reports`, and `chat_uploads` remain untouched, including:
- `{ conversationId: 1, createdAt: -1, _id: -1 }`
- `{ conversationId: 1, content: 'text' }` (`chat_message_text_search` in Mongoose / `conversationId_1_content_text` on Atlas dev)
- `{ conversationId: 1, senderId: 1, clientMessageId: 1 }` (`unique: true`)
- `chat_messages_pinned_partial`, `chat_messages_attachments_kind_partial`
- Atlas Search index `chat_search_v1`

### New Additive Indexes (6)

| Collection | Index Name | Key | Options | Est. Size Impact |
| --- | --- | --- | --- | --- |
| `chat_conversation_messages` | `chat_messages_assistant_trigger_unique` | `{ conversationId: 1, triggerMessageId: 1 }` | `unique: true`, `partialFilterExpression: { authorType: 'ASSISTANT', triggerMessageId: { $type: 'objectId' } }` | **0 bytes** on pre-existing human messages (partial index only indexes `ASSISTANT` docs; ~64–96 B per AI message). |
| `chat_conversation_messages` | `chat_messages_assistant_source_refs_idx` | `{ conversationId: 1, 'sourceReferences.messageId': 1 }` | `partialFilterExpression: { authorType: 'ASSISTANT' }` | **0 bytes** on pre-existing human messages (~40–64 B per cited source entry on AI messages). |
| `chat_assistant_jobs` | `chat_assistant_jobs_trigger_unique` | `{ triggerMessageId: 1 }` | `unique: true` | ~48 B per job document. |
| `chat_assistant_jobs` | `chat_assistant_jobs_claim_idx` | `{ status: 1, nextAttemptAt: 1, lockedUntil: 1, createdAt: 1, _id: 1 }` | — | ~120 B per job document. |
| `chat_assistant_jobs` | `chat_assistant_jobs_conv_trigger_idx` | `{ organizationId: 1, conversationId: 1, triggerMessageId: 1 }` | — | ~96 B per job document. |
| `chat_assistant_jobs` | `chat_assistant_jobs_conv_status_created_idx` | `{ organizationId: 1, conversationId: 1, status: 1, createdAt: -1 }` | — | ~104 B per job document. |

**Apply Duration & Risk Impact:**
- Zero document rewrites or backfills (`rewriteDocuments: false`).
- Both new `chat_conversation_messages` indexes are partial on `authorType: 'ASSISTANT'`, so initial build scans existing docs once in the background (MongoDB 7 rolling/hybrid index build) and writes zero index entries until assistant messages exist (< 1s for < 100k messages).
- `validationLevel: 'moderate'` validates all new inserts and updates to valid existing documents while guaranteeing 100% legacy human documents remain readable and editable.

## 2. Usage (Dry-Run First, Hash-Bound Apply)

The script **never loads `.env`** automatically and always targets `continuum_chat`. Pass `CHAT_MONGODB_URI` (or `MONGODB_URI`) explicitly in the invoking shell.

### Step 1: Read-Only Dry-Run (Default)

```powershell
$env:CHAT_MONGODB_URI = '<reviewed MongoDB URI>'
node scripts/migrations/20261128-chat-dm-assistant-schema.mjs > chat-dm-assistant-dry-run.json
$report = Get-Content -LiteralPath chat-dm-assistant-dry-run.json -Raw | ConvertFrom-Json
```

Verify `clean: true`, `databaseName: "continuum_chat"`, `targetFingerprint`, `blockers: []`, and expected counts before applying. Exit code `2` indicates preflight blockers (duplicate `triggerMessageId`, incompatible index, validator conflict, or invalid documents).

### Step 2: Apply Reviewed Plan

Loopback target:

```powershell
node scripts/migrations/20261128-chat-dm-assistant-schema.mjs --apply "--expected-report-sha256=$($report.reportSha256)"
```

Shared / Atlas target (requires explicit confirmation env + flag):

```powershell
$env:CHAT_MIGRATION_CONFIRM_DATABASE = 'continuum_chat'
node scripts/migrations/20261128-chat-dm-assistant-schema.mjs --apply --allow-shared-database "--expected-report-sha256=$($report.reportSha256)"
```

Re-running `--apply` against an already-migrated database is a strict idempotent NOOP.

## 3. Rollback Procedure

1. **Immediate Runtime Kill-Switch (No DB Touch):** Set `CHAT_DM_ASSISTANT_ENABLED=false` and `CHAT_DM_ASSISTANT_WORKER_ENABLED=false`. Human chat continues operating normally and any already-posted AI messages remain readable under existing conversation ACLs.
2. **Schema & Index Rollback (After Worker & Mention Writes Are Paused and `activeJobCount === 0`):**

```powershell
node scripts/migrations/20261128-chat-dm-assistant-schema.mjs --rollback-plan > chat-dm-assistant-rollback-plan.json
$rb = Get-Content -LiteralPath chat-dm-assistant-rollback-plan.json -Raw | ConvertFrom-Json
node scripts/migrations/20261128-chat-dm-assistant-schema.mjs --rollback "--expected-report-sha256=$($rb.reportSha256)"
```

Rollback safety guarantees:
- Refuses while any `PENDING` or `PROCESSING` job exists in `chat_assistant_jobs`.
- Clears only the managed validators (refuses to touch unfamiliar validators).
- Drops only the 6 managed additive indexes (never drops `conversationId_1_content_text` or any other human chat index).
- Preserves `chat_conversation_messages` and historical `chat_assistant_jobs` documents by default; add `--drop-empty-jobs-collection` only if `chat_assistant_jobs` is confirmed empty (`0` documents) and should be removed.

## 4. Verification Commands

```powershell
npm run test:migrations:plan
node --test scripts/migrations/20261128-chat-dm-assistant-schema.mongodb.test.mjs
npx jest --runInBand src/services/chat/infrastructure/mongodb/chat-dm-assistant.schemas.spec.ts src/services/chat/infrastructure/mongodb/mongo-chat.repository.spec.ts
npm run lint
npm run typecheck
```
