## Problem and behavior

Adds the Knowledge Handover workflow on the human-merged database foundation PR #106: Leader selects departing A, coordinator D and optional successor B; curates AI suggestions; publishes immutable revisions; records version/recipient-bound acceptance and independently reviewed evidence; transfers tasks explicitly; handles optional follow-ups after completion.

Review round 2 closes the Q&A status-message leak and follow-up reason ACL bypass, rejects mutable Task Note pins without a matching immutable snapshot, and rechecks source authorization/version/content after AI generation before applying a draft. Readable historical follow-ups remain resolvable after parent completion. B may also coordinate as D; self-review of evidence remains forbidden.

AI coverage warnings now reach the client through the optional `warnings` array on job and answer DTOs. Successful jobs retain the bounded warning code in the existing optional `safeErrorCode` string field. See [API addendum](https://github.com/DATN-SPRING2027/DATN-BE/blob/feat/Thang-knowledge-handover-workflow-be-api/tasks/knowledge-handover-workflow/api-contract-addendum.md).

## Validation

- `npm run check`: PASS — lint, TypeScript, 15 reconciliation checks, 25 dev-DB smoke checks, 172 active unit suites / 1,585 tests, 19 active MongoDB e2e suites / 176 tests, Nest build. Existing explicitly skipped suites remain skipped.
- New privacy/version/race regression suites: 18 tests PASS, including revoked uncited AI inputs, lost membership, follow-up replay privacy, citation-only dependencies and post-completion resolution.
- Handover MongoDB 7.0.24 replica-set acceptance: 5 tests PASS, strict V2 validators enabled. The initial Task Note fixture now contains explicit unedited creation/update timestamps.
- Fresh independent read-only security candidate review: no source-backed bypass/regression reported. CodeRabbit: 0 issues in the tracked diff.

## Database and configuration

No schema, collection, validator, index, migration or environment change in this update. Existing PR #106 must already be deployed. Task reassignment uses the existing owning Task module's durable `task_operations` receipts. Existing `SAG_API_BASE_URL` / `SAG_BFF_SERVICE_TOKEN` apply.

## Dependencies, risks and rollback

Coordinate with FE #102 and SAG #47. Edited Task Notes with no durable snapshot fail closed; a Leader can curate manually or select another source. Inaccessible follow-ups are omitted from lists and commands return a safe 403. Deploying this update does not alter persisted business records through a migration. Roll back the code commit without deleting handover history; older clients ignore the optional warnings field.
