# IAM OpenAPI v1

`iam-v1.openapi.json` is the review-first contract for the IAM slice.
Password login/reset, verified email/password registration, Google OAuth,
current user, logout and user directory are implemented. The
[A-01 session contract](../decisions/auth-session-contract-a-01.md) records the
approved refresh behavior and its dated A-02 HTTP decision closure. The backend
refresh route is implemented; the browser-facing BFF route lives in DATN-FE.
Other resources remain proposed where indicated. Runtime Swagger
describes implemented routes.

## Covered resources

| Area               | Operations                                  |
| ------------------ | ------------------------------------------- |
| Auth               | Email registration/verification, login/reset, Google OAuth, current user, logout and the A-02 backend refresh HTTP route |
| AI Engine          | BE-authenticated SAG login and Project-scoped session redirect |
| User               | List, read and partial update               |
| Project            | List, create, read and partial update       |
| Project Membership | List, create and idempotent removal; generic update proposed only and not enabled in Project Access V1 |
| Team               | List, create, read and partial update       |
| Team Membership    | List, create and idempotent removal         |
| Organization Membership | Membership list/detail, invitation list/detail, guarded invite lifecycle commands and ACTIVE membership suspension. Invite/resend/cancel and recipient acceptance remain runtime-gated by the approved readiness decision. |

## Review checklist

- All paths remain under `/api/v1` and all JSON fields remain camelCase.
- IDs stay opaque strings and timestamps stay ISO-8601 UTC values.
- Every list keeps `page=1`, `pageSize=20` and `pageSize<=100`.
- Error bodies keep `code`, `message`, `details` and `requestId`.
- Status codes preserve the documented `401/403/404/409/422/429` semantics.
- Browser login sets HttpOnly access and refresh cookies plus a readable CSRF
  cookie and returns user data. Tokens are never returned in browser JSON or
  stored in browser web storage. Refresh uses cookie and CSRF-header transport,
  returns `200 {"status":"refreshed"}` and emits separate replacement cookies.
- No controller, DTO or seed implementation may diverge from this document
  without a separate contract review.

The document deliberately has no `servers` entry or credential examples. The
deployment URI and all credentials remain environment configuration.

## Task D-05 slice (proposed draft)

`task-v1-d05-slice.openapi.json` is the review-first contract for the DATN-97
seven-field Task slice: internal list-by-Project and detail only, under
`/internal/tasks`. It is **proposed, not approved**: it follows the Document
D05-DR1 decision record (doc 25) and may not be implemented as handlers until
an authority records approval of this OpenAPI. Create is omitted until DR-7(c)(d)
is decided; there is no mutation, status, assignment, filter, sort, history or
`Idempotency-Key`. Routes stay disabled by default and behind the deny-by-default
authorization boundary; the trust profile (DR-3) and scope evidence (DR-8) are
deferred. The task owner recorded the remaining design choices on 19/10/2026 at
the Leader's request (`x-owner-decisions` in the file: path shape, default `limit`
20, cursor behavior, error mapping and `no-store`); items still waiting for
others are in `x-pending-decisions`. Unlike the IAM lists, this slice
uses cursor pagination (`limit` 1-100, `afterId`, `_id` ascending) per DR-6.
Errors keep the existing `{code, message, details, requestId}` shape; non-member
and cross-scope access return 404 (DR-5), a denied permission and a malformed path
id also return 404 (owner decision ERR-1), and only a malformed `limit` or
`afterId` returns 422. Whole-Project read access is DR-4, approved by the Leader
on 19/10/2026 (authority confirmed on Document PR #46). This OpenAPI itself is
still not approved: see `APPROVAL-1` in `x-pending-decisions`. The current
`TaskAuthorizationHttpGuard` returns a boolean and drops the denial reason, so
the handler pull request must add a reason-aware mapping to 401, 404 and 503
before this contract can be met.
`src/contracts/task-slice-openapi.spec.ts` guards the scope of the draft.
