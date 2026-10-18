# Platform Operator Backend V2 Implementation Plan

The baseline inventory is preserved in
[`platform-backend-api-capability-audit.md`](../docs/platform-backend-api-capability-audit.md).
This plan implements the requested V2 scope on the named backend branch while
keeping separate database deliverables on their designated branch when needed.

## Ordered work

1. **Contract and authority** — record the V2 successor decision, preserve A-04
   and V1, define V2 permissions, default-deny authorization, audit events and
   external ownership boundaries.
2. **Core IAM reads** — Platform user directory/detail/organizations/effective
   permissions, organization directory and membership projections.
3. **Core IAM mutations** — user and organization lifecycle/metadata, session
   revocation, invitation and membership lifecycle/role changes with CAS,
   idempotency, last-ADMIN safeguards, and atomic audit.
4. **Project operations** — safe cross-organization metadata and access-policy
   projections and commands, with owner checks and no content joins.
5. **Dashboard and service operations** — bounded aggregate projections and
   real liveness/readiness/dependency probes.
6. **Jobs, AI and integrations** — BullMQ-backed job/queue views and commands;
   production SAG/provider adapters, timeout handling and safe failures.
7. **Incidents and diagnostics** — persisted incident state machine and
   redacted trace/diagnostic projections; explicitly report unavailable owners.
8. **Audit** — filterable paginated projection, details/history and mutation
   producer coverage.
9. **Contract and compatibility** — synchronize OpenAPI, route/permission
   inventory, and the FE screen-to-endpoint matrix.
10. **Final review** — focused and full tests, lint, typecheck, build, migration
    plans, diff/secret/placeholder review, authorization/audit/concurrency
    review, and complete capability matrix.

## Current progress

- Baseline FE/API and schema inventory: recorded in the immutable audit report;
  implementation status and FE consumers are recorded in the
  [capability matrix](platform-operator-backend-capability-matrix.md).
- V2 permission registry and routes preserve A-04 and V1. Authority grants stay
  disabled until DATN-295 trusted issuer and fresh-MFA evidence is approved.
- User, organization metadata, membership read/suspend, project metadata,
  session administration, dashboard, service health, BullMQ jobs, incident,
  trace diagnostics and audit projections have implementations and focused
  coverage.
- Jira integration test/reconnect have public and signed internal contracts,
  strict validation, bounded adapter behavior and safe 503 tests. The Jira
  provider cannot execute until its owner supplies credential decryption and a
  provider client.
- SAG model-provider and processing-job details remain unavailable because the
  upstream API does not expose safe operator data. Existing invitation commands
  remain no-write behind A7/A8; membership remove/restore/role changes are not
  exposed until their reviewed workflow contract is approved.
- Organization lifecycle is not modeled in the current domain and remains
  conditional under DEC-ACCESS-09. The FE repository was inspected read-only;
  its V2 screens remain unwired as documented in the matrix.
- Incident collections, request-trace indexes, session-fence fields, and V2
  authority schema validation are on the separate
  `feat/Thang-platform-operator-incidents-db` branch. Planner and schema tests
  pass; no live migration was applied.
- Backend unit tests pass with the DB-dependent authority repository suite
  excluded on the BE-only branch; that suite passes 12/12 when run with the DB
  schema overlay, and the DB schema contract tests pass 7/7. Lint, typecheck,
  build, and the 151 migration-planner tests pass. Redis-dependent
  health/default-entrypoint E2E checks remain blocked. The completed security
  report records two findings fixed in the current tree and partial coverage:
  the 88-row changed-file inventory was not reviewed file by file.
- Owner gates and FE V2 wiring remain open; this implementation is not ready
  for end-to-end release until those dependencies are resolved.
