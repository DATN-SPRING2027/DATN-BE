import { DecisionRequiredLoginEligibilityPolicy } from './login-eligibility.policy';
import { DecisionRequiredOrganizationContextResolver } from './organization-context.resolver';

describe('authentication decision boundaries', () => {
  it('[DECISION_REQUIRED] leaves user-status eligibility undecided by G-04', () => {
    const policy = new DecisionRequiredLoginEligibilityPolicy();

    expect(policy.evaluate({ userStatus: 'ACTIVE' })).toEqual({
      outcome: 'DECISION_REQUIRED',
      gate: 'G-04',
    });
    expect(policy.evaluate({ userStatus: 'SUSPENDED' })).toEqual({
      outcome: 'DECISION_REQUIRED',
      gate: 'G-04',
    });
    expect(policy.evaluate({ userStatus: 'PENDING_INVITE' })).toEqual({
      outcome: 'DECISION_REQUIRED',
      gate: 'G-04',
    });
  });

  it('[UNKNOWN] does not infer organization context; G-01/G-02 remain open', async () => {
    const resolver = new DecisionRequiredOrganizationContextResolver();

    await expect(resolver.resolveForUser('user-123')).resolves.toEqual({
      outcome: 'DECISION_REQUIRED',
      gates: ['G-01', 'G-02'],
    });
  });
});
