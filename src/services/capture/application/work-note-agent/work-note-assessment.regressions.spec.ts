import {
  buildAssessmentMessages,
  parseAssessmentOutput,
} from './work-note-assessment.protocol';
import { assembleAssessment } from './work-note-assessment.state';
import {
  gradeAssessment,
  loadAssessmentCorpus,
} from '../../../../../scripts/work-note-agent/assessment-evaluation';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
} from './work-note-assessment.types';
import { hasNoNewInformation } from './work-note-assessment.context';

const scenario = () =>
  loadAssessmentCorpus().scenarios.find(
    (c) => c.id === 'assessment-permission-matrix-b',
  )!;
const input = (): AssessmentModelInput => ({
  sources: scenario().sources,
  purpose: 'COMPLETION',
  answers: [],
  previous: null,
});
function output(): AssessmentModelOutput {
  const note = scenario().sources.find((s) => s.id === 'note.body')!.text;
  return {
    purpose: 'COMPLETION',
    taskUnderstanding: {
      objective: 'Quyền chỉnh sửa',
      scope: 'Task Note',
      requirements: [],
      unknowns: [],
    },
    claims: [
      {
        text: note,
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
        sourceRefs: [{ sourceId: 'note.body', quote: note }],
      },
    ],
    coverage: [],
    gaps: [
      {
        kind: 'EVIDENCE',
        target:
          'kết quả kiểm tra quyền chỉnh sửa cho tác giả và người ngoài project',
        impact: 'BLOCKING',
        owner: 'NOTE_AUTHOR',
        sourceRefs: [{ sourceId: 'note.body', quote: note }],
      },
    ],
    taskContextStatus: 'CLEAR',
    noteAdequacy: 'NEEDS_AUTHOR_INPUT',
    nextQuestion: {
      gapIndex: 0,
      text: 'Kết quả kiểm tra quyền theo từng vai trò?',
      reason: 'Thiếu kết quả.',
      options: [],
    },
  };
}
const assemble = (i: AssessmentModelInput, o: AssessmentModelOutput) =>
  assembleAssessment(i, o, {
    sourceRevision: 1,
    taskContextHash: 'task',
    model: 'fixture',
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });

