import { TaskInboundContextVerificationError } from '../task-inbound-context';
import type { TaskInboundContextVerifier } from '../task-inbound-context';
import type { TaskDelegationAssertionPrototypeVerifier } from './task-delegation-assertion.prototype';
import type { TaskDelegationReplayStore } from './task-delegation-replay-store.prototype';

/**
 * Prototype-only composition: release verified context only after the shared
 * replay store atomically consumes the assertion ID. Store outages fail closed.
 */
export class ConsumingTaskDelegationAssertionPrototypeVerifier implements TaskInboundContextVerifier {
  constructor(
    private readonly verifier: TaskDelegationAssertionPrototypeVerifier,
    private readonly replayStore: TaskDelegationReplayStore,
  ) {}

  async verify(candidate: unknown, binding: unknown) {
    const verified = this.verifier.verifyWithReplayEvidence(candidate, binding);
    let consumed: boolean;
    try {
      consumed = await this.replayStore.consume(verified.replay);
    } catch {
      throw new TaskInboundContextVerificationError('VERIFICATION_FAILED');
    }
    if (!consumed) {
      throw new TaskInboundContextVerificationError('REPLAY_DETECTED');
    }
    return verified.context;
  }
}
