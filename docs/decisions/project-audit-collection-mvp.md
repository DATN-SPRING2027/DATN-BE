# IAM Project creation audit collection — work package decision

**Status:** Accepted for the Project Foundation / Create-Read MVP by the requester on 2026-09-29. This does not resolve the broader SPEC-001 §7 choice for every module.

Project creation writes its audit event to `continuum_audit.audit_logs_iam`, following the accepted database-per-service topology in workspace ADR-003/DEC-011. The Project remains in `continuum_iam`; the event is written within the same MongoDB transaction/session. The event follows the existing IAM audit event shape: `organizationId`, `projectId`, `actorUserId`, `action`, `targetResource`, `targetResourceId`, and `occurredAt`. The current Project Create decision creates no membership or RoleAssignment and therefore adds no `metadata.bootstrap` fields. Replica-set integration verification is required for the cross-database transaction.

The migration on this branch only creates the empty collection if missing. It does not write Project or audit documents, does not change the existing legacy `audit_logs` collection, and is safe to rerun. It is separate from the BE API implementation branch.
