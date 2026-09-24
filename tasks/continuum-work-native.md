# Continuum Work native storage worklist

## Scope

Create first-party Work Item storage in `continuum_work`, using the existing
MongoDB deployment. Do not change IAM/authentication, Jira sync records, SAG,
PostgreSQL, Qdrant, or frontend code in this database deliverable.

## Tasks

- [x] Record the accepted storage decision in `docs/decisions/0001-native-continuum-work-storage.md`.
- [x] Define strict Mongoose schemas and scoped indexes for Work Items, comments, and events.
- [x] Add an idempotent `mongosh` index migration and a non-destructive rollback runbook.
- [x] Add automated checks for collection names, required fields, enums, and index scope.
- [ ] Verify the migration against a disposable MongoDB instance when available.

## Acceptance criteria

- Native task data is isolated in `continuum_work`.
- Every collection requires organization/project scope and immutable audit fields.
- List/filter indexes include the scope prefix; comments/events are scoped to the Work Item.
- Migration can be safely re-applied and rollback never silently deletes task data.
- No authentication, Jira, SAG, or unrelated database behavior changes.

## Verification

- Focused Jest tests for schema/index definitions.
- Backend `npm run check`.
- Disposable MongoDB migration smoke test is pending: Docker daemon is unavailable, and the local MongoDB port is not identified as a disposable test instance.
- Review `git diff --check`, changed files, and database rollback notes.

## Dependency

The backend API consumes this storage contract. The API must remain unavailable to
unverified requests until the teammate-owned IAM principal/scope contract is
integrated.
