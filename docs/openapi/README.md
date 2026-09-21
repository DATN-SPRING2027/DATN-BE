# IAM OpenAPI v1

`iam-v1.openapi.json` is the review-first contract for the initial IAM slice.
It is intentionally separate from the generated NestJS Swagger document because
none of these business operations is implemented yet. Runtime Swagger continues
to describe implemented routes only.

## Covered resources

| Area               | Operations                                  |
| ------------------ | ------------------------------------------- |
| Auth               | Login, refresh-token rotation and logout    |
| User               | List, read and partial update               |
| Project            | List, create, read and partial update       |
| Project Membership | List, create, update and idempotent removal |
| Team               | List, create, read and partial update       |
| Team Membership    | List, create and idempotent removal         |

## Review checklist

- All paths remain under `/api/v1` and all JSON fields remain camelCase.
- IDs stay opaque strings and timestamps stay ISO-8601 UTC values.
- Every list keeps `page=1`, `pageSize=20` and `pageSize<=100`.
- Error bodies keep `code`, `message`, `details` and `requestId`.
- Status codes preserve the documented `401/403/404/409/422/429` semantics.
- Authentication tokens are returned only to a trusted BFF and are never stored
  in browser web storage.
- No controller, DTO or seed implementation may diverge from this document
  without a separate contract review.

The document deliberately has no `servers` entry or credential examples. The
deployment URI and all credentials remain environment configuration.
