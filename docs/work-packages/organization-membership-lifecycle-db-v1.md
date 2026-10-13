# DATN-87 — Organization Membership lifecycle persistence V1

Scope: **DB foundation only**, based on mainfc7d0be. The requester approved
A1–A6/A8/N1/V2/E1/H1/Q1/epoch direction and conveyed reviewer approval of the
technical plan on2026-10-13. Owning wire decision:
[Document V1](https://github.com/DATN-SPRING2027/Document/blob/docs/Phuc-datn-87-membership-api-decision/research-docs/Workspace/09-organization-membership-administration-v1.md).
That Document branch is a separate deliverable; provider/proof/epoch readiness
is not approved by a schema or migration test. [Jira DATN-87](https://trankimthang0207.atlassian.net/browse/DATN-87).

## Catalog and compatibility

| Collection                   | Additive tracking / relationship                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| users,roles,role_assignments | mutationFence integer>=0,default0                                                                             |
| organizations                | membershipAdminRevision integer>=0,default0                                                                   |
| organization_memberships     | version integer>=1,default1; mutationFence0; existing unique Organization/User pair retained                  |
| organization_invitations     | version1; contractVersion1/2; V2 required membershipId/targetUserId, optional supersedesInvitationId          |
| membership_operations        | Scoped hashed key/fingerprint,command,COMMITTED status,immutable minimal ack/httpStatus,committedAt/expiresAt |

Only safe integers are accepted. Internal fences do not advance Membership
business version. Future C-02 and eligible-ADMIN/evidence writers must participate
in the common protocol; fields alone do not implement last-ADMIN or authorization.
Reuse the existing User-status transaction/Organization write and shared-account
denial, then reconcile actual Role/manage eligibility in the separate BE lane.
No authorizationEpoch/session/grant schema is added in this package.

Invitation profile1 keeps PENDING/ACCEPTED/REVOKED/EXPIRED and roleCode. Existing
writes default to profile1 until coordinated cutover. V2 is PENDING/ACCEPTED/
CANCELLED/EXPIRED/SUPERSEDED, requires explicit recipient/pair IDs and forbids
implicit roleCode grants. No V2 runtime handler is enabled by this DB package.
Mongoose document validation is not a MongoDB foreign-key/authorization check;
native writes and business commands must enforce binding/lifecycle/authority.

Migration preserves legacy state/history and adds only missing tracking fields;
it does not infer recipient/Membership from email, create accounts/pairs/grants,
convert REVOKED, expire/cancel old invitations or restore access. Legacy pending
IDs are reported for a separately approved audited cutover. Old write endpoints
must not bypass V2 reasons,versions,key,permission or audit requirements.

## Indexes and cache

Catalog adds scoped Membership sort/status-sort indexes, V2 unique pending
Invitation per Membership, Invitation history and operation scoped key/quota/TTL.
Existing pair and pending-Organization-email uniqueness are preserved/verified.
Cache key scope is actorUserId+organizationId+keyHash; command/path/body belong to
fingerprint. Cached acknowledgement excludes current User/private/credential data,
binds the persisted operation/Organization/Membership/target and command state.

expiresAt=committedAt+24hours; single-field TTL uses expireAfterSeconds0. TTL is
asynchronous cleanup, not replay eligibility or deletion of domain/audit history.
The BE lane must reauthorize exact replay before new-attempt version/state checks,
replace expired-but-present cache conditionally and commit required domain/audit/
operation/outbox writes together. This package does not implement those commands.

## Migration and recovery

New script: [20261012-organization-membership-lifecycle.mjs](../../scripts/migrations/20261012-organization-membership-lifecycle.mjs).
Uses configured IAM target, no .env load or continuum_db fallback. Dry-run bounds
document/report/heap scans with the existing MigrationScanBudget; validates IDs,
states,recipient references/duplicates,index drift,Role/Assignment consistency and
eligible ADMIN readiness under the approved permission union. Only existing
systemADMIN receives read/manage; PR #25 and other permissions are retained.
Malformed/orphan/conflicting records are reported, never silently repaired.
Any TTL index on retained Invitation/Membership records blocks preflight regardless
of its name; the script reports the conflict and never drops it automatically.

Record the original clean dry-run report and reviewed hash before apply:

```sh
node scripts/migrations/20261012-organization-membership-lifecycle.mjs > membership-lifecycle-dry-run.json
npm run migrate:membership-lifecycle -- --apply --iam-writers-stopped --expected-report-sha256=<reviewedHash>
```

The operator must separately approve the environment/backup and stop all relevant
IAM writers. Do not apply merely because the PR is merged. Metadata additions
and permission union use one majority/snapshot transaction with missing-field/
permission CAS and repeated preflight. A single transaction is limited to1000
tracking rows; larger backfills require a reviewed follow-up, not partial apply.

Index DDL precedes the transaction and is **not rolled back with metadata**. On
failure, preserve data/indexes, inspect the cause, re-run dry-run and review the
new hash before retry. Never advertise DDL+metadata as one atomic migration.

Rollback requires the saved **original dry-run**, a newly reviewed current hash,
writers stopped, unchanged projected business/tracking/permission fingerprints,
no new records and no V2 Invitation/operation usage:

```sh
npm run migrate:membership-lifecycle -- --rollback --iam-writers-stopped --expected-report-sha256=<currentHash> --rollback-report=membership-lifecycle-dry-run.json
```

Only newly added fields/permissions are removed; it never restores old business
state or deletes history. Added indexes/empty operation collection are deliberately
retained. Changed data/fences/permissions or V2 usage requires forward recovery.
Restoring old code alone does not authorize rolling back data after feature use.

## Evidence boundary and remaining work

Schema/planner tests plus the opt-in migration suite verify actual MongoDB7 replica
set transactions,unique-index contenders,stale reviewed hash,required-write abort,
apply/rerun and guarded rollback. The suite accepts only explicit loopback fixture
marker/port/replica set and creates/drops its own random test DB. CI explicitly
calls test:membership-lifecycle:integration with the fixture marker; a default
skipped suite or green unit job is not this coverage.

These are **migration/DB tests**, not C-02 allowed/denied actor,command lifecycle,
audit persistence,quota/replay or Handover/Notification deployment acceptance.
DATN-235–241 remain partial until dependent BE checks. No FE88 changes. Normal
remove/resume/reinvite/rejoin/unsafe activation retain owning proof/epoch/legacy
gates; invitation delivery needs approved producer/Notification provider contract.
DB reviewed/merged→new BE branch from updated main→commands and real integration
tests→review/approved fixes→handoff. Reviewer merge and shared apply remain human
actions. Pending team notification; no message/PR is created by this package.
