import { createReviewWorksheet } from '../../../../../scripts/work-note-agent/review';
import { loadCorpus } from '../../../../../scripts/work-note-agent/evaluation';
describe('Synthetic human review worksheet', () => {
  it('keeps semantic ratings undecided and distinguishes provider failure from reviewed output', () => {
    const c = loadCorpus('v3').cases[0];
    const sheet = createReviewWorksheet({
      classification: 'synthetic-only',
      corpusVersion: loadCorpus('v3').version,
      runId: 'fixture-run',
      rows: [
        {
          caseId: c.id,
          repeat: 1,
          output: {
            status: 'ANSWER',
            message: 'fixture',
            suggestion: null,
            questions: [],
            uncertainties: [],
          },
        },
        {
          caseId: loadCorpus('v3').cases[1].id,
          repeat: 1,
          errorCode: 'TIMEOUT',
        },
      ],
    });
    expect(sheet.semanticAcceptance).toBe('NOT_ESTABLISHED');
    expect(sheet.items[0].ratings.questionNecessity).toBeNull();
    expect(sheet.items[0].acceptedBehaviors.length).toBeGreaterThan(0);
    expect(sheet.items[1].availability).toBe('PROVIDER_FAILURE');
  });
  it('refuses arbitrary corpora, unknown cases and duplicated trial slots', () => {
    const report = {
      classification: 'synthetic-only',
      corpusVersion: loadCorpus('v3').version,
      runId: 'fixture',
      rows: [{ caseId: 'unknown', repeat: 1 }],
    };
    expect(() => createReviewWorksheet(report)).toThrow();
    expect(() =>
      createReviewWorksheet({ ...report, corpusVersion: 'private-data' }),
    ).toThrow();
    const row = { caseId: loadCorpus('v3').cases[0].id, repeat: 1 };
    expect(() =>
      createReviewWorksheet({ ...report, rows: [row, row] }),
    ).toThrow();
  });
});
