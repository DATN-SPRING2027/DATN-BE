import {
  assessmentDomains,
  loadDomainAssessmentCorpus,
  createAssessmentCampaign,
} from '../../../../../scripts/work-note-agent/assessment-domains';
import {
  loadAssessmentCorpus,
  type AssessmentScenario,
} from '../../../../../scripts/work-note-agent/assessment-evaluation';
import {
  collectIndependentCases,
  summarizeCampaignCase,
  assertCampaignCeiling,
  type CaseObservation,
} from '../../../../../scripts/work-note-agent/assessment-campaign';

describe('Cross-domain assessment campaign coverage', () => {
  it.each([1, 29, 175])(
    'rejects a live campaign ceiling %s that disagrees with the shared 176-call phase ledger',
    (maxAttempts) => {
      expect(() => assertCampaignCeiling({ live: true, maxAttempts })).toThrow(
        'CAMPAIGN_REQUIRES_EXPLICIT_176_CALL_CEILING',
      );
    },
  );
  it('accepts the explicit live ceiling and permits lower-budget non-network dry-runs', () => {
    expect(() =>
      assertCampaignCeiling({ live: true, maxAttempts: 176 }),
    ).not.toThrow();
    expect(() =>
      assertCampaignCeiling({ live: false, maxAttempts: 29 }),
    ).not.toThrow();
  });
  it.each([401, 429, 503])(
    'recognizes HTTP %s as infrastructure failure rather than a Task information gap',
    (status) => {
      const c = createAssessmentCampaign().scenarios[0];
      expect(
        summarizeCampaignCase(
          c,
          [
            {
              caseId: c.id,
              turn: 1,
              role: 'analysis',
              errorCode: `XKIRO_HTTP_ERROR_${status}`,
            },
          ],
          1,
          0,
          175,
        ).providerFailure,
      ).toBe(true);
    },
  );
  const observation = (id: string): CaseObservation => ({
    caseId: id,
    split: 'validation',
    family: 'test',
    expectedTurns: 1,
    attemptedTurns: 1,
    analysisPass: true,
    editor: 'NOT_REQUESTED',
    failures: [],
    actualCalls: 1,
    reportedTokens: 10,
    remainingCalls: 10,
    providerFailure: false,
    critical: false,
  });
  it('rejects mismatched case evidence rather than falsely counting a missing domain as tested', async () => {
    await expect(
      collectIndependentCases(
        createAssessmentCampaign().scenarios.slice(0, 1),
        () => Promise.resolve(observation('another-case')),
      ),
    ).rejects.toThrow('CAMPAIGN_CASE_MISMATCH');
  });
  it('closes a failed critical fixture and tests the next independent fixture without accepting the failure', async () => {
    const cases = createAssessmentCampaign().scenarios.slice(0, 2);
    const result = await collectIndependentCases(cases, (c) =>
      Promise.resolve({
        ...observation(c.id),
        analysisPass: c.id !== cases[0].id,
        critical: c.id === cases[0].id,
        failures: c.id === cases[0].id ? ['FORBIDDEN_ASSERTION'] : [],
      }),
    );
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].analysisPass).toBe(false);
    expect(result.observations[1].analysisPass).toBe(true);
    expect(result.unattemptedCaseIds).toHaveLength(0);
  });
  it('stops before another fixture when budget is exhausted and exposes unattempted cases', async () => {
    const cases = createAssessmentCampaign().scenarios.slice(0, 3),
      execute = jest.fn((c: AssessmentScenario) =>
        Promise.resolve({ ...observation(c.id), remainingCalls: 0 }),
      );
    const result = await collectIndependentCases(cases, execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('CAMPAIGN_BUDGET_EXHAUSTED');
    expect(result.unattemptedCaseIds).toEqual(cases.slice(1).map((c) => c.id));
  });
  it('halts after three consecutive infrastructure failures without relabeling them as missing Task requirements', async () => {
    const cases = createAssessmentCampaign().scenarios.slice(0, 5);
    const result = await collectIndependentCases(cases, (c) =>
      Promise.resolve({
        ...observation(c.id),
        analysisPass: false,
        providerFailure: true,
        failures: ['XKIRO_HTTP_ERROR_503'],
      }),
    );
    expect(result.observations).toHaveLength(3);
    expect(result.stopReason).toBe('CAMPAIGN_PROVIDER_FAILURE_LIMIT');
    expect(result.unattemptedCaseIds).toHaveLength(2);
  });
  it('does not mark a multi-turn case successful when a scripted turn was never reached', () => {
    const c = createAssessmentCampaign().scenarios.find(
      (c) => c.turns.length === 3,
    )!;
    expect(
      summarizeCampaignCase(
        c,
        [
          {
            caseId: c.id,
            turn: 1,
            grade: {
              automatedPass: true,
              failures: [],
              semanticAcceptance: 'NOT_ESTABLISHED',
              manualReview: 'required',
            },
            runtimeGrade: {
              automatedPass: true,
              failures: [],
              semanticAcceptance: 'NOT_ESTABLISHED',
              manualReview: 'required',
            },
          },
        ],
        1,
        10,
        175,
      ).analysisPass,
    ).toBe(false);
  });
  it('maps every original family to a domain without changing the frozen 72 scenarios or splits', () => {
    const base = loadAssessmentCorpus(),
      before = JSON.stringify(base);
    const campaign = createAssessmentCampaign();
    expect(campaign.scenarios).toHaveLength(80);
    expect(new Set(campaign.scenarios.map((s) => s.id)).size).toBe(80);
    expect(JSON.stringify(loadAssessmentCorpus())).toBe(before);
    for (const s of campaign.scenarios)
      expect(assessmentDomains.some((d) => d.families.includes(s.family))).toBe(
        true,
      );
    expect(
      campaign.scenarios.slice(0, 12).every((s) => s.split === 'validation'),
    ).toBe(true);
    expect(
      campaign.scenarios.slice(12, 36).every((s) => s.split === 'holdout'),
    ).toBe(true);
    for (const domain of assessmentDomains)
      expect(
        campaign.scenarios.some((s) => domain.families.includes(s.family)),
      ).toBe(true);
  });
  it('adds independently authored complete/incomplete cases for UX design, BA, AI evaluation and documentation', () => {
    const extra = loadDomainAssessmentCorpus();
    expect(extra.scenarios).toHaveLength(8);
    expect(new Set(extra.scenarios.map((s) => s.family)).size).toBe(4);
    for (const family of new Set(extra.scenarios.map((s) => s.family))) {
      const cases = extra.scenarios.filter((s) => s.family === family);
      expect(cases.map((c) => c.turns[0].expected.question).sort()).toEqual([
        'none',
        'required',
      ]);
      for (const c of cases) {
        expect(c.synthetic).toBe(true);
        expect(
          c.sources.every(
            (s) => s.loadStatus === 'LOADED' && s.includedInRequest,
          ),
        ).toBe(true);
        expect(c.sources.some((s) => s.id === 'task.step.0')).toBe(true);
        expect(c.rubric.prohibited.length).toBeGreaterThan(1);
      }
    }
  });
});
