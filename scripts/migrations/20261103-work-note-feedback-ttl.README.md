# Migration: 20261103-work-note-feedback-ttl

## Purpose

Enforce the 180-day retention policy on the `work_note_assessment_feedback` collection via MongoDB native TTL index (`recordedAt: 1` with `expireAfterSeconds: 15552000`).

Because `autoIndex: false` is set by default in `mongodb.module.ts` for production performance, declaring the index on the Mongoose schema is insufficient without an explicit migration script.

## Indexes Created

1. **TTL Retention Index (180 days)**
   - Name: `assessment_feedback_retention_180d`
   - Key: `{ recordedAt: 1 }`
   - Option: `{ expireAfterSeconds: 15552000 }` (180 * 24 * 3600 seconds)
   - Function: Automatically purges feedback documents older than 180 days from `recordedAt`.

2. **Query Compound Index**
   - Name: `assessment_feedback_version_purpose_category`
   - Key: `{ promptVersion: 1, purpose: 1, category: 1, recordedAt: -1 }`
   - Function: Optimizes dashboard / aggregation queries by prompt version, note purpose, and feedback category sorted by recency.

## Usage

### 1. Dry Run / Inspect (No writes)

```bash
WORKNOTE_MIGRATION_URI="mongodb://127.0.0.1:27017/continuum_capture" node scripts/migrations/20261103-work-note-feedback-ttl.mjs --inspect
```

### 2. Apply Migration

```bash
WORKNOTE_MIGRATION_URI="mongodb://127.0.0.1:27017/continuum_capture" node scripts/migrations/20261103-work-note-feedback-ttl.mjs --apply
```

## Safety Guarantees

- **Loopback-Only Target**: Rejects any non-loopback MongoDB target (`localhost`, `127.0.0.1`, `[::1]`).
- **No Production Invocation**: Fails fast if `NODE_ENV === 'production'`.
- **Idempotent**: Verifies existing index names, keys, and options before creating. Safe to run multiple times.
- **Zero Data Modification**: Only creates indexes; does not alter, delete, or inspect document contents.
- **Zero Secret Logging**: Errors do not leak connection URIs, credentials, or collection data.

