import { Injectable } from '@nestjs/common';

export const LOGIN_ELIGIBILITY_POLICY = Symbol('LOGIN_ELIGIBILITY_POLICY');

export interface LoginEligibilityInput {
  userStatus: string;
}

export type LoginEligibilityDecision =
  | { outcome: 'ELIGIBLE' }
  | { outcome: 'INELIGIBLE'; gate: 'G-04' }
  | { outcome: 'DECISION_REQUIRED'; gate: 'G-04' };

export interface LoginEligibilityPolicy {
  evaluate(input: LoginEligibilityInput): LoginEligibilityDecision;
}

/** Fail-closed adapter until the authorized G-04 status policy is recorded. */
@Injectable()
export class DecisionRequiredLoginEligibilityPolicy implements LoginEligibilityPolicy {
  evaluate(input: LoginEligibilityInput): LoginEligibilityDecision {
    void input;
    return { outcome: 'DECISION_REQUIRED', gate: 'G-04' };
  }
}
