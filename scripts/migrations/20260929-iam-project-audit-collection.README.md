# IAM Project audit collection

The requester chose a dedicated `audit_logs_iam` collection in shared `continuum_db` for the Project Foundation MVP. The Project create API writes a Project and its `project.create` audit event in one MongoDB transaction. This migration creates only the empty audit collection so that the first transaction never needs to create it implicitly.

Run the script without `--apply` to inspect the configured runtime and record its report SHA-256. Review the database target, collection state, action, and document count before applying:

```powershell
node scripts/migrations/20260929-iam-project-audit-collection.mjs
node scripts/migrations/20260929-iam-project-audit-collection.mjs --apply --expected-report-sha256=<reviewed-hash>
```

The script checks the target again before any write. It creates the collection only if missing, preserves existing documents, verifies the result, and returns `NOOP` on rerun. It does not create an audit event or a Project record. The collection name and event shape are recorded in `docs/decisions/project-foundation-read-mvp.md` on the API branch.
