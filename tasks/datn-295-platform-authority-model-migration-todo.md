# DATN-295 — Fix and handoff checklist

## Completed in this fix branch

- [x] Create a fresh branch from the updated `origin/main`; preserve Anti's branch and the existing untracked `.serena/` directory.
- [x] Remove caller-controlled `mfaVerified` and `breakGlass` fields from the command contract.
- [x] Add a default-deny authorization policy because the approved issuer workflow and trusted MFA source are still undefined.
- [x] Serialize permission mutations inside the MongoDB transaction and count only active users for last-operator protection.
- [x] Return a generic HTTP 500 for unexpected persistence errors without exposing driver messages.
- [x] Add a follow-up, hash-guarded migration for the ledger TTL index and permission-lock rows; leave the existing migration untouched.
- [x] Correct the evidence packet and migration notes so they do not claim unverified environment state or policy decisions.

## Pending before handoff

- [x] Run focused IAM unit, schema, replica-set, and migration planner tests.
- [x] Run `npm run check` and record the E2E failures; run the build separately.
- [x] Review the complete fix diff, `git diff --check`, changed-file list, branch history, and secret/debug scan.
- [x] Complete manual code review; no PR-specific review/check tool applies before a PR exists.
- [ ] Keep staging and production database state **UNVERIFIED** until an authorized owner runs and reviews fresh environment-specific dry-run reports.
- [ ] Keep the authority mutation service disabled until an approved issuer workflow and trusted MFA verification policy are implemented.

## Current state

- **Branch:** `feat/Thang-DATN-295-platform-authority-be-db`.
- **Database impact:** additive lock collection/index plus ledger TTL index; no assignment, ledger, or audit data is rewritten by the migration.
- **External database changes:** none performed.
- **Validation:** lint, typecheck, smoke safety, all unit tests, migration planner, and build pass; E2E has environment-related failures recorded in the plan and evidence packet.
- **Push:** not performed. Thang must review the branch before pushing.
