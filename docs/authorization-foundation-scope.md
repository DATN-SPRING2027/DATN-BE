# Authorization Foundation: documented minimum

This branch adds a backend policy and an injectable NestJS guard for the one permission whose actor rule is explicit in the accepted MVP baseline: `project.create`. It does not expose a new API or attach the guard to a product route. The isolated HTTP test controller exists only in `test/`.

## Governing rules

- `product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md` §§1–2, 5–6: `ADMIN` may create a project; `TEAM_LEADER` requires an explicit organization-level `project.create` grant from an `ADMIN`; `MEMBER` may not. Deny takes precedence. Project-scoped assignments do not confer organization-wide access.
- `docs/decisions/ORGANIZATION-MEMBERSHIP-CONTEXT-DECISION-V1.md` (DEC-016): only `ACTIVE` Organization Membership establishes Organization Context; RoleAssignment alone does not prove membership.
- `docs/decisions/decision-register.md` (DEC-002): the requester accepted the minimum default/allow/deny order on 2026-09-29. Detailed permission granularity and explicit-deny sources for future scopes remain open. The 20 documented permission codes do not establish a complete role-to-permission matrix.
- PR #9 product-owner decision: every `project.create` grant has a finite `expiresAt` chosen at issuance. Missing, null, invalid, or reached expiry denies access; existing legacy grants without expiry confer no permission. Maximum duration and presets are undecided.
- `docs/openapi/iam-v1.openapi.json`: the proposed Project create operation describes `ADMIN` or an active `project.create` grant. Project CRUD is outside this branch.

## Small implementation choices

The policy accepts only server-supplied facts and evaluates one permission. It requires an active User, trusted matching Organization Context, active matching Organization Membership, and an affirmative deny assessment of `CLEAR`. `DENY`, `UNKNOWN`, or missing evidence refuses access. Here `CLEAR` means the applicable server-side sources were checked and no matching explicit deny exists; current Organization Membership, RoleAssignment, Role, and capability-grant records have no deny representation. An organization-scoped `ADMIN` RoleAssignment permits the documented action; an organization-scoped `TEAM_LEADER` assignment additionally requires an unrevoked, unexpired, organization-scoped `project.create` grant for that User. An assignment with `projectId` cannot satisfy this organization action. The guard calls the existing authenticated-identity service, which revalidates the User and membership; it rejects any client-provided organization selector that differs from the trusted context. These choices avoid consulting JWT role claims or client role state for authorization.

The `AuthorizationEvidenceProvider` is a port, not a new data contract. The MongoDB adapter reads active membership, organization-scoped role assignments, matching Role records, and capability grants. It returns `CLEAR` for `project.create` because none of these current sources supports explicit deny; a later deny-capable source must be added to this provider before it can be effective. The current grant schema has no separate active status: an existing matching grant is usable only when it has a valid finite `expiresAt` later than the evaluation time and has not been revoked. The evidence contract requires an expiry field; the adapter maps a legacy missing expiry to `null`, which the policy denies. At grant issuance, the requester must be an active User with active Organization Membership and organization `ADMIN` role; `grantedBy` records that issuer. The Admin must choose a duration and issuance must store a finite `expiresAt`; this PR adds no issuance API or duration limit. At grant use, the issuer's current role is not rechecked. This branch does not change historical grants. The guard is registered for injection but no product route uses it. This preserves fail-closed behavior while allowing focused unit and isolated HTTP checks of the documented rule.

## Open dependent decisions

1. Which future policy sources support explicit deny and how are they matched? The accepted DEC-002 order is fixed, but no new deny schema or ACL syntax was approved.
2. The Project create API, grant issuance/revocation API, audit event contract, and any 403-versus-404 resource concealment rule require their own approved contracts before product route attachment. The issuance implementation must check the issuer's authority at that moment; a future audit contract should add `grantedAt` and an audit event. This branch adds none of them.

No FE or database changes are required for this policy/guard slice. A later deny-capable policy source or grant audit design may require its own database contract.
