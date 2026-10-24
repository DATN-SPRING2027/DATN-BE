# Notification request-flow indexes

This additive migration aligns `continuum_notification.notifications` with the
indexes declared by the Notification persistence contract. It creates only
missing indexes; it never updates or deletes notification documents.

The preflight blocks if a 90-day TTL index would immediately expire existing
documents, if `(recipientId, eventKey)` contains duplicates, if the collection
or database is unexpected, or if an index with a desired name/key has different
options. The migration requires an explicit URI, a reviewed dry-run hash, and
notification writes paused before apply. It does not load `.env` itself.

Run a dry-run with `NOTIFICATION_MONGODB_URI` explicitly set by the operator:

```powershell
$env:NOTIFICATION_MONGODB_URI = '<approved notification database URI>'
npm run migrate:notification-request-flow-indexes
```

After reviewing the redacted plan, pause the notification writer and apply the
exact plan hash:

```powershell
npm run migrate:notification-request-flow-indexes -- --apply `
  --notification-writes-paused `
  --expected-report-sha256=<reviewed hash>
```

Run `npm run test:notification-request-flow-indexes-plan` to check the pure
preflight planner. The dry-run itself does not modify MongoDB.
