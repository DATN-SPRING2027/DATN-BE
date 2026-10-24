# Organization Leader handover during membership suspension or removal

The existing `POST /iam/organizations/{organizationId}/memberships/{membershipId}/suspend` and `/remove` commands accept an optional `handovers` array in the body:

```json
{
  "expectedMembershipVersion": 3,
  "reasonCode": "ACCESS_REVIEW",
  "handovers": [
    { "projectId": "751a2b3c4d5e6f7a8b9c0d1f", "replacementUserId": "951a2b3c4d5e6f7a8b9c0d1f" }
  ]
}
```

For every active Project where the target has an active `TEAM_LEADER` assignment and active Project membership, a Manager with `project.leader.manage` selects a different active Organization member. The replacement receives active Project membership and the Project-scoped `TEAM_LEADER` assignment. The former Leader's assignment is removed. All handovers and the Organization membership transition commit in one MongoDB transaction. If any Project is omitted, stale, or the replacement is ineligible, the command fails without applying a partial handover.

Suspension changes the Organization membership to `SUSPENDED`, removes all Project-scoped assignments, and deactivates all active Project memberships. Resuming the Organization membership does not silently restore Project access. Removal changes the membership to `REMOVED`, deletes all role assignments, and deactivates active Project memberships. Existing authored records remain intact.

No schema or migration is required. Clients must still send the existing CSRF token and idempotency key. Pending sessions lose effective Organization/Project access because authorization requires an active Organization membership; Project grants are also revoked in the transaction.
