import { assembleAssessment } from './work-note-assessment.state';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
} from './work-note-assessment.types';
const input: AssessmentModelInput = {
  purpose: 'PROGRESS',
  previous: null,
  answers: [],
  sources: [
    {
      id: 'note.body',
      kind: 'NOTE',
      label: 'Note',
      text: 'Updated the form.',
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
  ],
};
const out: AssessmentModelOutput = {
  purpose: 'PROGRESS',
  taskUnderstanding: {
    objective: 'Form',
    scope: 'UI',
    requirements: [],
    unknowns: [],
  },
  claims: [
    {
      text: 'Updated the form.',
      sourceRefs: [{ sourceId: 'note.body', quote: 'Updated the form.' }],
      originKind: 'AUTHOR_REPORT',
      supportRelation: 'FULL',
    },
  ],
  coverage: [],
  gaps: [
    {
      kind: 'EVIDENCE',
      target: 'environment',
      impact: 'BLOCKING',
      owner: 'NOTE_AUTHOR',
      sourceRefs: [{ sourceId: 'note.body', quote: 'Updated the form.' }],
    },
  ],
  taskContextStatus: 'INSUFFICIENT',
  noteAdequacy: 'NEEDS_AUTHOR_INPUT',
  nextQuestion: {
    gapIndex: 0,
    text: 'Which environment?',
    reason: 'Environment is missing.',
    options: [],
  },
};
const assemble = (patch: Partial<AssessmentModelInput> = {}, value = out) =>
  assembleAssessment({ ...input, ...patch }, value, {
    sourceRevision: 1,
    taskContextHash: 'task',
    model: 'test/model',
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });
describe('Code-driven assessment states', () => {
  it('keeps separate test criteria distinct even when they share one source', () => {
    const prior = assemble(
      {},
      {
        ...out,
        gaps: [
          {
            ...out.gaps[0],
            target: 'authentication tests',
            sourceRefs: [
              { sourceId: 'note.body', quote: 'Authentication tests' },
            ],
          },
        ],
      },
    );
    const next = assemble(
      {
        previous: prior,
        answers: [
          {
            id: 'a',
            gapId: prior.gaps[0].id,
            target: prior.gaps[0].target,
            disposition: 'unknown',
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
      },
      {
        ...out,
        gaps: [
          {
            ...out.gaps[0],
            target: 'billing tests',
            sourceRefs: [{ sourceId: 'note.body', quote: 'Billing tests' }],
          },
        ],
      },
    );
    expect(next.gaps[0].id).not.toBe(prior.gaps[0].id);
    expect(next.gaps[0].status).toBe('open');
    expect(next.nextQuestion).not.toBeNull();
  });
  it('matches environment paraphrases with the same quote anchor while distinguishing quote anchors', () => {
    const prior = assemble();
    const next = assemble(
      {},
      {
        ...out,
        gaps: [{ ...out.gaps[0], target: 'Môi trường đã dùng để kiểm thử' }],
      },
    );
    expect(next.gaps[0].id).toBe(prior.gaps[0].id);
    const differentAnchor = assemble(
      {},
      {
        ...out,
        gaps: [
          {
            ...out.gaps[0],
            sourceRefs: [{ sourceId: 'note.body', quote: 'Another form.' }],
          },
        ],
      },
    );
    expect(differentAnchor.gaps[0].id).not.toBe(prior.gaps[0].id);
  });
  it.each(['ok', 'tôi ăn trưa rồi'])(
    'does not count vague or off-topic grounded claims as progress: %s',
    (text) => {
      const prior = assemble();
      prior.counters.noProgress = 1;
      const next = assemble(
        {
          previous: prior,
          sources: [
            ...input.sources,
            {
              id: 'answer.a',
              kind: 'ANSWER',
              label: 'Answer',
              text,
              version: '1',
              loadStatus: 'LOADED',
              includedInRequest: true,
            },
          ],
          answers: [
            {
              id: 'a',
              gapId: prior.gaps[0].id,
              target: prior.gaps[0].target,
              answer: text,
              disposition: 'answered',
              purpose: 'PROGRESS',
              taskContextHash: 'task',
            },
          ],
        },
        {
          ...out,
          claims: [
            ...out.claims,
            {
              text,
              sourceRefs: [{ sourceId: 'answer.a', quote: text }],
              originKind: 'AUTHOR_REPORT',
              supportRelation: 'FULL',
            },
          ],
          gaps: [],
          nextQuestion: null,
          noteAdequacy: 'ENOUGH_FOR_PURPOSE',
        },
      );
      expect(next.counters.noProgress).toBe(2);
      expect(next.state).toBe('paused');
      expect(next.noteAdequacy).not.toBe('ENOUGH_FOR_PURPOSE');
    },
  );
  it('does not treat coverage changes without new grounded relevant author input as progress', () => {
    const value: AssessmentModelOutput = {
      ...out,
      taskUnderstanding: {
        ...out.taskUnderstanding,
        requirements: [
          { text: 'Updated the form.', sourceRefs: out.claims[0].sourceRefs },
        ],
      },
      coverage: [
        {
          requirementIndex: 0,
          status: 'SUPPORTED',
          sourceRefs: out.claims[0].sourceRefs,
        },
      ],
    };
    const prior = assemble({}, value);
    prior.counters.noProgress = 1;
    for (const status of ['PARTIAL', 'SUPPORTED'] as const) {
      const next = assemble(
        { previous: prior },
        { ...value, coverage: [{ ...value.coverage[0], status }] },
      );
      expect(next.counters.noProgress).toBe(2);
    }
  });
  it('counts grounded relevant coverage improvement once, not repeated claims or coverage oscillation', () => {
    const value: AssessmentModelOutput = {
      ...out,
      taskUnderstanding: {
        objective: 'Authentication',
        scope: 'Authentication retry',
        requirements: [
          {
            text: 'Authentication retry tests',
            sourceRefs: [
              {
                sourceId: 'task.requirement',
                quote: 'Authentication retry tests',
              },
            ],
          },
        ],
        unknowns: [],
      },
      gaps: [{ ...out.gaps[0], target: 'Authentication retry tests' }],
      coverage: [{ requirementIndex: 0, status: 'PARTIAL', sourceRefs: [] }],
    };
    const prior = assemble({}, value);
    prior.counters.noProgress = 1;
    const answer = {
      id: 'a',
      gapId: prior.gaps[0].id,
      target: prior.gaps[0].target,
      answer: 'Authentication retry passed twelve tests.',
      disposition: 'answered' as const,
      purpose: 'PROGRESS' as const,
      taskContextHash: 'task',
    };
    const replySource = {
      id: 'answer.a',
      kind: 'ANSWER' as const,
      label: 'Answer',
      text: answer.answer,
      version: '1',
      loadStatus: 'LOADED' as const,
      includedInRequest: true,
    };
    const supported = {
      ...value,
      coverage: [
        {
          requirementIndex: 0,
          status: 'SUPPORTED' as const,
          sourceRefs: [{ sourceId: replySource.id, quote: answer.answer }],
        },
      ],
    };
    const next = assemble(
      {
        previous: prior,
        answers: [answer],
        sources: [...input.sources, replySource],
      },
      supported,
    );
    expect(next.counters.noProgress).toBe(0);
    const regressed = assemble(
      {
        previous: next,
        answers: [answer],
        sources: [...input.sources, replySource],
      },
      value,
    );
    expect(regressed.counters.noProgress).toBe(1);
    const oscillated = assemble(
      {
        previous: regressed,
        answers: [answer],
        sources: [...input.sources, replySource],
      },
      supported,
    );
    expect(oscillated.counters.noProgress).toBe(2);
    const anotherAnswer = {
      ...answer,
      id: 'b',
      answer: 'Authentication retry also exercised network recovery.',
    };
    const anotherSource = {
      ...replySource,
      id: 'answer.b',
      text: anotherAnswer.answer,
    };
    const oscillatedWithNewInput = assemble(
      {
        previous: regressed,
        answers: [answer, anotherAnswer],
        sources: [...input.sources, replySource, anotherSource],
      },
      {
        ...supported,
        coverage: [
          {
            ...supported.coverage[0],
            sourceRefs: [
              { sourceId: anotherSource.id, quote: anotherAnswer.answer },
            ],
          },
        ],
      },
    );
    expect(oscillatedWithNewInput.counters.noProgress).toBe(2);
  });
  it('caps the third automatic question and pauses before a fourth can be emitted', () => {
    const prior = assemble();
    prior.counters.questionCount = 3;
    const next = assemble({ previous: prior });
    expect(next.state).toBe('paused');
    expect(next.nextQuestion).toBeNull();
    expect(next.trace.at(-1)?.reasonCode).toBe('QUESTION_LIMIT');
  });
  it('pauses after two no-progress turns without claiming adequacy', () => {
    const prior = assemble();
    prior.counters.noProgress = 1;
    const next = assemble({ previous: prior });
    expect(next.state).toBe('paused');
    expect(next.noteAdequacy).not.toBe('ENOUGH_FOR_PURPOSE');
  });
  it('keeps unknown gaps unresolved and suppresses their paraphrased questions', () => {
    const prior = assemble();
    const next = assemble(
      {
        previous: prior,
        answers: [
          {
            id: 'answer',
            gapId: prior.gaps[0].id,
            target: 'environment',
            disposition: 'unknown',
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
      },
      {
        ...out,
        nextQuestion: { ...out.nextQuestion!, text: 'Where did you try it?' },
      },
    );
    expect(next.gaps[0].status).toBe('unknown');
    expect(next.nextQuestion).toBeNull();
    expect(next.noteAdequacy).not.toBe('ENOUGH_FOR_PURPOSE');
  });
  it('counts a newly grounded targeted author correction as progress rather than an off-topic reply', () => {
    const prior = assemble(
      {},
      { ...out, gaps: [], nextQuestion: null, noteAdequacy: 'UNDETERMINED' },
    );
    prior.counters.noProgress = 1;
    const text = 'The form uses the API staging environment.';
    const corrected = assemble(
      {
        previous: prior,
        correction: { targetId: prior.claims[0].id, text },
        answers: [
          {
            id: 'correction',
            gapId: prior.claims[0].id,
            target: 'author correction',
            disposition: 'answered',
            answer: text,
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
        sources: [
          ...input.sources,
          {
            id: 'answer.correction',
            kind: 'ANSWER',
            label: 'Author correction',
            text,
            version: '1',
            loadStatus: 'LOADED',
            includedInRequest: true,
          },
        ],
      },
      {
        ...out,
        claims: [
          {
            text,
            sourceRefs: [{ sourceId: 'answer.correction', quote: text }],
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
          },
        ],
        gaps: [],
        nextQuestion: null,
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      },
    );
    expect(corrected.counters.noProgress).toBe(0);
    expect(corrected.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
  });
  it('keeps author validation distinct from independent semantic review and Save', () => {
    const next = assemble();
    expect(next.signals).toEqual({
      saved: false,
      proposalApplied: false,
      authorValidated: false,
      reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    });
  });
  it('transitions to ready_to_edit when the 3rd answer makes the note ENOUGH_FOR_PURPOSE instead of trapping in paused', () => {
    const prior = assemble();
    prior.counters.questionCount = 3;
    const answerText = 'Tested on staging environment with author account.';
    const next = assemble(
      {
        previous: prior,
        sources: [
          ...input.sources,
          {
            id: 'answer.a3',
            kind: 'ANSWER',
            label: 'Answer 3',
            text: answerText,
            version: '1',
            loadStatus: 'LOADED',
            includedInRequest: true,
          },
        ],
        answers: [
          {
            id: 'a3',
            gapId: prior.gaps[0].id,
            target: prior.gaps[0].target,
            disposition: 'answered',
            answer: answerText,
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
      },
      {
        ...out,
        taskContextStatus: 'CLEAR',
        claims: [
          ...out.claims,
          {
            text: answerText,
            sourceRefs: [{ sourceId: 'answer.a3', quote: answerText }],
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
          },
        ],
        gaps: [],
        nextQuestion: null,
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      },
    );
    expect(next.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
    expect(next.state).toBe('ready_to_edit');
    expect(next.allowedActions).toContain('rewrite');
  });
  it('downgrades inconsistent ENOUGH_FOR_PURPOSE + BLOCKING gap output to UNDETERMINED with manual edit and no bogus question', () => {
    const inconsistent = assemble(
      {},
      {
        ...out,
        taskContextStatus: 'CLEAR',
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      },
    );
    expect(inconsistent.noteAdequacy).toBe('UNDETERMINED');
    expect(inconsistent.nextQuestion).toBeNull();
    expect(inconsistent.state).toBe('missing_context');
    expect(inconsistent.allowedActions).toContain('rewrite');
  });
  it('never asks a question tied to an OPTIONAL gap', () => {
    const optionalQuestion = assemble(
      {},
      {
        ...out,
        taskContextStatus: 'CLEAR',
        gaps: [{ ...out.gaps[0], impact: 'OPTIONAL' }],
        noteAdequacy: 'NEEDS_AUTHOR_INPUT',
      },
    );
    expect(optionalQuestion.nextQuestion).toBeNull();
    expect(optionalQuestion.state).toBe('missing_context');
  });
  it('suppresses re-asking an unknown/skipped needCode even when re-anchored from note.body to a Task step', () => {
    const baseSources = [
      ...input.sources,
      {
        id: 'task.step.0',
        kind: 'TASK' as const,
        label: 'Step 1',
        text: 'Tác giả chỉnh sửa được.',
        version: '1',
        loadStatus: 'LOADED' as const,
        includedInRequest: true,
      },
    ];
    const prior = assemble(
      { sources: baseSources },
      {
        ...out,
        gaps: [
          {
            kind: 'EVIDENCE',
            target: 'actor đã dùng để kiểm tra quyền',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [{ sourceId: 'note.body', quote: 'Updated the form.' }],
          },
        ],
      },
    );
    const next = assemble(
      {
        sources: baseSources,
        previous: prior,
        answers: [
          {
            id: 'a1',
            gapId: prior.gaps[0].id,
            target: prior.gaps[0].target,
            disposition: 'unknown',
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
      },
      {
        ...out,
        gaps: [
          {
            kind: 'RESULT',
            target: 'kết quả kiểm tra cho tác giả chỉnh sửa',
            impact: 'BLOCKING',
            owner: 'NOTE_AUTHOR',
            sourceRefs: [
              { sourceId: 'task.step.0', quote: 'Tác giả chỉnh sửa được.' },
            ],
          },
        ],
      },
    );
    expect(next.gaps[0].status).toBe('unknown');
    expect(next.nextQuestion).toBeNull();
  });
  it('allows a grounded correction to resolve a prior unknown gap on non-COMPLETION purposes', () => {
    const prior = assemble();
    const unknownAnswer = {
      id: 'u1',
      gapId: prior.gaps[0].id,
      target: prior.gaps[0].target,
      disposition: 'unknown' as const,
      purpose: 'PROGRESS' as const,
      taskContextHash: 'task',
    };
    const paused = assemble({ previous: prior, answers: [unknownAnswer] }, out);
    const correctionText = 'Tested the form update on local dev environment.';
    const corrected = assemble(
      {
        previous: paused,
        correction: { targetId: paused.claims[0].id, text: correctionText },
        answers: [
          unknownAnswer,
          {
            id: 'c1',
            gapId: paused.claims[0].id,
            target: 'author correction',
            disposition: 'answered',
            answer: correctionText,
            purpose: 'PROGRESS',
            taskContextHash: 'task',
          },
        ],
        sources: [
          ...input.sources,
          {
            id: 'answer.c1',
            kind: 'ANSWER',
            label: 'Author correction',
            text: correctionText,
            version: '1',
            loadStatus: 'LOADED',
            includedInRequest: true,
          },
        ],
      },
      {
        ...out,
        taskContextStatus: 'CLEAR',
        claims: [
          {
            text: correctionText,
            sourceRefs: [{ sourceId: 'answer.c1', quote: correctionText }],
            originKind: 'AUTHOR_REPORT',
            supportRelation: 'FULL',
          },
        ],
        gaps: [],
        nextQuestion: null,
        noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      },
    );
    expect(corrected.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
    expect(corrected.state).toBe('ready_to_edit');
  });
});
