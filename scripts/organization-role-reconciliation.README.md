# ORG-08 role reconciliation runner

This runner classifies the Organization- and Project-scoped rows in
continuum_iam.role_assignments. It is read-only and emits aggregate counts only.
It is implementation tooling; it does not create or verify a Staging snapshot,
restore, network isolation, privilege approval, or execution authorization by
itself.

## Safety gates

Do not run until a human reviewer has opened and verified every referenced
operational record and the DB operator has confirmed the named isolated restore
target and bounded window. The runner checks the manifest shape and the live
MongoDB identity, but does not fetch or authenticate external evidence links.
Manifest values are assertions until their cited artifacts have been reviewed.

The runner stops before connecting unless all of the following are present:

- Approved STAGING snapshot ID, classification, creation time, collection
  scope, SHA-256 integrity evidence, approver, approval reference, and future
  retention expiry.
- A restore run tied to that snapshot, restore tool/version and time, verified
  target identity, MongoDB replica-set name and full member host list, integrity
  evidence, and network-isolation evidence.
- A dedicated DB account, verified effective privileges for that exact target,
  and server-side denied-write evidence from that isolated target.
- Project Lead scope authorization and an operator-confirmed target plus an
  execution interval no longer than 30 minutes.
- A TLS-enabled URI for non-loopback targets whose seed hosts match the
  manifest exactly. The URI is read only from
  ORG08_RECONCILIATION_MONGODB_URI and is never printed.

The runner then checks the live replica-set identity, all replica-set members,
MongoDB major version 7, the authenticated account, and the account's current
effective privileges. The accepted minimum privilege shape is listCollections
on continuum_iam plus find on only the seven required collections. Any write
privilege, extra scope, changed privilege set, target mismatch, absent
collection, expired snapshot, or out-of-window execution stops the run.

The script itself performs only collection inventory and projected find
queries. It does not test write denial, write or repair data, run migrations,
create collections or indexes, or read invitation, audit, Project content,
email, credential, or token fields. For Projects, it selects only _id,
organizationId and status.

## Manifest fields

The JSON manifest must follow schemaVersion 1 and include:

| Section                   | Required evidence                                                                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| snapshot                  | id, sourceEnvironment STAGING, classification, createdAt, collectionScope, approver, approvalReference, retentionExpiresAt; integrity status VERIFIED, SHA-256 checksum, reference, verifiedBy and verifiedAt                                                                                   |
| restore                   | runId, sourceSnapshotId, toolVersion, restoredAt; integrity and networkIsolation evidence each status VERIFIED, reference, verifiedBy, verifiedAt and targetIdentity                                                                                                                            |
| restore.target            | identity, databaseName continuum_iam, replicaSetName and exact hosts with ports                                                                                                                                                                                                                 |
| database                  | targetIdentity, accountName, authenticationDatabase; effectivePrivileges status VERIFIED, reference, verifiedBy, verifiedAt, matching targetIdentity/accountName and the exact privileges array; writeDenial status VERIFIED, reference, verifiedBy, verifiedAt, targetIdentity and accountName |
| authorization.projectLead | status VERIFIED, reference, verifiedBy, verifiedAt, approvedBy, authorizedAt, scope and maxExecutionMinutes no greater than 30                                                                                                                                                                  |
| executionWindow           | operator, targetIdentity, confirmedAt, startAt, endAt, DB-operator confirmation evidence (status VERIFIED, reference, verifiedBy, verifiedAt) and targetConfirmationReference                                                                                                                   |

Every reference must point to a real, accessible artifact. Do not put credentials,
connection strings, personal data, or tokens in the manifest. Do not make a
manifest by copying this table and filling it with invented values.

## Run

Install dependencies from the locked package manifest in the clean DB worktree.
Inject the approved target URI through the team's secret-management mechanism;
do not put it in command history, the manifest, a ticket, or logs.

Run from the DATN-BE repository root with the actual reviewed evidence manifest:

    npm run reconcile:organization-roles -- --manifest <verified-manifest-path>

The result is sanitized JSON on stdout. Store it only in the approved evidence
location. A nonzero exit means the run stopped or failed; it is not a partial
PASS. Do not retry against another target or outside the recorded window.

## Classification and limitations

Each assignment receives one primary classification: VALID, ORPHAN_SCOPE,
ORPHAN_SUBJECT, UNMAPPED_ROLE, POLICY_VIOLATION, DUPLICATE_SCOPE_LINK, LEGACY,
or UNVERIFIED. Inactive assignments and duplicate assignment groups are also
reported as independent aggregate dimensions. Organization roles are limited
to ADMIN and MEMBER. Project roles are limited to TEAM_LEADER and MEMBER.
SUSPENDED assignments remain structurally valid but count as inactive;
PENDING_INVITE/REMOVED memberships and a PENDING_INVITE account are policy
violations.

The output contains no assignment, User, Organization, Membership, or Project
IDs; no names, emails, private Project content, credentials, tokens, or raw
documents. Counts do not establish deployment or policy approval. A human
reviewer must assess and disposition findings before A7 can pass.

The automated MongoDB 7.0.14 fixture enables authentication and creates an
ephemeral, collection-scoped read-only account. It verifies that the server
rejects a nonmatching update with Unauthorized (code 13), runs the full CLI
through live target/account/privilege checks, and rejects mismatched accounts,
broader read privileges, and administrator write privileges. Credentials are
generated per run, passed to the child CLI only through its environment, and
never written into the manifest or test output. The fixture also checks scope
separation, redacted output, and unchanged assignment/membership records.

These are implementation tests on synthetic local records. Their manifests
contain explicitly synthetic evidence references; they are not evidence about
a Staging snapshot, restore, network isolation, or database population.
