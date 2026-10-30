import {
  ASSESSMENT_NEED_CODES,
  PURPOSE_RUBRIC_TABLE,
  classifyGapNeedCode,
  checkRawModelOutputConsistency,
  deriveTaskCompletionStatus,
  extractGapNeedCode,
} from './work-note-assessment.rubric';
import { ASSESSMENT_PURPOSES } from './work-note-assessment.types';

describe('WorkNote assessment purpose rubric & gap taxonomy (Plan v3 §§1, 3, 5)', () => {
  it('defines explicit decision rules and contrastive examples for every resolved purpose', () => {
    const resolved = ASSESSMENT_PURPOSES.filter((p) => p !== 'AUTO');
    expect(Object.keys(PURPOSE_RUBRIC_TABLE).sort()).toEqual(
      [...resolved].sort(),
    );
    for (const purpose of resolved) {
      const rule = PURPOSE_RUBRIC_TABLE[purpose];
      expect(rule.requiredForAdequacy.length).toBeGreaterThan(0);
      expect(rule.forbiddenExtraDemands.length).toBeGreaterThan(0);
      expect(rule.requireWholeTaskCoverage).toBe(purpose === 'COMPLETION');
      expect(rule.contrastiveExamples.sufficient.note).not.toBe(
        rule.contrastiveExamples.insufficient.note,
      );
      expect(ASSESSMENT_NEED_CODES).toContain(
        rule.contrastiveExamples.insufficient.missingNeed,
      );
    }
  });

  it('classifies actor/role permission gaps consistently regardless of gap kind or phrasing', () => {
    const variants = [
      {
        kind: 'EVIDENCE' as const,
        owner: 'NOTE_AUTHOR' as const,
        target: 'actor đã dùng để kiểm tra quyền',
      },
      {
        kind: 'RESULT' as const,
        owner: 'NOTE_AUTHOR' as const,
        target: 'kết quả kiểm tra cho tác giả chỉnh sửa và người ngoài project',
      },
      {
        kind: 'SCOPE' as const,
        owner: 'NOTE_AUTHOR' as const,
        target: 'vai trò hoặc tài khoản nào đã thử',
      },
    ];
    for (const v of variants) {
      expect(classifyGapNeedCode(v, 'COMPLETION')).toBe('test_context.actor');
    }
  });

  it('extracts canonical needCode embedded in server gap IDs', () => {
    expect(extractGapNeedCode('gap-test_context.actor-0123456789abcdef')).toBe(
      'test_context.actor',
    );
    expect(extractGapNeedCode('gap-legacy1234567890')).toBeNull();
  });

  it('separates Note adequacy from Task completion status deterministically', () => {
    expect(
      deriveTaskCompletionStatus({
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'Retry upload',
          scope: 'Upload',
          requirements: [
            { id: 'req-1', text: 'Retry single file', sourceRefs: [] },
            { id: 'req-2', text: 'Recover on network drop', sourceRefs: [] },
          ],
          unknowns: [],
        },
        coverage: [
          { requirementId: 'req-1', status: 'SUPPORTED', sourceRefs: [] },
          { requirementId: 'req-2', status: 'NOT_REPORTED', sourceRefs: [] },
        ],
      }),
    ).toBe('CRITERIA_INCOMPLETE');

    expect(
      deriveTaskCompletionStatus({
        taskContextStatus: 'CLEAR',
        taskUnderstanding: {
          objective: 'Retry upload',
          scope: 'Upload',
          requirements: [
            { id: 'req-1', text: 'Retry single file', sourceRefs: [] },
          ],
          unknowns: [],
        },
        coverage: [
          { requirementId: 'req-1', status: 'SUPPORTED', sourceRefs: [] },
        ],
      }),
    ).toBe('CRITERIA_REPORTED_MET');

    expect(
      deriveTaskCompletionStatus({
        taskContextStatus: 'INSUFFICIENT',
        taskUnderstanding: {
          objective: 'Vague task',
          scope: '',
          requirements: [],
          unknowns: ['Missing criteria'],
        },
        coverage: [],
      }),
    ).toBe('CRITERIA_UNSPECIFIED');
  });

  it('detects inconsistent raw model outputs (ENOUGH with BLOCKING gap, OPTIONAL question)', () => {
    expect(
      checkRawModelOutputConsistency({
        purpose: 'PROGRESS',
        taskUnderstanding: {
          objective: 'A',
          scope: 'B',
          requirements: [],
          unknowns: [],
        },
        claims: [],
        coverage: [],
        gaps: [
          {
            kind: 'RESULT',
            target: 'chưa kiểm thử mất mạng',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [{ sourceId: 'note.body', quote: 'chưa kiểm thử' }],
          },
        ],
        taskContextStatus: 'CLEAR',
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
        nextQuestion: {
          gapIndex: 0,
          text: 'Kết quả mất mạng?',
          reason: 'Chưa test',
          options: [],
        },
      }),
    ).toEqual(['ENOUGH_WITH_BLOCKING_GAP', 'ENOUGH_WITH_QUESTION']);
  });
});
