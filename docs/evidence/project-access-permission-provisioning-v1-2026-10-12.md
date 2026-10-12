# Project Access permission provisioning V1 — validation evidence

- **Date:** 2026-10-12
- **Jira:** `DATN-82` (B-02), under `DATN-73`
- **Branch:** `feat/B-02-project-access-permission-provisioning-v1`
- **Backend base:** `e80617cde67fed146bab3ee874e68040ecf2caf3`
- **Authority:** [Project Access & Visibility V1 decision](../decisions/project-access-visibility-v1.md)

## B-01 merge and base state

Jira `DATN-81` is the FE Project Workspace task. Its merged PR is
[DATN-FE #10](https://github.com/DATN-SPRING2027/DATN-FE/pull/10), merge
commit `f6380a4bdd01f5547a6c6d07d975d3da7e6d5aff`. Local `DATN-FE/main` was
fast-forwarded to that commit and verified clean. B-01 did not add a BE commit;
`DATN-BE/main` remains at `e80617cde67fed146bab3ee874e68040ecf2caf3`, the exact
B-02 branch base.

## Validation results

| Check                                         | Result                                                   | Evidence                                                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration planner tests                       | PASS — 84 passed                                         | `npm run test:migrations:plan`                                                                                                                                                                                                                                          |
| B-02 MongoDB integration                      | PASS — 1 passed on disposable MongoDB 7.0.43 replica set | `npm run test:project-access-permissions:integration`; missing/duplicate/misplaced evidence and stale reports blocked; five approved additions, no-op rerun, and partial rollback verified.                                                                             |
| Focused IAM authorization tests               | PASS — 5 suites, 97 tests                                | Authorization policy, Project Access guard, authorization evidence provider, platform authorization policy and guard.                                                                                                                                                   |
| Project Access repository MongoDB integration | PASS — 1 test                                            | Ran against the same local disposable replica set.                                                                                                                                                                                                                      |
| Lint                                          | PASS                                                     | `npm run lint`, as part of `npm run check`.                                                                                                                                                                                                                             |
| Typecheck                                     | PASS                                                     | `npm run typecheck`, as part of `npm run check`.                                                                                                                                                                                                                        |
| Development DB smoke safety                   | PASS — 25 tests                                          | `npm run test:dev-db-smoke-safety`, as part of `npm run check`.                                                                                                                                                                                                         |
| Full unit suite                               | PASS — 42 suites, 377 passed; 5 suites/21 tests skipped  | `npm test -- --runInBand`, as part of `npm run check`.                                                                                                                                                                                                                  |
| E2E suite                                     | FAIL — 9 suites passed, 2 skipped, 1 failed              | `test/iam-secret.e2e-spec.ts` exceeded its 5-second timeout in “fails startup before serving requests when JWT_SECRET is missing”. The same timeout reproduced with `--forceExit`; its cause is not established. Jest also reported open handles without `--forceExit`. |
| Build                                         | PASS                                                     | `npm run build` completed successfully after the full check stopped at E2E.                                                                                                                                                                                             |
| Production/shared DB apply                    | NOT RUN                                                  | MongoDB writes were limited to the named disposable local test database, which was dropped by the integration test.                                                                                                                                                     |

The initial local install lacked `google-auth-library`. A clean `npm ci` attempt
hit Windows `EPERM` unlinking a native module in use; the locked library was
then restored locally without changing `package.json` or `package-lock.json`.
Lint, typecheck, unit tests and build passed with the restored dependency tree.

## Data safety

The integration test requires a loopback MongoDB 7 replica set and a
test-specific fixture marker. It confirms the unique test database did not
exist before creating it and drops only that database. No system Role was
created, and no developer, staging, shared, or production database was
modified.

## Traceability

`DATN-82` → accepted Project Access V1 decision →
[`project-access-permission-provisioning-v1.md`](../work-packages/project-access-permission-provisioning-v1.md)
→ migration/planner → tests above → B-02 PR.
