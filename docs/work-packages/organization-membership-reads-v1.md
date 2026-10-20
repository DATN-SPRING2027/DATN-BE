# DATN-87 — C-02 membership reads V1

Authority: [approved Organization Membership V1](https://github.com/DATN-SPRING2027/Document/blob/ddce1b231f44c25b42b75626046af533bb05153d/research-docs/Workspace/09-organization-membership-administration-v1.md),
especially A1/A2 and DATN-235. Owning wire:
[C-02 OpenAPI](https://github.com/DATN-SPRING2027/Document/blob/ddce1b231f44c25b42b75626046af533bb05153d/research-docs/Workspace/contracts/c-02-membership-v1.openapi.json).
DB prerequisite: [merged BE PR #26](https://github.com/DATN-SPRING2027/DATN-BE/pull/26),
main `614c490635166922a63b702f3c0483a099b7596f`. Contract PR #27 is also merged.

## Implemented scope

- `GET /api/v1/iam/organizations/{organizationId}/memberships`
- `GET /api/v1/iam/organizations/{organizationId}/memberships/{membershipId}`

Both public gateway routes forward to the owning IAM internal endpoints, keeping
query parameters, credentials, upstream errors and Cache-Control: no-store.

Authenticate through the existing IAM Organization-session path, which reloads
current ACTIVE User and ACTIVE Membership. Independently reload read authority:
ACTIVE User/Membership plus an Organization-level assignment (projectId missing
or null), BSON roleId resolving actual ADMIN with matching roleCode and the exact
`organization.memberships.read` permission in a well-formed Role.permissions.
Stale JWT roles, role-only evidence, another Organization, Project-scoped ADMIN,
TEAM_LEADER/MEMBER or manage-only permissions do not grant this read. Current IAM
has no persisted explicit-deny source for this action; this change adds none.

Only page/pageSize/single status is accepted for lists, with defaults1/20 and
maximum100; IDs are24hex and normalized lowercase. Invalid or unsafe integer
offsets are422. Detail allows no query fields. Scope/authority precedes strict
validation. Responses use no-store and the approved summary/page DTO; no roles,
auth secrets, last-login or private profile fields. Missing User reference is
diagnostic `user:null`, retained in the membership count. No missing version is
guessed or backfilled during reads.

Data query is scoped to Organization, sorted createdAtDESC/_idDESC, with one facet
for page/count. User lookup/projection is after page limit, avoiding N+1 and
pre-pagination joins. Queries have a5second execution timeout. Page/count are
from one aggregation; this is not a frozen snapshot across separate requests.
Current read authorization is evaluated per request, not a mutation write fence.

## Deployment prerequisites and data impact

No schema, index, historical migration, seed or data change. All queries stay
inside IAM's service-owned database. Apply/readiness of the already-reviewed
lifecycle migration (`20261012-organization-membership-lifecycle.mjs`, merged in
PR #26) is an operator-controlled prerequisite; merging its source does not apply
shared data. It backfills `role_assignments.mutationFence` to `0` when absent.
Membership list/detail and role mutation must not be rolled out until the reviewed
migration has been applied to the target IAM database. Missing version/fence/date
or malformed projected metadata returns 503 IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE,
rather than fabricating a valid DTO. This work does not authorize shared
migration apply or writer cutover.

PR28 review correction (2026-10-14): validate projected email with the existing
IAM class-validator email validator; malformed stored strings return the same
sanitized 503. Recognized MongoDB network/server-selection/client-closed/operation
timeouts (including server code50 MaxTimeMSExpired) and disconnected connections
return dependency503. Unexpected application/query errors remain sanitized500.
The HTTP fault-injection suite covers authority/list/detail failures separately;
real MongoDB tests cover malformed and valid stored emails on list/detail.
Owning Document read-error clarification is prepared on its separate review
branch; the GET500 text correction changes no lifecycle/authorization decision.

Existing invitation reads/writes/accept, sessions, grants and audit behavior are
unchanged. Invitation wire changes need coordinated A8 cutover and remain a
separate deliverable. Membership invite/accept/suspend/remove/resume/reinvite/
rights-review, effective-ADMIN writer protocol, atomic audit/operation/outbox and
A7 proof/provider/epoch/legacy cutover acceptance remain outside this read PR.

## Verification

HTTP contract tests exercise authentication, permission-before-validation,
Organization denial, unknown/malformed queries, all four states, defaults/bounds,
empty paging, normalized IDs, scoped detail404 and no-store.
Gateway-to-IAM tests run both Nest HTTP applications and verify list query/header
forwarding, scoped detail404, read denial403 and unauthenticated401.

The opt-in MongoDB7 replica-set suite uses actual authentication/repositories and
persisted User/Membership/RoleAssignment/Role evidence. It covers malformed roles,
manage-only/project-scope/mismatched/dangling/array-valued assignments, inactive
actors, ACCOUNT/PLATFORM denial, live revocation with the same JWT, PII projection,
orphan User counts, stable pages, absent/foreign detail, missing migration metadata
and explain plans selecting membership_list/membership_status_list without a
blocking sort/global collection scan.

Run standard checks with `npm run check`. For the real suite, set
MONGODB_INTEGRATION=true and an explicit loopback MONGODB_URI pointing to a
disposable MongoDB7 replica set marked in admin.datn_migration_test_fixture with
`_id: datn-87-membership-reads-mongo7-disposable`, then run:

```sh
npm test -- --runInBand --runTestsByPath src/services/iam/infrastructure/mongodb/organization-membership-read.mongodb.spec.ts
```

The suite uses only a random datn87reads_* database and drops it after verifying
its exact identity; it never loads repository.env. Default skip is not coverage.
CI explicitly installs the marker and selects this suite in the existing MongoDB
integration job. Final run counts/mutation/review evidence belong in the PR.

## Checkpoint assessment

- DATN-235: this read slice supplies the list/detail implementation and evidence;
  ready for In Review after final checks and review, requester updates status.
- DATN-239: read authority covered; command authorization/concurrency remains.
- DATN-241: read integration covered; full command/lifecycle/audit/rollback remains.
- DATN-236–238/240 and parent87: remain In Progress for remaining backend scope.

Contract or DB merge does not complete the whole DATN-87 task. No Jira status,
shared database, reviewer approval or PR merge is changed by this implementation.
