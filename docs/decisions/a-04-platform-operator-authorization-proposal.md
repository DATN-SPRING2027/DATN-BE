# A-04 Platform Operator Authorization — Decision Proposal

**Status:** `DECISION PROPOSAL / BLOCKED`; not accepted authority

**Reviewed:** 2026-10-05

**Backend evidence revision:** `DATN-BE main` at `1f28bb3143bd216b2a7a107b4ef527ee127baf58`

**Purpose:** Record the A-04 authority gap and the minimum decision needed before backend enforcement.

This document is a proposal and evidence record only. It does not choose a permission code, persistence representation, assignment lifecycle, or audit event. It does not authorize implementation.

## 1. Evidence map

| Class | Evidence | A-04 consequence |
|---|---|---|
| **FACT — SAGE** | `.sage/config.yaml` deliberately has no active source baseline; `DATN-v1` and `DATN-v2` and the `.sage/inventory/*` documents are historical snapshots. SAGE review records for the earlier IAM authorization foundation are read-only `PASS_WITH_NOTES` reviews and explicitly claim no human approval. | Historical inventory and review PASS do not supply A-04 authority. No A-04-specific accepted decision or traceability record was found in the reviewed SAGE decision/evidence set. |
| **DECISION — product baseline** | `product_docs/research-docs/02_ACTORS_ROLES_AND_PERMISSIONS.md` (accepted MVP authorization baseline) defines `PLATFORM_OPERATOR` as a separate platform-scoped human actor, not an Organization role; it can provision Organizations and bootstrap the first Organization `ADMIN`, and gets no default Organization-content access. | The business boundary and actor separation are accepted at a high level. Organization `ADMIN` does not imply platform authority. |
| **DECISION — product baseline** | `product_docs/research-docs/Workspace/00-organization-and-access-contract-readiness.md`, DEC-ORG-04, marks platform provisioning and first-Admin bootstrap as an approved baseline; self-service Organization creation is outside the MVP model. | Confirms the high-level operation but does not define an exact permission identifier or an enforcement-ready platform-authority record. |
| **DECISION — general authorization** | SAGE project decision register DEC-002 accepts default deny and explicit-deny precedence when an applicable source represents deny. Its accepted rule is general and its detailed policy sources/representation remain open. | Supports fail-closed evaluation; it does not authorize a platform permission or persistence model. |
| **UNKNOWN / DECISION REQUIRED** | DEC-ACCESS-09 in the readiness register is `[PARTIAL]`, P0 before enforcement: the exact action × actor × Organization/Project/Team/resource permission matrix, including platform boundaries, remains open. | This is the direct A-04 governance gate. |
| **DESIGN, not decision** | Product guidance describes assignment validity (`validFrom`, optional `validUntil`), an assigning actor and audit reference; expired/revoked grants have no effect. These general statements do not establish a platform-specific assignment contract. | Do not infer platform authority storage or lifecycle from organization-scoped assignments. |
| **FACT — backend** | Current IAM `roles` and `role_assignments` schemas enumerate only `ADMIN`, `TEAM_LEADER`, and `MEMBER`; `role_assignments.organizationId` is required. `organization_capability_grants` is Organization-scoped and its current capability enum is `project.create`. | Existing role/grant persistence cannot safely represent a global Platform Operator assignment. Reusing it would conflate platform authority with Organization scope. |
| **FACT — backend** | `AuthorizationPolicy`, `MongoAuthorizationEvidenceProvider`, and the guards evaluate Organization/Project evidence. The authenticated request context is tied to a User and Organization. No platform authority provider, platform-scope evidence, or `PLATFORM_OPERATOR` runtime implementation exists in `src`. | A positive production allow path cannot be implemented from current trusted backend evidence. A fake/test-only provider would not complete enforcement. |
| **UNKNOWN — audit contract** | The accepted actor baseline calls for audit of Organization provisioning/first-Admin bootstrap and role/assignment or grant lifecycle changes. The separate audit/outbox report labels itself `Research Only`; it is not an accepted event contract. | Exact authority grant/revoke audit event and persistence semantics remain unapproved. Do not invent an event schema or producer. |

