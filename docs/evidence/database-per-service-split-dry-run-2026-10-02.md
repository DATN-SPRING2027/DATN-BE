# Database-per-service split dry-run

- **Migration:** `20261002-database-per-service-split-v1`
- **Run date:** 2026-10-02
- **Mode:** Read-only dry-run against the MongoDB target configured in the local environment.
- **Result:** `clean: true`; process exit code `0`.
- **Implementation SHA-256:** `203c3e96eba8a07b021d82da0a3203ba8f311fea6c256c3c99ae8367a19e475e`
- **Reviewed report SHA-256:** `85e4a6db7ada92af8617eef7632c2c1b9b1ab34cf2443488d5c8f0fe4a31fba0`

| Finding | Count |
| --- | ---: |
| Source collections | 54 |
| Mapped collections | 54 |
| Source documents | 19 |
| Documents planned for insert | 19 |
| Unowned source collections | 0 |
| Same-ID content conflicts | 0 |
| Unique-index collisions / unverifiable unique indexes | 0 / 0 |
| Incompatible collection options | 0 |
| Missing destination indexes to create | 48 |

The full report, including per-record IDs and digests, was saved outside the
repository at
`%TEMP%/datn-db-per-service-dry-run-20261002.json` for local review. It is not
checked in because it contains environment data. This snapshot can become
stale; apply always rescans and requires the report hash to match.

Replica-set integration was not run because `MONGODB_INTEGRATION` was disabled
in the environment. No production cutover was attempted.

No database collection, document, or index was written or changed. The live
copy remains gated on a verified backup, paused source and target writers, and
separate environment cutover authorization. The legacy source is preserved.
