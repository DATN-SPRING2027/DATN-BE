# Handover API addendum — review round 2

This implementation addendum extends the R0 proposed contract in Document `research-docs/Workspace/contracts/handover-v1.openapi.yaml`. The business rules in decisions 17–19 remain unchanged.

## AI coverage warnings

`JobDto` and `HandoverAnswerDto` accept an optional `warnings` array. The only current value is `AI_EVIDENCE_INCOMPLETE`; absent or empty means no reported coverage warning. It indicates that SAG skipped or shortened some source content. It is advisory and never authorizes publishing or completing a handover.

```json
{ "warnings": ["AI_EVIDENCE_INCOMPLETE"] }
```

BE projects only this bounded code, not SAG's raw source identifiers or text. For successful asynchronous jobs the code is retained in the existing optional `handover_jobs.safeErrorCode` string field, and projected into `warnings` on every read, including after restart. `state: SUCCEEDED` still means success; this particular code is a warning in that state. Failed/superseded jobs continue to use `safeErrorCode` as an error. No new database field, validator, index or migration is introduced. FE reads `warnings` on successful jobs and Q&A answers and displays localized guidance to review the original sources.

Q&A `message` is a BE-owned status sentence, never free-form SAG text. If any LLM input loses permission or changes while the request runs, all answer sections are withheld. Current project membership, published revision and assignment epoch are rechecked after the external call.

## Follow-up live access

Every follow-up response, including a command replay, checks the originating revision's item dependencies against the current viewer. Historical readable pins do not need to be current. Missing snapshots or unreadable dependencies result in `403 ITEM_DEPENDENCY_UNAVAILABLE` for individual commands; list responses omit those rows. List cursors advance over scanned rows, so an empty filtered page can still have `nextCursor`. Parent completion does not end an authorized owner's ability to resolve a historical follow-up.

## Task Note pins

Edited live Task Notes without an immutable matching `work_note_versions` snapshot are unavailable. BE never invents a synthetic next version. An untouched initial note must have valid creation/update timestamps proving it has not been edited; re-confirmation is not a version identity. Existing immutable historical snapshots remain readable when authorized. This conservative behavior may require a Leader to use another source or curate the text manually; durable Capture version creation is a separate database/domain change.
