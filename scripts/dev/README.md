# Development service-owned database initialization

This development-only initializer prepares synthetic data under the accepted
database-per-service topology. The approved development environment may use
MongoDB Atlas with an `mongodb+srv://` URI and a configured remote Redis
endpoint. Every command requires the explicit, non-secret
`DATN_DB_ENV=development` and `NODE_ENV=development` labels; the initializer
also requires `DATN_DEV_DB_INITIALIZATION=service-owned-development`. It does
not infer the target environment from hostnames. Operators must provide the
approved development endpoints and must not label production/shared endpoints
as development. The tool never reads `continuum_db`, loads a `.env` file,
changes runtime connections, runs migration tooling, deletes documents, or
drops collections/databases.

## Research and runtime behavior

- MongoDB 7 TTL indexes are single-field indexes. They expire a document based
  on the indexed BSON Date plus `expireAfterSeconds`; a missing or non-Date
  value does not expire. Cleanup is asynchronous. See the official [MongoDB 7
  TTL index documentation](https://www.mongodb.com/docs/v7.0/core/index-ttl/).
- MongoDB `createIndexes` creates the declared indexes, uses generated names
  when names are omitted, and enforces unique constraints. See the official
  [MongoDB 7 createIndexes documentation](https://www.mongodb.com/docs/v7.0/reference/method/db.collection.createIndexes/).
- NestJS requires unique names for multiple Mongoose connections and requires
  `forFeature`/injection to select the matching name. The current AppModule
  uses one connection per service database plus a separate audit connection.
  See the official [NestJS Mongoose guide](https://docs.nestjs.com/techniques/mongodb#multiple-databases).
- This repo uses Mongoose 8.24.4. Its schema definitions own indexes, while
  `autoIndex`/`autoCreate` govern automatic creation. This repo sets
  `MONGODB_AUTO_INDEX=false` by default, so merely starting Nest does not
  provide a reliable schema/index initialization step. This script uses the
  actual service persistence definitions and Mongoose schemas to create only
  missing collections/indexes. See the official
  [Mongoose 8 schema guide](https://mongoosejs.com/docs/8.x/docs/guide.html#autoIndex).

The database plan is read and checked in full before any create operation. If
an existing same-key index has incompatible uniqueness/TTL options, or a
missing unique index would encounter duplicate keys, the command stops before
the first write. Existing documents and extra indexes are preserved. It never
repairs or removes an existing index; a conflicting state needs a separately
authorized data/index work package.

## Topology and schema ownership inventory

The current runtime has eight active service databases plus the separate audit
database. `outbox_events` is registered by each service persistence module.
All schema-owned indexes come from each service's `persistence.ts` and
`mongodb.schemas.ts`; there was no general development seed mechanism before
this work package.

| Service      | Database                 | Collections                                                                                                                                                                                                                                                                | Index authority                                                                                                       |
| ------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| IAM          | `continuum_iam`          | `users`, `organizations`, `organization_memberships`, `projects`, `teams`, `project_memberships`, `team_memberships`, `roles`, `role_assignments`, `organization_capability_grants`, `refresh_sessions`, `sme_assignments`, `knowledge_owner_assignments`, `outbox_events` | IAM persistence + IAM Mongoose schemas + outbox schema                                                                |
| Capture      | `continuum_capture`      | `work_notes`, `work_note_versions`, `capture_drafts`, `work_note_templates`, `knowledge_requirements`, `outbox_events`                                                                                                                                                     | Capture persistence + Capture Mongoose schemas + outbox schema                                                        |
| Jira         | `continuum_jira`         | `jira_connections`, `jira_account_links`, `jira_issues`, `jira_events`, `jira_sync_jobs`, `outbox_events`                                                                                                                                                                  | Jira persistence + Jira Mongoose schemas + outbox schema                                                              |
| Lifecycle    | `continuum_lifecycle`    | `knowledge_objects`, `knowledge_proposals`, `knowledge_versions`, `knowledge_evidence`, `knowledge_verifications`, `knowledge_gaps`, `knowledge_conflicts`, `knowledge_relations`, `outbox_events`                                                                         | Lifecycle persistence + Lifecycle Mongoose schemas + outbox schema                                                    |
| Chat         | `continuum_chat`         | `chat_sessions`, `chat_messages`, `chat_feedbacks`, `query_logs`, `retrieval_logs`, `outbox_events`                                                                                                                                                                        | Chat persistence + Chat Mongoose schemas + outbox schema                                                              |
| Handover     | `continuum_handover`     | `responsibilities`, `responsibility_assignments`, `handovers`, `handover_items`, `interviews`, `interview_sessions`, `learning_paths`, `follow_up_tasks`, `outbox_events`                                                                                                  | Handover persistence + Handover Mongoose schemas + outbox schema                                                      |
| Ingestion    | `continuum_ingestion`    | `documents`, `document_versions`, `ingestion_jobs`, `sag_mappings`, `file_upload_tickets`, `outbox_events`                                                                                                                                                                 | Ingestion persistence + Ingestion Mongoose schemas + outbox schema                                                    |
| Notification | `continuum_notification` | `notifications`, `notification_preferences`, `notification_templates`, `email_delivery_logs`, `outbox_events`                                                                                                                                                              | Notification persistence + Notification Mongoose schemas + outbox schema                                              |
| Audit        | `continuum_audit`        | `audit_logs`, `audit_logs_iam`                                                                                                                                                                                                                                             | IAM audit schema for `audit_logs`; the current raw IAM audit event collection has only MongoDB's built-in `_id` index |

Capture draft indexes are derived directly from the current schema:

```js
{ userId: 1, contextKey: 1 }, { unique: true }
{ lastSavedAt: 1 }, { expireAfterSeconds: 2592000 }
```

There is no Capture draft HTTP persistence flow in this branch: the Capture
controller currently exposes only health. The initializer creates the schema
and indexes but does not invent Capture draft documents or seed unrelated
Capture data. Project creation through the existing IAM API writes its audit
event to `continuum_audit.audit_logs_iam`.

## Fresh development seed

The IAM seed is intentionally small and uses only synthetic `example.test`
accounts. It creates one organization, three active users, active organization
memberships, the existing `ADMIN`, `TEAM_LEADER`, and `MEMBER` role codes, the
matching role assignments, and one private sample Project with one Project
Leader and one ordinary Project member. It does not create Teams, leader
database roles, extra permissions, or fake audit events.

Permission values are taken from the current accepted
[Project Access & Visibility V1 decision](../../docs/decisions/project-access-visibility-v1.md)
and [Project creator bootstrap decision](../../docs/decisions/project-creator-member-bootstrap-v1.md):
`ADMIN` receives only `project.visibility.manage` and `project.leader.manage`;
`TEAM_LEADER` receives `project.read` and the three approved member-management
permissions; `MEMBER` receives `project.read`. The disabled
`project.members.role.change` permission is absent. These role records are
inserted only into an explicitly confirmed development database; this is
not a production role-provisioning mechanism.

For the approved development seed, supply the Atlas URI, Redis endpoint, and
seed password through the current shell environment. The URI must use
`mongodb+srv://`, include the Atlas database user's username and password, and
must not select a default database or disable TLS. The initializer chooses
only the service databases listed above. For an isolated test/CI run, a
disposable local MongoDB 7 replica set is also supported with `mongodb://`.
The script does not load `.env`, print connection values, or persist the seed
password outside the bcrypt hash stored in the three synthetic development
User records.

```powershell
$env:DATN_DB_ENV = 'development'
$env:NODE_ENV = 'development'
$env:INFRA_ENABLED = 'true'
$env:MONGODB_URI = '<approved Atlas development mongodb+srv URI>'
$env:REDIS_HOST = '<approved development Redis host>'
$env:REDIS_PORT = '<development Redis port>'
$env:DATN_DEV_DB_INITIALIZATION = 'service-owned-development'
$env:DATN_DEV_SEED_PASSWORD = '<development-only seed password>'
npm run dev:db:init
```

Set these values only from the approved development configuration. Before any
connection, the command prints the environment label and the exact
service-owned database names it will target; it never prints the URI,
credentials, seed password, hashes, or document contents. The Mongo URI must
have no default database path, so a URI cannot redirect the seed plan to
`continuum_db` or another database. `mongodb+srv://` is accepted only with
explicit development labels, one valid DNS seed-list hostname, credentials,
and TLS enabled. A direct `mongodb://` endpoint supports disposable local
MongoDB tests and explicitly labeled remote development endpoints.

Atlas requires TLS, database-user authentication, and an operator-configured
project IP access list/private network path. This command does not configure
Atlas networking or weaken its access list. If DNS, network policy, or the IP
access list blocks the connection, it stops before any database writes and
prints a generic safe connection error. Do not add `0.0.0.0/0`. See MongoDB's
official [Atlas connection string documentation](https://www.mongodb.com/docs/manual/reference/connection-string-formats/)
and [Atlas cluster security requirements](https://www.mongodb.com/docs/atlas/setup-cluster-security/).

To run the same initializer against test-only disposable local MongoDB, keep
the explicit development labels and set only the test URI in that isolated
shell:

```powershell
$env:DATN_DB_ENV = 'development'
$env:NODE_ENV = 'development'
$env:INFRA_ENABLED = 'true'
$env:MONGODB_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0'
$env:DATN_DEV_DB_INITIALIZATION = 'service-owned-development'
$env:DATN_DEV_SEED_PASSWORD = '<disposable test-only password>'
npm run dev:db:init
```

To create only the collections and schema indexes without seed data, run:

```powershell
npm run dev:db:init -- --schema-only
```

The command reports database/collection/index counts and inserted row counts,
never seed passwords, MongoDB URIs, hashes or document contents. Upserts use
deterministic IDs and unique lookup keys with `$setOnInsert`. Existing rows are
never overwritten; mismatched seed identities/roles stop with a conflict for
human review. A rerun with the same seed password adds no records.

## Runtime and smoke validation

After initialization, enable the composed `AppModule` with
`DATN_DB_ENV=development`, `INFRA_ENABLED=true`, the same explicitly approved
development MongoDB/Redis endpoints, and a valid development `JWT_SECRET`.
IAM repositories/models resolve against `continuum_iam`; Capture
schemas resolve against `continuum_capture`; audit event persistence remains
`continuum_audit`. Leave `MONGODB_AUTO_INDEX=false` if you want initialization
to happen only through the explicit script.

Existing full AppModule runtime tests can be enabled with
`MONGODB_INTEGRATION=true`. The API supports authentication, organization
context and Project create/list/detail smoke flows. Project creation is a
MongoDB transaction across `continuum_iam` and `continuum_audit`, so the local
MongoDB instance must be a replica set. The current Capture API supports only
health; draft CRUD cannot be smoke-tested through an API until that contract is
implemented. Capture's indexes are still verified against its real schema.

After init, `npm run dev:db:smoke` exercises the current authenticated API using
the same seed password and explicitly configured development MongoDB/Redis
endpoints. Set a development `JWT_SECRET` of at least 32 characters first. The smoke test creates one synthetic `PRIVATE` Project, an active
ProjectMembership, a project-scoped `MEMBER` RoleAssignment, and its required
audit event. It confirms the creator can list/read the Project and that no
Leader Project assignment or Team is created. The smoke does not clean up that
data. It changes the
process working directory to `scripts/dev` and refuses to run if that directory
contains a `.env` or `.env.vault`, so root developer credentials cannot be loaded
implicitly. Supply configuration in the command environment; any `DOTENV_KEY`
or `DOTENV_CONFIG_*` setting is rejected before `AppModule` is imported. This
blocks alternate dotenv paths and dotenv override mode. The smoke validates the
effective MongoDB and Redis endpoints both before importing `AppModule` and
after its `dotenv/config` import and `ConfigModule.envVariablesLoaded` resolves,
before `NestFactory.create` can connect or run application hooks.

The smoke accepts a valid Atlas `mongodb+srv://` URI with credentials and TLS,
or a direct single-host `mongodb://` URI. Redis standalone and cluster
endpoints may be remote when the explicit development labels are present.
`localhost` is accepted only when every address returned by the system resolver
is loopback; unspecified addresses and malformed host/port values are rejected.
Endpoint checks run before `AppModule` import and again after the import, before
`NestFactory.create` can connect or run application hooks. The application currently imports `dotenv/config` before
`ConfigModule.forRoot()`. NestJS documents that `ConfigModule` reads env files
from its configured/current working directory, merges them with `process.env`,
and gives `process.env` precedence unless override is enabled; this smoke refuses
dotenv control variables, awaits Nest's documented `envVariablesLoaded` hook,
and revalidates the resolved process environment after the import. See the
[NestJS configuration guide](https://docs.nestjs.com/techniques/configuration).

Run `npm run test:dev-db-smoke-safety` to verify endpoint parsing, dotenv-control
rejection, and that unsafe endpoints cannot reach AppModule bootstrap or a write
callback. These focused tests use no database or Redis connections.

## Safety boundary

- Allowed targets are exactly the eight active service databases and
  `continuum_audit` from `src/common/mongodb/database-names.ts`.
- `continuum_db` is neither opened nor read. No migration/copy/cutover occurs.
- The initializer uses the already-accepted ADR-003 mapping and repository
  schema declarations; it changes neither product requirements nor database
  ownership.
- Only an explicitly labeled development environment is permitted; the command
  rejects any value other than `DATN_DB_ENV=development` plus
  `NODE_ENV=development`, and also requires the seed confirmation variable.
  It does not classify remote endpoints by hostname. The operator must provide
  the approved development Atlas/Redis endpoints; an endpoint falsely labeled
  as development cannot be independently identified by this tooling. There are
  no drop, delete, replace, or document-rewrite operations in this script.
- `continuum_db` remains legacy and is not a seed target. No legacy data is
  migrated, copied, or read.
- Test/CI may use a disposable local MongoDB replica set; this does not change
  the team's Atlas development topology.
