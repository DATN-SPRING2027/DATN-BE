# Organization Membership and Context — work package decision (DEC-016)

**Status:** Accepted for this work package by the requester's explicit direction on 2026-09-28. This does not claim separate Product or Security approval.

The canonical project record is `projects/DATN/docs/decisions/ORGANIZATION-MEMBERSHIP-CONTEXT-DECISION-V1.md`, registered as DEC-016 in `projects/DATN/docs/decisions/decision-register.md`. Database ownership and the shared MVP `continuum_db` were separately accepted in project ADR-002 and DEC-011. This repository copy makes the rule reviewable with the implementation PR.

## Rule

- Organization Membership is the authoritative relationship proving that a User belongs to an Organization. An Organization-level RoleAssignment alone does not establish membership.
- Membership statuses are exactly `PENDING_INVITE`, `ACTIVE`, `SUSPENDED`, and `REMOVED`. Only `ACTIVE` establishes Organization Context. `ONBOARDING` and `OFFBOARDING` describe workflows, not context eligibility.
- Zero `ACTIVE` memberships produce no Organization Context; one is selected automatically; more than one requires explicit organization selection.
- A client-supplied `organizationId` is validated against the authenticated User's `ACTIVE` membership. RoleAssignment supplies role and permission evaluation after context is established.

## Historical backfill contract

For each distinct `(organizationId, userId)` pair from an existing `role_assignments` row with both IDs present and `projectId` null or absent, create one `ACTIVE` Organization Membership if none exists. Project-scoped assignments are excluded. Do not alter role assignments or infer memberships from unrelated data. The backfill must be deterministic, idempotent, non-destructive, protected by a unique pair index, and gated by a clean dry-run. Report unmatched users/organizations, duplicate or ambiguous sources, User account statuses, and excluded project-scoped pairs. The historical mapping preserves legacy organization access even when the User account is not currently login-eligible; account status and membership eligibility remain separate checks.

The backfill and Organization Context behavior are reviewed in separate stacked PRs. Membership lifecycle writes and access rules for future APIs remain outside this decision.
