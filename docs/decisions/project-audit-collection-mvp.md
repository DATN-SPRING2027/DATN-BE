# IAM Project creation audit collection — work package decision

**Status:** Accepted for the Project Foundation / Create-Read MVP by the requester on 2026-09-29. This does not resolve the broader SPEC-001 §7 choice for every module.

Project creation writes its audit event to the dedicated `audit_logs_iam` collection in shared `continuum_db`. The Project, creator membership and MEMBER RoleAssignment, and event are committed in one MongoDB transaction. The event follows the existing IAM audit event shape: `organizationId`, `projectId`, `actorUserId`, `action`, `targetResource`, `targetResourceId`, and `occurredAt`; `metadata.bootstrap` carries the created membership and RoleAssignment IDs.

The migration on this branch only creates the empty collection if missing. It does not write Project or audit documents, does not change the existing legacy `audit_logs` collection, and is safe to rerun. It is separate from the BE API implementation branch.
