import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssessmentPhaseBudget } from '../../../../../scripts/work-note-agent/assessment-phase-budget';
import { AssessmentAttemptBudget } from '../../../../../scripts/work-note-agent/assessment-run';
describe('Cumulative synthetic pilot budget survives process instances', () => {
  let directory: string, file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'worknote-phase-'));
    file = join(directory, 'budget.json');
  });
  afterEach(() => {
    unlinkSync(file);
    rmdirSync(directory);
  });
  it('reports cumulative local exhaustion as a budget denial before HTTP, not a provider network error', async () => {
    const phase = new AssessmentPhaseBudget(file, 1, 10000);
    phase.settle(phase.reserve(1000), 200);
    const network = jest.fn();
    const attempt = new AssessmentAttemptBudget(29, 10000, network, phase);
    await expect(
      attempt.fetch('https://api.xkiro.com/v1/chat/completions', {
        body: JSON.stringify({ max_tokens: 128 }),
      }),
    ).rejects.toThrow('PHASE_HTTP_ATTEMPT_BUDGET');
    expect(attempt.denialCode).toBe('PHASE_HTTP_ATTEMPT_BUDGET');
    expect(network).not.toHaveBeenCalled();
    expect(attempt.snapshot().actualHttpAttempts).toBe(0);
  });
  it('shares an aggregate ceiling rather than resetting it between tuning batches', () => {
    const first = new AssessmentPhaseBudget(file, 2, 10000);
    first.settle(first.reserve(1000), 200);
    const second = new AssessmentPhaseBudget(file, 2, 10000);
    second.reserve(1000);
    expect(() =>
      new AssessmentPhaseBudget(file, 2, 10000).reserve(1000),
    ).toThrow('PHASE_HTTP_ATTEMPT_BUDGET');
    expect(second.snapshot()).toMatchObject({
      actualHttpAttempts: 2,
      reportedTokens: 200,
      unknownUsageAttempts: 1,
      accountedTokens: 1200,
    });
  });
  it('retains reservations for crashed/unknown calls and rejects duplicate settlement', () => {
    const budget = new AssessmentPhaseBudget(file, 29, 1500);
    const ticket = budget.reserve(1000);
    budget.settle(ticket, null);
    expect(() => budget.settle(ticket, 0)).toThrow('PHASE_SETTLEMENT_INVALID');
    expect(() =>
      new AssessmentPhaseBudget(file, 29, 1500).reserve(1000),
    ).toThrow('PHASE_TOKEN_RESERVATION_BUDGET');
  });
  it('fails closed when a subsequent process tries to expand the ceiling', () => {
    new AssessmentPhaseBudget(file, 29, 10000);
    expect(() => new AssessmentPhaseBudget(file, 30, 10000)).toThrow(
      'PHASE_BUDGET_INVALID',
    );
  });
});
