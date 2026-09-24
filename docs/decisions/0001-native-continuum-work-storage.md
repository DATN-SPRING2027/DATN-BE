# ADR-0001: Store native Continuum Work in its own MongoDB database

## Status

Accepted by Thang as part of the approved native Continuum Work implementation plan.

## Date

2026-09-24

## Context

Continuum Work is moving from an external Plane deployment into the Continuum AI
backend and frontend as the first-party Work Item/Task feature. The current
backend already uses MongoDB for application data, while SAG owns a separate
PostgreSQL/Qdrant data path. The backend also has a legacy `continuum_jira`
database for external Jira synchronization; those records are not native Work
Items and must not be repurposed.

The backend bootstrap documents conflicting database ownership rules and
requires an accepted decision before adding collections or indexes. The
workspace owner approved the native-work plan with a separate logical database
on the existing MongoDB deployment. Authentication and authorization are being
implemented by a teammate and will be integrated in a later step.

## Decision

- Persist first-party Work Items in the `continuum_work` logical database on the
  existing Continuum AI MongoDB deployment.
- Keep native Work data separate from IAM, knowledge, and legacy
  `continuum_jira` databases. Never mutate or reinterpret Jira sync documents as
  native Work Items.
- Use opaque string IDs at API boundaries. Persist references to IAM-owned
  organization, project, and user records using the same MongoDB ObjectId values
  as the current IAM persistence model; Work does not own those records.
- Keep SAG's PostgreSQL/Qdrant stores out of the task-management source of truth.
- Do not expose or enable Work API access until the pending IAM integration
  supplies a verified principal and project/team scope. Requests without that
  trusted context must fail closed.
- Validate writes with strict Mongoose schemas and apply additive, idempotent
  indexes. Do not drop collections or indexes automatically during rollback.

## Data scope

The initial native Work slice owns `work_items`, `work_item_comments`, and
`work_item_events`. Project/team/user identifiers are references, not copied
IAM entities. Work Item status and priority remain domain values owned by the
Work module.

## Alternatives considered

### Reuse `continuum_jira`

Rejected: Jira data represents externally synchronized records with external
IDs and sync lifecycle. Mixing native tasks into those collections would couple
the new product feature to a legacy integration and risk overwriting imported
records.

### Store Work Items in the default backend database

Rejected: the backend's service-per-database deployment already separates
bounded-context persistence. A dedicated logical database keeps ownership and
backup/retention policy explicit while using the existing MongoDB cluster.

### Store tasks in SAG PostgreSQL/Qdrant

Rejected: SAG's stores serve document ingestion and semantic retrieval. Tasks
are transactional application records and are not part of the RAG source of
truth.

### Keep Plane as an external system

Rejected for the native Work feature: the requested experience must live inside
Continuum AI BE/FE. Existing external Jira synchronization remains a separate,
legacy integration and is not removed by this decision.

## Consequences

- Deployments must create/validate the new collections and indexes before
  enabling native Work API writes.
- MongoDB backups and operational monitoring must include `continuum_work`.
- IAM integration must provide a trusted actor plus project/team scope before
  any endpoint can return or mutate Work data.
- Removing the external Plane runtime is a separate deployment cleanup and must
  not delete the legacy Jira connector or historical Jira sync data.

## Migration and rollback

This is an additive database change; it does not rewrite existing documents.
Apply the migration after taking the normal MongoDB backup. Rollback is to stop
the Work service and leave the collections intact. Dropping native Work data is
destructive and requires explicit operator approval and a verified backup.
