# Work Report 2-Tier Governance Schema & Scoped Index Migration

## Purpose

Normalizes `continuum_capture` persistence for the 2-tier Periodic Work Report workflow (**Member -> Project Leader** and **Project Leader -> Organization Manager**) with flexible **1–7 day cadences** (`DAILY` through `WEEKLY`):

1. **`work_report_settings`**:
   - Backfills missing `reportScope` on existing documents to `'MEMBER'` and populates `updatedByUserId` from `createdByUserId` when absent.
   - Replaces legacy unscoped unique index `work_report_settings_project_effective_unique` (`{ projectId: 1, effectiveAt: 1 }`) with `work_report_settings_project_scope_effective_unique` (`{ projectId: 1, reportScope: 1, effectiveAt: 1 }`) so `MEMBER` and `LEADER` schedules can maintain independent timeline rows and `nextFrequency` / `nextEffectiveAt` transitions at the same timestamp without key collisions.
   - Adds `work_report_settings_project_scope_history` (`{ organizationId: 1, projectId: 1, reportScope: 1, effectiveAt: -1 }`).
   - Preserves existing `leaderFrequency`, `leaderEffectiveAt`, `leaderUpdatedByUserId`, and `leaderHistory` fields on existing documents so current `main` runtime remains 100% compatible before the backend application PR is deployed.
2. **`work_reports`**:
   - Ensures all legacy documents have `reportScope: 'MEMBER'`.
   - Ensures `work_reports_member_scope_period_unique` (`{ projectId: 1, memberUserId: 1, reportScope: 1, periodStart: 1 }`) and drops `work_reports_member_period_unique` if still present.
   - Adds compound query indexes `work_reports_project_scope_status_period` (`{ organizationId: 1, projectId: 1, reportScope: 1, status: 1, periodStart: -1 }`) and `work_reports_project_scope_member_period` (`{ organizationId: 1, projectId: 1, reportScope: 1, memberUserId: 1, periodStart: -1 }`) for scoped KPI aggregation, reviewer queues, and compliance roster lookups.
3. **`continuum_notification.notifications` (Mongoose schema enum expansion only)**:
   - Additively registers `WORK_REPORT_SUBMITTED`, `WORK_REPORT_APPROVED`, `WORK_REPORT_CHANGES_REQUESTED`, `WORK_REPORT_REJECTED`, `WORK_REPORT_OVERDUE`, `WORK_REPORT_FREQUENCY_CHANGED`, target kind `WORK_REPORT`, and optional `reportId`. No document rewrite or index migration is required on `continuum_notification`.

## Execution Procedure

1. **Dry-run preflight (read-only, prints JSON plan without credentials):**
   ```powershell
   $env:MONGODB_URI = '<approved Capture MongoDB URI>'
   npm run migrate:work-report-governance
   ```
   Verify `duplicateReportScopeKeysCount` / `duplicateSettingsScopeKeysCount` do not throw and review `legacyReportsMissingScopeCount`, `legacySettingsMissingScopeCount`, `indexesToCreate`, and `indexesToDrop`.

2. **Apply against loopback development MongoDB (with Capture writes paused):**
   ```powershell
   npm run migrate:work-report-governance -- --apply --writes-paused
   ```

3. **Apply against a reviewed shared / Atlas MongoDB target (with Capture writes paused):**
   ```powershell
   $env:WORK_NOTE_MIGRATION_CONFIRM_DATABASE = 'continuum_capture'
   npm run migrate:work-report-governance -- --apply --writes-paused --allow-shared-database
   ```

4. **Post-apply verification (read-only):**
   ```powershell
   npm run migrate:work-report-governance
   ```
   Confirm `backfillReports: false`, `backfillSettings: false`, `indexesToCreate: []`, and `indexesToDrop: []`.

## Backward Compatibility & Rollback

- **Expand-and-Contract safe:** No separate `reportScope: 'LEADER'` documents are inserted during pre-BE migration, and legacy `leader*` fields on `work_report_settings` are preserved intact. Existing `main` application instances continue reading and writing without regression.
- **Rollback:** Added query indexes and backfilled `reportScope: 'MEMBER'` / `updatedByUserId` fields are additive and safe to leave in place if application code is rolled back. Recreate `work_report_settings_project_effective_unique` only if no separate `reportScope: 'LEADER'` timeline rows share an `effectiveAt` with a `MEMBER` row.

