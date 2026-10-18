# DATN-373 BE Test Follow-up — O0 Event Identity

This file indexes the BE regression coverage added for the DATN-373 review.
The tests stay beside the Task persistence contract and repository they verify.

## Test locations

- `src/services/task/infrastructure/mongodb/task-contract.spec.ts` — pure
  contract test asserts that the creation event has a non-null ObjectId
  `_id`, `event.taskId == task._id`, and
  `event.projectId == task.projectId`.
- `src/services/task/infrastructure/mongodb/task-data.repository.mongodb.spec.ts`
  — MongoDB integration test asserts the same identity links on the event
  read back after Task creation.

Both tests carry `DATN-373` in their test names so they can be found with a
repository search for the Jira key.

## Run and current result

Focused contract test:

```powershell
npm test -- --runInBand services/task/infrastructure/mongodb/task-contract.spec.ts
```

Result on 2026-10-18: **1 suite passed, 5 tests passed**.

The MongoDB integration test requires the marked disposable MongoDB 7 replica
set described by `task-data.repository.mongodb.spec.ts`. It was not run in this
environment because `MONGODB_URI` and `MONGODB_INTEGRATION=true` are not
configured. The full `npm run check` passed its lint, typecheck, smoke-safety,
unit, e2e, and build stages; the gated Task MongoDB suite was among the skipped
suites.

## Scope boundary

These tests cover the approved D-03 O0 persistence identity invariant only.
Task lifecycle transitions, post-revocation behavior, and durable consumer /
outbox behavior remain `UNKNOWN / DISABLED` and have no runnable Task business
runtime in this repository revision. Their future acceptance scenarios remain
documented in Document D-13 O31/O32; this test note does not claim those
behaviors passed.
