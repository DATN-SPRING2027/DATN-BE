# Project Foundation migration dry-run

- Observed: 2026-09-30
- Database: `continuum_db`
- Reviewed target fingerprint: `459d206d526add404faabb577cb784a370b0f86350ff47d84357cd5154877782`
- Report SHA-256: `6dc16f880346d1f06e9d0875211dabb0e6b835faa8171c824525d2ccbceaac63`
- Result: `clean: true`
- Applied: no

| Check | Result |
|---|---:|
| Existing Projects | 0 |
| Projects to backfill as `PRIVATE` | 0 |
| Existing Project Memberships | 0 |
| Duplicate membership pairs | 0 |
| Malformed or cross-Organization memberships | 0 |
| Invalid Project visibility or Organization scope | 0 |
| Unique `(projectId, userId)` membership index | `CREATE` |

The report found no legacy Project data to update and no ambiguous Project
Membership relationships. Applying this migration would create the unique
Project Membership index; the dry-run did not write to the database.