describe('Observed assessment release-gate regressions', () => {
  it.each([
    ['Tôi chưa có chi tiết mới về actor.', true],
    ['Chưa biết.', true],
    ["I don't have new information about the actor.", true],
    ['Chưa có thông tin mới; tôi đã kiểm tra bằng tài khoản tác giả.', false],
    ['Đã thử local, chưa biết kết quả staging.', false],
    ['Chưa kiểm thử đổi múi giờ.', false],
  ])('conservatively interprets no-information reply %s', (text, expected) => {
    expect(
      hasNoNewInformation({
        id: 'a',
        gapId: 'g',
        target: 'actor',
        disposition: 'answered',
        answer: text,
        purpose: 'COMPLETION',
        taskContextHash: 'task',
      }),
    ).toBe(expected);
  });
  it('sends an explicit no-repeat ledger and exact Task extraction passages', () => {
    const i = input(),
      prior = assemble(i, output());
    i.previous = prior;
    i.answers = [
      {
        id: 'a',
        gapId: prior.gaps[0].id,
        target: prior.gaps[0].target,
        disposition: 'answered',
        answer: 'Tôi chưa có chi tiết mới về actor.',
        purpose: 'COMPLETION',
        taskContextHash: 'task',
      },
    ];
    const payload = JSON.parse(buildAssessmentMessages(i).at(-1)!.content) as {
      clarificationLedger: { mayAskAgain: boolean; information: string }[];
      requirementPassages: { sourceId: string; quote: string }[];
    };
    expect(payload.clarificationLedger[0]).toMatchObject({
      mayAskAgain: false,
      information: 'NO_NEW_INFORMATION',
    });
    expect(payload.requirementPassages).toContainEqual({
      sourceId: 'task.step.0',
      quote: 'Tác giả chỉnh sửa được.',
    });
    expect(
      payload.requirementPassages.some((p) => p.sourceId === 'task.status'),
    ).toBe(false);
  });
  it('keeps a no-information answer unresolved even if the model drops the gap and cites that answer as a new fact', () => {
    const i = input(),
      prior = assemble(i, output()),
      text = 'Tôi chưa có chi tiết mới về actor.';
    i.previous = prior;
    i.answers = [
      {
        id: 'a',
        gapId: prior.gaps[0].id,
        target: prior.gaps[0].target,
        disposition: 'answered',
        answer: text,
        purpose: 'COMPLETION',
        taskContextHash: 'task',
      },
    ];
    i.sources.push({
      id: 'answer.a',
      kind: 'ANSWER',
      label: 'Answer',
      text,
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    });
    const o = output();
    o.gaps = [];
    o.nextQuestion = null;
    o.claims.push({
      text,
      sourceRefs: [{ sourceId: 'answer.a', quote: text }],
      originKind: 'AUTHOR_REPORT',
      supportRelation: 'FULL',
    });
    const v = assemble(i, o);
    expect(v.gaps[0].status).toBe('unknown');
    expect(v.counters.noProgress).toBe(1);
    expect(v.noteAdequacy).not.toBe('ENOUGH_FOR_PURPOSE');
  });
  it('does not evade the no-repeat ledger by changing a gap kind or adding an answer reference', () => {
    const i = input(),
      prior = assemble(i, output());
    i.previous = prior;
    i.answers = [
      {
        id: 'a',
        gapId: prior.gaps[0].id,
        target: prior.gaps[0].target,
        disposition: 'unknown',
        purpose: 'COMPLETION',
        taskContextHash: 'task',
      },
    ];
    const o = output();
    o.gaps[0].kind = 'RESULT';
    o.gaps[0].target =
      'kết quả kiểm tra quyền chỉnh sửa cho người ngoài project và tác giả';
    const v = assemble(i, o);
    expect(v.gaps[0].id).toBe(prior.gaps[0].id);
    expect(v.nextQuestion).toBeNull();
    expect(v.state).toBe('paused');
  });
  it('preserves contradiction adequacy when completion evidence is incomplete', () => {
    const o = output();
    o.noteAdequacy = 'CONTRADICTORY';
    o.nextQuestion = null;
    const v = assemble(input(), o);
    expect(v.noteAdequacy).toBe('CONTRADICTORY');
    expect(v.state).toBe('contradiction');
  });
  it('does not treat an honestly reported incident failing Task expectations as conflicting author reports', () => {
    const i = { ...input(), purpose: 'INCIDENT' as const },
      o = output();
    o.purpose = 'INCIDENT';
    o.noteAdequacy = 'ENOUGH_FOR_PURPOSE';
    o.gaps = [];
    o.nextQuestion = null;
    o.taskUnderstanding.requirements = [
      {
        text: 'Tác giả chỉnh sửa được.',
        sourceRefs: [
          { sourceId: 'task.step.0', quote: 'Tác giả chỉnh sửa được.' },
        ],
      },
    ];
    o.coverage = [
      {
        requirementIndex: 0,
        status: 'CONTRADICTORY',
        sourceRefs: o.claims[0].sourceRefs,
      },
    ];
    const v = assemble(i, o);
    expect(v.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
    expect(v.state).toBe('ready_to_edit');
    expect(v.allowedActions).toContain('rewrite');
    expect(
      gradeAssessment(
        scenario(),
        0,
        { ...o, noteAdequacy: 'ENOUGH_FOR_PURPOSE' },
        i,
        { state: 'contradiction', allowedActions: [] },
      ).failures,
    ).toContain('RUNTIME_REWRITE_UNAVAILABLE');
  });
  it('allows new grounded correction evidence to resolve a formerly unknown gap, without erasing the old answer', () => {
    const i = input(),
      prior = assemble(i, output());
    const unknown = {
      id: 'a',
      gapId: prior.gaps[0].id,
      target: prior.gaps[0].target,
      disposition: 'unknown' as const,
      purpose: 'COMPLETION' as const,
      taskContextHash: 'task',
    };
    const paused = assemble(
      { ...i, previous: prior, answers: [unknown] },
      output(),
    );
    const text =
      'Tôi kiểm tra local: tác giả chỉnh sửa được, người ngoài project bị từ chối.';
    const corrected = {
      ...i,
      previous: paused,
      correction: { targetId: paused.claims[0].id, text },
      answers: [
        unknown,
        {
          ...unknown,
          id: 'c',
          gapId: paused.claims[0].id,
          disposition: 'answered' as const,
          answer: text,
        },
      ],
      sources: [
        ...i.sources,
        {
          id: 'answer.c',
          kind: 'ANSWER' as const,
          label: 'Correction',
          text,
          version: '1',
          loadStatus: 'LOADED' as const,
          includedInRequest: true,
        },
      ],
    };
    const o = output();
    o.taskUnderstanding.requirements = i.sources
      .filter((s) => s.id.startsWith('task.step.'))
      .map((s) => ({
        text: s.text,
        sourceRefs: [{ sourceId: s.id, quote: s.text }],
      }));
    o.claims = [
      {
        text,
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
        sourceRefs: [{ sourceId: 'answer.c', quote: text }],
      },
    ];
    o.coverage = o.taskUnderstanding.requirements.map(
      (_, requirementIndex) => ({
        requirementIndex,
        status: 'SUPPORTED',
        sourceRefs: [{ sourceId: 'answer.c', quote: text }],
      }),
    );
    o.gaps = [];
    o.nextQuestion = null;
    o.noteAdequacy = 'ENOUGH_FOR_PURPOSE';
    const v = assemble(corrected, o);
    expect(v.gaps[0].status).toBe('answered');
    expect(v.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
    expect(v.answers[0].disposition).toBe('unknown');
    const ownerContext = {
      ...corrected,
      previous: {
        ...paused,
        gaps: paused.gaps.map((g) => ({
          ...g,
          owner: 'TASK_REQUIREMENT_OWNER' as const,
        })),
      },
    };
    expect(assemble(ownerContext, o).gaps[0].status).toBe('unknown');
    o.coverage[1].status = 'NOT_REPORTED';
    expect(assemble(corrected, o).gaps[0].status).toBe('unknown');
  });
  it('still rejects a paraphrased CSV requirement instead of repairing evidence or weakening extraction', () => {
    const i = input(),
      o = output();
    o.taskUnderstanding.requirements = [
      {
        text: 'Tác giả được sửa.',
        sourceRefs: [
          { sourceId: 'task.step.0', quote: 'Tác giả chỉnh sửa được.' },
        ],
      },
    ];
    expect(() => parseAssessmentOutput(i, JSON.stringify(o))).toThrow(
      'UNSUPPORTED_REQUIREMENT',
    );
  });
  it('recognizes a build/smoke result question as relevant without accepting unrelated questions', () => {
    const c = loadAssessmentCorpus().scenarios.find(
        (c) => c.id === 'assessment-release-claim-b',
      )!,
      o = output();
    o.claims = [];
    o.gaps = [
      {
        ...o.gaps[0],
        target: 'kết quả smoke test và build',
        sourceRefs: [
          {
            sourceId: 'task.step.0',
            quote: 'Staging nhận bản vá sau smoke test.',
          },
        ],
      },
    ];
    o.nextQuestion!.text = 'Smoke test và build đã hoàn thành với kết quả nào?';
    expect(gradeAssessment(c, 0, o).failures).not.toContain(
      'QUESTION_RELEVANCE',
    );
    o.nextQuestion!.text = 'Bạn thích màu nào?';
    o.gaps[0].target = 'màu yêu thích';
    expect(gradeAssessment(c, 0, o).failures).toContain('QUESTION_RELEVANCE');
  });
});
