# Project Access & Visibility V1 — validation evidence

**Date:** 2026-10-02
**Branch:** `feat/Danh-project-foundation-next-be`
**Base revision:** `059a7fcf01af5e0014cc77ba24f46234eea4fc09`

## Automated checks

| Check | Result | Evidence |
|---|---|---|
| `npm run check` | Passed. Lint, typecheck, unit tests, E2E tests, and build all completed successfully. Unit: 29 suites / 214 passed / 2 skipped suites and 2 skipped tests. E2E: 9 suites / 33 passed / 2 skipped suites and 4 skipped tests. | Full command completed with exit code 0 on 2026-10-02. |
| Focused Project Access policy, guard and controller tests | Passed: 3 suites, 55 tests. | `npm test -- --runInBand src/services/iam/application/authorization/project-access-authorization.guard.spec.ts src/services/iam/application/authorization/authorization.policy.spec.ts src/services/iam/controllers/project-access.controller.spec.ts`. |
| OpenAPI contract tests | Passed: included in `npm run check`; focused suite previously passed 14/14. | `src/contracts/iam-openapi.spec.ts`. |
| Project Foundation and Project Access MongoDB replica-set integration | Passed: 2 suites, 2 tests against disposable MongoDB 7 replica-set test container. The fixtures create uniquely named test databases and drop them in cleanup. | `MONGODB_INTEGRATION=true npm test -- --runInBand src/services/iam/infrastructure/mongodb/project.repository.mongodb.spec.ts src/services/iam/infrastructure/mongodb/project-access.repository.mongodb.spec.ts`; URI was `mongodb://127.0.0.1:27018/?directConnection=true`. |
| AppModule database-per-service smoke test | Passed: 1 suite, 1 test. Confirmed exactly one ready connection for each of eight active service databases plus one `continuum_audit` connection. Ran against the disposable replica set and Redis container. | `MONGODB_INTEGRATION=true npm run test:e2e -- --runInBand --forceExit test/database-runtime.e2e-spec.ts`. Jest required `--forceExit` because runtime infrastructure retains background handles after `app.close()`; the assertion completed successfully. |
| `git diff --check` | Passed after implementation and evidence update. | Final working-tree check. |

The full E2E suite reports the skipped suites/tests above; no required validation command failed. The Project MongoDB integration and runtime smoke test ran explicitly with the replica-set test environment rather than relying on the skipped-by-default integration toggle.

## MongoDB and data safety

Mongo integration used only disposable Docker containers: MongoDB 7 replica set on port 27018 and Redis on port 6380. Project integration fixtures use random database names and drop their databases. No production or developer database was used. No migration, cutover, or live database write was run.

The runtime smoke test validated connection wiring only. It did not create application records. It observed one ready Mongoose connection per active service database and a single shared audit connection to `continuum_audit`.

## Provisioning and deployment readiness

The BE repository has no system Role permission seed/provisioning path. The exact ADMIN and TEAM_LEADER permission additions, safe apply/report contract, and separate DB PR boundary are recorded in [`../work-packages/project-access-permission-provisioning-v1.md`](../work-packages/project-access-permission-provisioning-v1.md). No live database/schema seed or migration was applied. Until that separate provisioning work is applied, missing Role permissions cause the BE evaluator to deny the affected operations.
