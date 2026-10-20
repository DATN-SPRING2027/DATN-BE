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

## IAM review checklist

These rules apply to `iam-v1.openapi.json`. The Task D-05 slice below is an
internal contract with its own conventions (`/internal/tasks` paths, cursor
pagination, no `403`).

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

The IAM document deliberately has no `servers` entry or credential examples. The
deployment URI and all credentials remain environment configuration.

## Task D-05 slice (approved for list and detail)

`task-v1-d05-slice.openapi.json` is the contract for the DATN-97 seven-field
Task slice: internal list-by-Project and detail only, under `/internal/tasks`.
The Leader **approved it for those two operations on 19/10/2026** (DATN-BE PR #55,
`x-approval-status` and `x-approval-conditions` in the file), following the
Document D05-DR1 decision record (doc 27). The approval does not cover create,
DR-3, DR-7(c)(d), DR-8 or `AUTH-1`, and allows no route activation, production
use or policy `ALLOW` yet. Create is omitted until DR-7(c)(d)
is decided; there is no mutation, status, assignment, filter, sort, history or
`Idempotency-Key`. Routes stay disabled by default and behind the deny-by-default
authorization boundary; the trust profile (DR-3) and scope evidence (DR-8) are
deferred. The task owner recorded the remaining design choices on 19/10/2026 at
the Leader's request (`x-owner-decisions` in the file: path shape, default `limit`
20, cursor behavior, error mapping and `no-store`), and the Leader approved them;
the item still deferred is `AUTH-1` in `x-pending-decisions`. Unlike the IAM lists, this slice
uses cursor pagination (`limit` 1-100, `afterId`, `_id` ascending) per DR-6.
Errors keep the existing `{code, message, details, requestId}` shape; non-member
and cross-scope access return 404 (DR-5), a denied permission and a malformed path
id also return 404 (owner decision ERR-1), and only a malformed `limit` or
`afterId` returns 422. Whole-Project read access is DR-4, approved by the Leader
on 19/10/2026 (authority confirmed on Document PR #46). The current
`TaskAuthorizationHttpGuard` returns a boolean and drops the denial reason, so
the handler pull request must add a reason-aware mapping to 401, 404 and 503
before this contract can be met. Since DATN-BE PR #58 the stored Task document
carries more fields than the seven in the response; the handler must return
only the seven approved fields. `updatedAt` and `version` are returned as
stored, so after a later lifecycle change they can differ from `createdAt` and
from `1`.

On 20/10/2026 the reviewer `kudotruong212` requested changes on PR #55. The file
now records, in `x-owner-decisions`, four additions that the Leader has **not**
repeated the approval for:

- `ERR-2`: the complete mapping of every denial reason of
  `TaskAuthorizationBoundary`. `INVALID_REQUEST` is a server fault and answers a
  generic 500, never 404. A failed Task ownership lookup is a new reason,
  `RESOURCE_SCOPE_UNAVAILABLE`, and answers 503, so that a persistence failure is
  never reported as a missing Task. A verifier that cannot verify (unavailable,
  key resolution failed, internal or malformed output) is a new reason,
  `CONTEXT_VERIFIER_UNAVAILABLE`, and answers 503, the default unconfigured
  verifier included; a missing or refused credential still answers 401. Every
  failure of the trust boundary is classified in the entry.
  `VERIFICATION_FAILED` (also raised for a replayed assertion) and
  `UNSUPPORTED_PROFILE` (also raised for a mismatched key) are shared by a
  credential fault and a server fault today; the verifier pull request must
  split them.
- `HDR-1`: every 401 carries `WWW-Authenticate: Bearer` (RFC 9110 §15.5.2).
- `CACHE-2`: `Cache-Control: no-store` on every response of both routes, errors
  included, and not only on 200.
- `STATUS-1`: list and detail return Tasks of every lifecycle status, including
  `CANCELLED`, with no implicit status filter and still no `status` field.

The handler pull request must implement these; the contract test fails if a
denial reason is added to the boundary without being mapped in `ERR-2`.
`src/contracts/task-slice-openapi.spec.ts` guards the scope of the contract.
