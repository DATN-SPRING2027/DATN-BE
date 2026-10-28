# Knowledge handover — DB work package

Date: 2026-10-28. Branch: `feat/Thang-knowledge-handover-db`.
Base: `origin/main` at `2325a8e1f567fbb7276b57f14cd05c9ffe08bc5e`, fetched and
fast-forward checked before creating this fresh branch. Worktree:
`F:/LEARN KÌ 8/ĐATN/DATN_BE-handover-db`.

Thang approved implementing the handover feature, then explicitly retained the
DB-first gate: finish DB and wait for a human merge before dependent BE/FE.
Product decisions and proposed integration contracts are recorded in Document
Workspace docs 17–19. This work package implements the physical DB portion.

1. Test nullable recipient, versioned acceptance, legacy isolation and required
   shape/index invariants before adding storage code.
2. Create one canonical physical contract shared by Mongoose and a new migration;
   retain legacy schemas and unrelated infrastructure.
3. Add a read-only inventory/planner and guarded additive apply. Detect invalid
   rows, duplicates, scoped orphan references and conflicting indexes/validators
   before any writes; require exact reviewed report and paused writers.
4. Exercise real MongoDB 7 validators/indexes, retry/no-op, BSON bounds, safe
   receipts, epoch history, legacy preservation and preflight failures.
5. Run full repository quality checks, inspect the complete diff, review the DB
   impact and prepare the PR description and manual commands.
6. Wait for Thang's push and human review/merge. Resume dependent BE/FE/SAG on
   fresh branches from updated main after that external gate closes.

No API activation, source authorization, AI provider invocation, Task command,
frontend work, shared migration, commit, push or merge is part of this DB patch.
