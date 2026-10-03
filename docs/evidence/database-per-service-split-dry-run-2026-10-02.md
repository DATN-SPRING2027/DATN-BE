# Database-per-service split evidence

## Historical dry-run snapshot (2026-10-02)

This read-only report predates the latest bounded scanner and schema-index
manifest implementation below. Its hashes and counts are evidence only for
the exact older implementation recorded here; it is not a current-head dry-run.

- **Migration:** `20261002-database-per-service-split-v1`
- **Run date:** 2026-10-02
- **Mode:** Read-only dry-run against the MongoDB target configured in the local environment.
- **Result:** `clean: true`; process exit code `0`.
- **Implementation SHA-256:** `203c3e96eba8a07b021d82da0a3203ba8f311fea6c256c3c99ae8367a19e475e`
- **Reviewed report SHA-256:** `85e4a6db7ada92af8617eef7632c2c1b9b1ab34cf2443488d5c8f0fe4a31fba0`

| Finding                                               | Count |
| ----------------------------------------------------- | ----: |
| Source collections                                    |    54 |
| Mapped collections                                    |    54 |
| Source documents                                      |    19 |
| Documents planned for insert                          |    19 |
| Unowned source collections                            |     0 |
| Same-ID content conflicts                             |     0 |
| Unique-index collisions / unverifiable unique indexes | 0 / 0 |
| Incompatible collection options                       |     0 |
| Missing destination indexes to create                 |    48 |

The full report, including per-record IDs and digests, was saved outside the
repository at
`%TEMP%/datn-db-per-service-dry-run-20261002.json` for local review. It is not
checked in because it contains environment data. This snapshot can become
stale; apply always rescans and requires the report hash to match.

Replica-set integration had not been run at the time this historical report
was generated because `MONGODB_INTEGRATION` was disabled. Current integration
evidence is recorded below. No production cutover was attempted.

No database collection, document, or index was written or changed. The live
copy remains gated on a verified backup, paused source and target writers, and
separate environment cutover authorization. The legacy source is preserved.

## Latest PR #13 review validation (2026-10-03)

- **Scope:** real migration runner against a disposable local Docker fixture at
  `127.0.0.1:27018`, MongoDB `7.0.43`, replica set `rs0`; no URI credentials.
- **Command:** `npm run test:migrations:integration` with
  `MONGODB_INTEGRATION=true`, marker `datn-pr13-mongo7-disposable`, and the
  loopback fixture URI; the runner process was explicitly set to
  `MONGODB_AUTO_INDEX=false`.
- **Result:** 10/10 integration tests passed; 0 skipped. The tests exercised
  successful apply and exact rerun, failure during index creation followed by
  recovery, schema-required index creation, unique/collation and TTL guards,
  supported same-key variants, destination-only blocking, source preservation,
  and bounded-scan behavior.
- **Measured 32 MiB+ scan:** 4 documents, 33,554,720 EJSON document bytes,
  6,124 serialized report bytes, peak V8 heap 87,036,512 bytes, peak RSS
  234,438,656 bytes. Limits were 100,000 documents, 67,108,864 EJSON bytes,
  33,554,432 report bytes, and 536,870,912 V8 heap bytes.
- **Over-limit behavior:** five 13 MiB fixture documents exceeded the 64 MiB
  EJSON input budget. The runner exited nonzero without a partial report/hash;
  source fixture documents remained present and the destination remained empty.
- **Cleanup:** the disposable Docker container was removed after the suite.
  The integration fixture did not connect to or write any shared/live database.
- **Cutover:** not attempted. No live database was read or modified by this
  validation.
