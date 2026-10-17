# Platform request trace audit indexes (DB v1)

## Scope

Add exact request/correlation ID lookup indexes to the existing
`continuum_audit.audit_logs_iam` collection for the Platform diagnostics API.
The collection is expected to already exist and remain owned by the audit
database. The migration fails closed if the collection is missing or is not a
MongoDB collection.

## Indexes

| Name                                  | Key                                           | Unique |
| ------------------------------------- | --------------------------------------------- | ------ |
| `platform_audit_request_id_trace`     | `{ requestId: 1, occurredAt: 1, _id: 1 }`     | No     |
| `platform_audit_correlation_id_trace` | `{ correlationId: 1, occurredAt: 1, _id: 1 }` | No     |

## Migration and recovery

The report-first planner records the target fingerprint, collection type,
document count, current index names, and desired actions. Apply and rollback
require a clean reviewed report hash. Apply creates only missing exact indexes
and verifies them; rollback drops only the two exact named indexes. Both paths
preserve collection validators and all audit records. The migration does not
load `.env`; the invoking process supplies `MONGODB_URI` and may explicitly
override `AUDIT_DATABASE_NAME`.

Run `npm run test:platform-request-trace-index:migration-plan` before review.
No dry-run or live database apply is performed as part of this code change.
