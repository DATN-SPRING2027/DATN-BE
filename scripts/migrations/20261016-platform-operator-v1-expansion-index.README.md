# Platform Operator V1 expansion index

Report-first, additive migration for the `platform_authority_snapshot_provenance`
index on `continuum_iam.platform_authority_assignments`. The index supports
provenance-aware inspection of a complete assignment snapshot during explicit
V1 expansion. It does not modify assignments, grant permissions, provision
lock records, change a validator, or touch the operation ledger/audit data.

Run the dry-run against one explicitly selected environment and review its
redacted report. Apply requires the SHA-256 from that exact report and rechecks
the target/database fingerprint and index state. The report contains counts and
index metadata only; it does not expose user or assignment identifiers.

Rollback is `dropIndex('platform_authority_snapshot_provenance')` on the IAM
database after the application is returned to a version that does not require
the index. It removes only the index and does not alter stored documents.

This migration does not establish that an environment is approved or ready.
Do not apply before the external Security/IAM, Audit/Privacy/Legal, and
environment-specific DB evidence gates recorded in the canonical contract
close. The live database state remains unverified by this code change.
