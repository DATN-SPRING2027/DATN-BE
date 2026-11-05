import {
  aggregateFeedbackTelemetry,
  buildPrivacySafeFeedbackRecord,
} from './work-note-feedback-telemetry';
import { assembleAssessment } from './work-note-assessment.state';
import { CANONICAL_ASSESSMENT_INPUT } from './prompt-fingerprint.fixtures';

describe('Privacy-safe assessment feedback telemetry & aggregator (D6 / F9)', () => {
  it('strips all note/task/answer text and records only safe metadata + open needCodes', () => {
    const view = assembleAssessment(
      CANONICAL_ASSESSMENT_INPUT,
      {
        purpose: 'QA',
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'SENSITIVE_OBJECTIVE_TEXT',
          scope: 'SENSITIVE_SCOPE_TEXT',
          requirements: [],
          unknowns: [],
        },
        claims: [
          {
            text: 'Implemented tenant_id guard in middleware; integration test not run yet.',
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
            sourceRefs: [
              {
                sourceId: 'note.body',
                quote:
                  'Implemented tenant_id guard in middleware; integration test not run yet.',
              },
            ],
          },
        ],
        coverage: [],
        gaps: [
          {
            kind: 'RESULT',
            needCode: 'test_result.behavior',
            target: 'SENSITIVE_TARGET_TEXT',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [
              {
                sourceId: 'note.body',
                quote:
                  'Implemented tenant_id guard in middleware; integration test not run yet.',
              },
            ],
          },
        ],
        noteAdequacy: 'NEEDS_AUTHOR_INPUT',
        nextQuestion: {
          gapIndex: 0,
          text: 'SENSITIVE_QUESTION_TEXT?',
          reason: 'SENSITIVE_REASON',
          options: [],
        },
      },
      {
        sourceRevision: 1,
        taskContextHash: 'hash-1',
        model: 'mistralai/ministral-14b',
        expiresAt: '2026-12-31T00:00:00.000Z',
        promptVersion: 'task-note-assessment/2026-11-03.v26',
      },
    );

    const record = buildPrivacySafeFeedbackRecord({
      view,
      category: 'UNNECESSARY_QUESTION',
      architecture: 'combined',
      recordedAt: new Date('2026-11-03T02:00:00.000Z'),
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('SENSITIVE_');
    expect(serialized).not.toContain('tenant_id');
    expect(record).toEqual({
      assessmentId: view.id,
      promptVersion: 'task-note-assessment/2026-11-03.v26',
      model: 'mistralai/ministral-14b',
      architecture: 'combined',
      purpose: 'QA',
      noteAdequacy: 'NEEDS_AUTHOR_INPUT',
      category: 'UNNECESSARY_QUESTION',
      openNeedCodes: ['test_result.behavior'],
      recordedAt: new Date('2026-11-03T02:00:00.000Z'),
    });
  });

  it('flags only recurring patterns (>= threshold distinct assessments) as synthetic-case candidates', () => {
    const base = {
      promptVersion: 'task-note-assessment/2026-11-02.v25',
      model: 'mistralai/ministral-14b',
      architecture: 'combined' as const,
      purpose: 'QA' as const,
      noteAdequacy: 'ENOUGH_FOR_PURPOSE' as const,
      category: 'FALSE_SUFFICIENT' as const,
      openNeedCodes: ['test_result.behavior'],
      recordedAt: new Date('2026-11-03T02:00:00.000Z'),
    };

    // Same assessment clicking feedback 4 times does NOT count as 3 distinct assessments
    const singleAssessmentSpam = [
      { ...base, assessmentId: 'a-1' },
      { ...base, assessmentId: 'a-1' },
      { ...base, assessmentId: 'a-1' },
      { ...base, assessmentId: 'a-1' },
    ];
    const spamSummary = aggregateFeedbackTelemetry(singleAssessmentSpam, 3);
    expect(spamSummary.recurringCandidates).toHaveLength(0);
    expect(spamSummary.buckets[0].distinctAssessments).toBe(1);

    // 3 distinct assessments with the same promptVersion x purpose x category triggers candidate flag
    const recurring = [
      ...singleAssessmentSpam,
      { ...base, assessmentId: 'a-2' },
      { ...base, assessmentId: 'a-3' },
      {
        ...base,
        assessmentId: 'b-1',
        purpose: 'PROGRESS' as const,
        category: 'MISSING_QUESTION' as const,
      },
    ];
    const summary = aggregateFeedbackTelemetry(recurring, 3);
    expect(summary.recurringCandidates).toHaveLength(1);
    expect(summary.recurringCandidates[0]).toMatchObject({
      promptVersion: 'task-note-assessment/2026-11-02.v25',
      purpose: 'QA',
      category: 'FALSE_SUFFICIENT',
      distinctAssessments: 3,
      candidateForSyntheticCase: true,
    });
  });
});
