# AI bot and Work Report reminders

## Behavior

- On a successful AI Chat `completed` event the floating bot shows an accessible completion bubble for eight seconds. Failed/cancelled streams do not announce success.
- Work Reports → AI bot reminders configures one lead time independently for each project and governance tier: off, 1 hour, 2 hours, 1 day, 2 days.
- `PATCH /capture/projects/{projectId}/work-report-settings` accepts either `{frequency, scope?}` or `{reminderLeadMinutes, scope?}`; do not combine both. `null` disables reminders. Old projects default to disabled.
- Leader/Manager authorization reuses cadence configuration policy. A Member cannot configure; a Leader configures MEMBER reports; a Manager configures LEADER reports, and MEMBER reports only under the existing no-active-Leader fallback policy.
- Reminder changes take effect immediately and do not change cadence history, generated obligations, period boundaries or deadlines. Capture stores preferences on the first MEMBER settings row (or the existing shared anchor in legacy Leader-only data), independently of cadence segments.
- Every minute the backend creates the normal obligations, then scans enabled project/tier reminders using active IAM rosters. Only DRAFT or CHANGES_REQUESTED reports with future deadlines inside the lead-time window qualify. If the configured lead exceeds the reporting period, the reminder is sent as soon as the obligation exists inside that window.
- A persistent in-app notification and an Email go to the report author. Email uses a formal English greeting, submission instructions, and courteous closing. It includes an HTML layout plus a plain-text alternative, the project name, and an English deadline explicitly formatted in Asia/Ho_Chi_Minh (UTC+7), independent of the server timezone. IAM reconfirms active Project membership, active Organization membership, active Project and User before delivery.
- The bot reads persisted unread reminders across projects, then verifies report state through the existing authenticated detail endpoint. It hides submitted, expired, inaccessible reminders, refreshes every 30 seconds and links to the project's Work Reports. Dismiss marks a reminder as read. The notification center retains its normal history.

## Running

Run the Capture backend (or existing monolith) with `INFRA_ENABLED=true`, MongoDB/Redis and the existing service-owned databases. Keep it running to send reminders while browsers are closed. No browser push permission or new package is required.

Supply Capture with the same SMTP configuration already used for account Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `MAIL_FROM`. Set `CONTINUUM_WEB_BASE_URL` to the deployed frontend origin so Email links open the right environment. Never commit populated credentials.

New database fields are optional, additive fields on existing settings/report schemas; there is no backfill or provisioning step. The scan uses the existing status/deadline index. Preferences default to off; a Leader/Manager enables them per project/tier.

## Delivery guarantees

Notification event keys deduplicate per report/deadline. Email uses an atomic five-minute lease with an ownership token and a persisted sent marker per deadline. SMTP errors are retried after the lease expires while the report is still eligible. Each report failure is isolated from other recipients/projects. Stable, hashed SMTP Message-IDs allow provider deduplication where supported.

As with ordinary SMTP, a process crash after SMTP acceptance but before persisting the sent marker can cause a retry. This implementation does not claim exactly-once external delivery. After deadline/submission the next scan skips the report. A membership/submission change racing an already accepted SMTP delivery cannot recall that message.

## Validation

Tests cover controller validation/CSRF, tier authorization, preference persistence across cadence changes, scheduler selection, submitted/expired/removed recipients, concurrent leases, retry, SMTP acceptance/TLS, the chat completion event/bubble and UI save/read-only/error states. Email tests use a mock transport; they do not send real messages.

## Companion AI connection troubleshooting

The floating companion uses the same approved project-scoped AI Chat thread/stream API as the AI Chat page. Choose a project in the companion when outside a project page. Questions are sent verbatim, and the backend thread is reused only for the same user/organization/project. Failed or incomplete streams show an error and retain the question for retry; they never fall back to a generated-looking canned overview.

The legacy `src/main.ts` monolith sets the default IAM service URL to its own listening port before importing AppModule and validating configuration. Explicit `IAM_SERVICE_URL` values are preserved, and standalone service entrypoints keep their existing defaults. Restart the backend after updating this entrypoint. Notification collection schemas are cloned before registering indexes, so repeated repository/model registration does not accumulate duplicate index declarations.

For a shared SAG server, obtain the running API origin from the team administrator and put it in `DATN-BE/.env` as `SAG_API_BASE_URL`. Set `SAG_BFF_SERVICE_TOKEN` locally to the same secret configured on that server. A GitHub repository URL is a source location, not the API origin. The SAG source currently documents localhost port 8000 but does not supply a deployed team-server URL or populated credentials. Pulling source does not start a server or provide its private configuration.
