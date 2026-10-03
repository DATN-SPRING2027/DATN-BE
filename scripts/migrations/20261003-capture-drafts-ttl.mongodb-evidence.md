# `capture_drafts` MongoDB 7 integration evidence

Date: 2026-10-03

## Fixture

- Disposable Docker container: `datn-capture-drafts-ttl-mongo7-disposable`
- MongoDB: 7.0.43
- Replica set: `rs0`
- Loopback port: 27019
- Database exercised: `continuum_capture`
- The integration test required a marker in the fixture's `admin` database,
  rejected non-loopback/credentialed connections, and dropped only
  `continuum_capture` during cleanup.

## Result

`npm run test:capture-drafts-ttl:integration` passed (1/1).

- MongoDB 7 rejected creation of the old compound TTL declaration with code 67. The fixture then represented the closest compatible legacy index state:
  non-unique `{ userId: 1, contextKey: 1 }`.
- Preflight reported one missing and one non-Date `lastSavedAt`, blocked apply,
  and left all five fixture documents and indexes unchanged.
- After removing only those malformed synthetic fixture documents, apply
  replaced the legacy pair index with a unique pair index and created the
  single-field TTL index with `expireAfterSeconds: 2592000`.
- Duplicate `userId + contextKey` insertion failed with duplicate-key code 11000.
- Apply refused without a write-pause confirmation, without review of the
  expired document, and after a synthetic post-report data change; each refusal
  left indexes unchanged.
- Re-running the planner and apply was a no-op for indexes and issued no
  document delete command.
- MongoDB removed the expired Date fixture document through its TTL monitor;
  fresh and updated documents remained. Missing and string-valued timestamps
  inserted after TTL activation remained present and were not counted as
  expired by the report.
- The unrelated sentinel collection's documents and indexes were unchanged.

The observed test diagnostic was:

```text
MongoDB 7.0.43 transformed userId_1_contextKey_1 to unique pair + lastSavedAt_1; expired=1; malformed preflight missing=1/nonDate=1 blocked; unrelated collection unchanged.
```

## Existing database counts

No shared, production, or developer database was queried. Counts of existing
documents with missing or non-Date `lastSavedAt` are therefore **unknown**.
The 1 missing / 1 non-Date counts above belong only to the disposable test
fixture. Run the documented read-only report against each approved target
database before any real index change; the report will return exact counts and
bounded IDs/types. A non-clean report blocks apply and requires a separate data
decision.
