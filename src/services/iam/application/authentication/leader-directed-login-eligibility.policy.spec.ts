import { LeaderDirectedLoginEligibilityPolicy } from './leader-directed-login-eligibility.policy';

describe('LeaderDirectedLoginEligibilityPolicy', () => {
  const policy = new LeaderDirectedLoginEligibilityPolicy();

  it('allows ACTIVE users', () => {
    expect(policy.evaluate({ userStatus: 'ACTIVE' })).toEqual({
      outcome: 'ELIGIBLE',
    });
  });

  it.each(['SUSPENDED', 'PENDING_INVITE', 'UNKNOWN'])(
    'denies %s users',
    (status) => {
      expect(policy.evaluate({ userStatus: status })).toEqual({
        outcome: 'INELIGIBLE',
        gate: 'G-04',
      });
    },
  );
});