No current-authority conflict was found between the accepted high-level actor boundary and the backend implementation: the backend is missing the capability. Older inventory statements that describe authorization as absent are historical; current code now contains Organization/Project authorization and must be assessed from source.

## 2. Current versus target

- **Current runtime:** authenticated Organization-context IAM; Organization/Project roles, assignments, grants, guards, and evaluator. No Platform Operator authority source or evaluator path.
- **Accepted target boundary:** platform operations are distinct from Organization administration and confer no Organization-content access.
- **Unapproved target details:** exact A-04 action set and permission identifier; platform-scope representation; authority assignment, revocation, expiry, bootstrap and audit contracts.

## 3. External research — non-authoritative

| System and official documentation | External pattern | DATN use and boundary |
|---|---|---|
| [Keycloak Server Administration Guide](https://www.keycloak.org/docs/26.8.0/server_admin/) | Separates server administrators with cross-realm authority from realm administrators scoped to one realm; supports narrower delegated permissions on selected resources and operations. | Corroborates separating platform-wide from tenant/Organization authority and limiting operations. Do not import Keycloak realms, role names, token rules, or permission implementation. |
| [Microsoft Entra: Assign Microsoft Entra roles](https://learn.microsoft.com/en-gb/entra/identity/role-based-access-control/manage-roles-portal) | Distinguishes tenant-wide role assignments from assignments scoped to an administrative unit or application; scoped role permissions apply only to that resource scope. | Corroborates evaluating scope independently from role/title. Do not map Entra tenant or administrative-unit concepts to DATN persistence. |
| [AWS IAM: Security best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html) and [explicit vs. implicit denies](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic_AccessPolicyLanguage_Interplay.html) | Recommends least privilege; IAM denies access by default without an applicable allow, and an applicable explicit deny overrides allow. | Corroborates the already accepted DATN deny-by-default direction. Do not import AWS policy syntax, account hierarchy, or service action names. |

External practice supplies no DATN authority and does not resolve DEC-ACCESS-09.

## 4. Minimum authority decision requested

An authorized product/security decision owner must accept or amend the following in the canonical decision record before A-04 enforcement:

1. **Exact action set:** Is this permission limited to Organization provisioning and first-`ADMIN` bootstrap, or does it also cover platform health/configuration operations? Confirm any additional operation individually.
2. **Exact permission code:** Record the canonical code for each approved action. No code is selected by this proposal.
3. **Scope:** Record the canonical platform/system scope value and its semantics. Confirm that Organization IDs, Organization `ADMIN`, and client-supplied scope values cannot establish platform authority.
4. **Principal binding and lifecycle:** The product baseline identifies a human `PLATFORM_OPERATOR`; decide how an authenticated User receives that authority, who may grant/revoke it, the active/revoked/expiry rules, and how a revocation becomes effective for in-flight or cached authorization context.
5. **Persistence contract:** Approve a platform-specific authority source or explicitly approved representation. It must not overload required-Organization-scoped `role_assignments` or `organization_capability_grants` without an authority-backed schema change. This is a separate DB work package/PR before runtime enforcement.
6. **Audit boundary:** Confirm the audit obligation for authority grant/revocation and define the applicable event contract before implementing those mutations. Preserve the already documented audit requirement for Organization provisioning and first-Admin bootstrap; do not infer an event schema from the research-only audit report.

Once approved, record the decision status and traceability in SAGE/product authority first. Then define the DB contract in the DB-owned change, and only afterward implement the backend evidence provider/evaluator/guard and allow/deny tests against the approved contract.

## 5. A-04 disposition

**Classification: C — `DECISION PROPOSAL / BLOCKED`.**

The accepted high-level actor and business boundary are clear, but the exact permission matrix is explicitly incomplete and P0 before enforcement. The current backend also lacks a trusted, persistent Platform Operator authority source. No authorization code, schema, migration, audit event, endpoint, or test fixture was changed or added. A-05 Organization provisioning, B-02, DATN-FE, and unrelated authentication changes remain out of scope.
