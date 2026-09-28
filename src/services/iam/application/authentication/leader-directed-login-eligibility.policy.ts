import { Injectable } from '@nestjs/common';
import type {
  LoginEligibilityDecision,
  LoginEligibilityInput,
  LoginEligibilityPolicy,
} from './login-eligibility.policy';

/** Implements the status matrix selected for this Leader-directed slice. */
@Injectable()
export class LeaderDirectedLoginEligibilityPolicy implements LoginEligibilityPolicy {
  evaluate(input: LoginEligibilityInput): LoginEligibilityDecision {
    return input.userStatus === 'ACTIVE'
      ? { outcome: 'ELIGIBLE' }
      : { outcome: 'INELIGIBLE', gate: 'G-04' };
  }
}
