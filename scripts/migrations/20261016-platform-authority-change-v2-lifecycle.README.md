# Platform authority lifecycle V2 migration

This is the report-first follow-up for the bundle-based PO-AUTH-01 lifecycle.
It ensures the operation and lock indexes, provisions one shared
`PLATFORM_OPERATOR_LIFECYCLE` lock, and drops only the exact unapproved
`platform_authority_operation_expiry` TTL index. It never updates or deletes
assignment, ledger, or audit documents. Existing per-permission locks and the
older target index are preserved.

The dry-run report is redacted: it includes database/target identity, collection
counts, index plans, and aggregate findings, but no `_id`, user ID, or operation
ID. Duplicate operation IDs, unexpected TTL indexes, duplicate lock keys,
malformed lock rows, or conflicting index definitions block apply.

Do not run or apply this migration until the signed Security/IAM and
Audit/Privacy/Legal decisions and target-specific read-only staging/production
reports required by the canonical DATN-295 contract are attached. The reports
are environment-specific; use a fresh SHA-256 for every environment and every
database state.

The apply preserves all existing records. Dropping a TTL index cannot restore
records already expired by MongoDB, so the live state remains UNVERIFIED until
the authorized DB owner provides the redacted report.
