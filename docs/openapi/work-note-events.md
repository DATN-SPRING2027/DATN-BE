# Work Note event contract

Capture writes these events to `continuum_capture.outbox_events` in the same MongoDB transaction as the corresponding workflow transition. The Work Note API does not index AI knowledge directly. The current repository has no consumer for these events, so ingestion must subscribe before approved Work Note content can become searchable.

| Event | Aggregate | Required payload | Consumer action |
| --- | --- | --- | --- |
| `KNOWLEDGE_SOURCE_APPROVED` | `PROJECT_DOCUMENT` | `sourceType`, `sourceId`, `organizationId`, `projectId`, `version`, `approvedAt` | Index only that approved version after rechecking Project ACL and current source state. |
| `KNOWLEDGE_SOURCE_REPLACED` | `PROJECT_DOCUMENT` | `sourceType`, `sourceId`, `organizationId`, `projectId`, `previousVersion`, `version` | Remove `previousVersion` from the active index, then select the newly approved version. |
| `KNOWLEDGE_SOURCE_REVOKED` | `PROJECT_DOCUMENT` | `sourceType`, `sourceId`, `organizationId`, `projectId`, `version`, `reason=ARCHIVED` | Remove every indexed version of this source. |
| `KNOWLEDGE_SOURCE_APPROVED` | `WORK_REPORT` | `sourceType`, `sourceId`, `organizationId`, `projectId`, `version=1`, `approvedAt` | Index only after checking the Report is still approved. |
| `WORK_REPORT_DUE`, `WORK_REPORT_OVERDUE` | `WORK_REPORT` | `organizationId`, `projectId`, `memberId`, `periodStart`, `periodEnd`, `dueAt` | Notify the member. Delivery must deduplicate by event ID. |

Consumers must be idempotent by outbox event ID. For a Project Document, the active AI source is the **latest approved version only** while the parent document is not `ARCHIVED`. A new draft does not replace an earlier approved version. On v2 approval, process `KNOWLEDGE_SOURCE_REPLACED` and `KNOWLEDGE_SOURCE_APPROVED` for v2; on archive, process `KNOWLEDGE_SOURCE_REVOKED`. A consumer that starts late must reconcile against Capture's current status rather than treating an old approval event as permanently authoritative. Task Notes never enter official knowledge through this contract.

The scheduled monolith job reads ACTIVE Project and Organization Memberships from IAM, excludes Project Leaders, materializes due periods in Capture, then transitions due draft records and emits due/overdue events. The job is independent of page visits. The unique `{projectId, memberUserId, periodStart}` index prevents duplicate periods across retries. Periods ending before `project_memberships.joinedAt` are not assigned.

The new PDF/DOCX attachment is stored outside MongoDB; a private `file` reference is retained on each Document version. Downloads always recheck Project access. In production, R2 configuration is required. In development/test without R2, files use `WORK_NOTE_LOCAL_STORAGE_DIR` (or the system temporary directory) and are disposable. Deployment must not rely on that local adapter for durable storage.
