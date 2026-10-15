# Organization Selection After Authentication

**Status:** Accepted for this implementation work package on 2026-10-15.
**Scope:** Browser sign-in for Organization-product users; Platform authentication remains separate.
**Related decision:** This updates the sign-in context-selection behavior documented in [DEC-016](organization-membership-context.md). It preserves DEC-016's rule that only ACTIVE Organization Membership establishes eligibility.

## Context

The previous login flow selected an Organization automatically when exactly
one active membership existed, returned `409 ORGANIZATION_SELECTION_REQUIRED`
for multiple memberships, and created an `ACCOUNT` session only for users with
no active membership. That made password and Google sign-in land on different
pages depending on membership count, and a one-Organization user never saw the
same workspace chooser as a multi-Organization user.

## Decision

- Password and Google sign-in establish an `ACCOUNT` session by default for
  every count of active Organization memberships: zero, one, or many.
- After sign-in, the FE always opens `/select-organization` for
  Organization-product users.
- The chooser lists every Organization where the authenticated user has an
  ACTIVE membership, regardless of Organization role. A zero-length list shows
  the existing Organization creation flow.
- Selecting an Organization calls `POST /api/v1/auth/select-organization`;
  the BE verifies that the current session is non-Platform, verifies any
  current Organization session still has an ACTIVE membership, and rechecks
  ACTIVE membership for the requested Organization before issuing scoped
  cookies and role claims.
- An explicitly supplied `organizationId` may establish the matching
  Organization session directly after the same server-side membership check.
- Platform sessions remain separate and cannot use this Organization chooser.

## Consequences

- Users with one Organization see it before entering the workspace, matching
  the behavior for users with multiple Organizations.
- Users without an Organization can create one without leaving the successful
  authentication flow.
- Organization roles and data remain tenant-scoped; the chooser does not grant
  membership or authority.
- FE and BE releases must be coordinated. The FE expects the BE to allow
  Organization selection from an authenticated ACCOUNT or existing valid
  Organization session.
- No database schema, migration, or configuration change is required.
