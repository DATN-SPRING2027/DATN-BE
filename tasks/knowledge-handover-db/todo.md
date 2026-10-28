# DB implementation and verification

- [x] Read workspace/repository rules; inspect main, remotes and unrelated changes.
- [x] Preserve AI Chat untracked work and use a separate DB checkout/branch.
- [x] Write failing focused storage/planner tests before implementation.
- [x] Add physical V2 contract and explicit Mongoose V2 models.
- [x] Add a new guarded additive migration without rewriting legacy records.
- [x] Exercise the migration against disposable MongoDB 7.0.24.
- [x] Finish full repository checks and review.
- [x] Thang explicitly authorized commit/push and PR creation: “push lên tạo pr cho tôi”.
- [ ] Human DB PR review and merge.
- [ ] BE/FE/SAG integration and full feature acceptance after DB merge.

## Current evidence

- Focused Jest storage tests: 5 passed.
- Focused planner tests: 5 passed.
- MongoDB 7 integration and CLI tests: 3 passed.
- Real Mongoose/MongoDB serialization e2e: 1 passed; nested provenance, blank
  body, nullable recipient and timestamps persisted without automatic DDL.
- Initial lint detected formatting and one test typing issue; corrected before
  the full check. No tests were weakened to hide a functional failure.
- Full final `npm run check`: exit 0. Lint/typecheck, existing reconciliation
  and smoke-safety suites, 1,504 unit tests, 169 e2e tests and Nest build passed.
  Repository opt-in suites remain skipped: 135 unit and 4 e2e tests; those
  skipped tests are not counted as acceptance evidence.
- `npm run test:migrations:plan`: 248 passed, 0 skipped.
- Built canonical CJS asset loads all 9 collection definitions; no missing
  runtime asset. `git diff --check` passed.
- Dependency install kept the lockfile unchanged. npm reported 10 existing
  audit advisories (8 low, 2 moderate); this DB patch does not upgrade packages.
- Existing duplicate-index warnings occur outside the changed Handover contract;
  no unrelated index cleanup was mixed into this patch.
- No existing/shared database or secret configuration has been read or changed.
- No business API or frontend acceptance is claimed by the DB checks.

## Review scope

Review correctness and backward compatibility; inspect strict schemas,
version/recipient binding, unique index filters and bounded receipts; confirm
database ownership and no cross-service writes; check preflight-before-DDL,
repeatability, credential-free output and quiesced rollback.

Completed local five-axis review: canonical model/migration definitions agree;
legacy records retain their types/status and no V2 defaults; current-version
bindings, bounded snapshots/receipts and preflight-before-DDL were exercised.
No unresolved blocker was found for the DB-only patch. Human peer review is
still pending. Runtime current-ACL checks, append-only command behavior,
completion guards and external Task/SAG integration are not certified here.

## Outstanding external gate

Thang chose **“Giữ thứ tự bắt buộc: xong DB rồi chờ human merge”**.
The complete feature remains pending that human merge, followed by BE/FE/SAG
implementation and runtime/visual acceptance. Push/PR creation is authorized
by Thang's subsequent explicit request; approval and merge remain human actions.
