# Platform session fence and V2 authority schema — DB v1

## Scope

This database deliverable adds Mongoose persistence support for the Platform Operator V2 permission bundle and session-family revocation metadata:

- `platform_authority_assignments.permission` accepts the approved V2 permissions.
- `platform_authority_change_operations` accepts `V1_EXPAND` and `V2_EXPAND`, stores `bundleVersion` and optional `sourceOperationId`, and validates only complete A-04, V1, or V2 permission bundles. `bundleVersion` defaults to `A04` for compatibility with existing writers; V1/V2 expansion writers set their version explicitly.
- `refresh_sessions` accepts optional `sessionId` and non-negative safe-integer `userFence` fields.

## Data and migration impact

This is an additive application-schema change. It does not rewrite existing records, create collections, or add indexes. Existing refresh-session documents without `sessionId` or `userFence` remain valid; the backend reads missing values using its legacy fallback. Existing authority-operation documents remain readable, and legacy A-04 writers receive the matching default bundle version.

No data migration is required. The database schema branch must be merged before the backend branch begins writing V2 operation records or session-fence fields.

## Rollback

Rollback is safe before the backend writes the new fields or V1/V2 expansion records. If the backend has already written them, first roll back or disable those backend paths, then confirm no V2 expansion records or session-fence data require the newer schema before reverting this schema change. No automatic destructive rollback is provided.

## Verification

- Schema contract tests validate A-04, V1, and V2 operation bundles and reject incomplete bundles.
- Session schema tests validate optional `sessionId` and a non-negative safe-integer `userFence`.
- Migration planner suite remains read-only; no live database migration is part of this work package.
