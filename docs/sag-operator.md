# SAG operator API

POST `/api/v1/iam/platform/sag/operations/{action}` with the operator's Continuum bearer session. The JSON body contains optional `input` (SAG's existing payload) and, for credential operations, `stepUp`. The gateway forwards this endpoint to IAM. IAM checks the active subject/session, original access token and a dedicated assignment in its own `sag_operator_grants` collection. An active grant identifies the subject, permission, SAG instance, environment, grantor and grant date. Revocation takes effect for newly issued decisions immediately after the IAM store reflects the change. A previous ordinary assertion lives at most 300 seconds. Keep the collection private to IAM provisioning. Applying this change creates no grants.

| Action | Permission |
| --- | --- |
| preferences-update | sag.preferences.write |
| model-update, setup-302, mineru-302 | sag.ai.config.write |
| provider-test | sag.ai.provider.test |
| dsh-settings | sag.dsh.settings.write |
| dsh-export | sag.dsh.credential.export |
| dsh-rotate | sag.dsh.credential.rotate |

Successful calls return SAG's JSON response. An unsigned browser claim, a SAG session or an organization role cannot authorize the operation. Rejections use HTTP 401/403, missing trust or unavailable upstream may return 5xx. No token or signed assertion is returned to the UI. An exported descriptor is itself a secret, served with no-store.

## Configure the trust relationship

Use an HTTPS SAG_OPERATOR_API_URL, matching SAG_OPERATOR_INSTANCE, SAG_OPERATOR_ENVIRONMENT and SAG_OPERATOR_ISSUER, and an IAM-only RSA signing key SAG_OPERATOR_PRIVATE_KEY (PEM). SAG pins its public key. The authenticated HTTPS hop supplies the distinct SAG_OPERATOR_BFF_CREDENTIAL, whose SHA-256 fingerprint is bound into the signed assertion. Use separate strong random credentials per deployment for forward and decision hops. Store keys and credentials in the deployment secret manager.

For DSH credential operations configure the trusted step-up issuer (SAG_MFA_ISSUER), its verification PEM (SAG_MFA_PUBLIC_KEY) and the IAM-defined maximum age (SAG_MFA_MAX_AGE_SECONDS). The RS256 step-up proof must be signed for audience continuum-sag-step-up with matching sub and Continuum sid, amr containing mfa, auth_time and exp. Configure the actual MFA issuer before exposing these operations. The password login and browser role labels do not produce a proof.

SAG calls the private HTTPS endpoint POST /internal/iam/platform/sag/decision with its dedicated SAG_OPERATOR_DECISION_CREDENTIAL and JSON containing the original signed assertion. In monolith mode the path prefix is /api/v1. Each decision recomputes token revocation, active session family, subject status/fence and permission for the requested deployment. No decision is cached. Keep this endpoint off public ingress. Use the operator API for writes from Continuum. Direct requests from standalone SAG settings screens have no operator credential.

Measure logout, account disable and permission revocation with the production cache/clock topology in staging. Verify proxy denies DSH discovery, connector file permissions and reconnect after rotation before rollout.
