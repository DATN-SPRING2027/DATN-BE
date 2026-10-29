import { ASSESSMENT_EXAMPLES } from './work-note-assessment.prompt';
import { assembleAssessment } from './work-note-assessment.state';
import {
  buildAssessmentMessages,
  parseAssessmentOutput,
  parseAssessmentCompletion,
} from './work-note-assessment.protocol';
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
      text: 'The API has not been tested.',
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
    {
      id: 'task.title',
      kind: 'TASK',
      label: 'Task',
      text: 'Implement API.',
      version: '1',
      loadStatus: 'LOADED',
      includedInRequest: true,
    },
  ],
};
const output = (): AssessmentModelOutput => ({
  purpose: 'PROGRESS',
  taskUnderstanding: {
    objective: 'API',
    scope: 'API',
    requirements: [
      {
        text: 'Implement API.',
        sourceRefs: [{ sourceId: 'task.title', quote: 'Implement API.' }],
      },
    ],
    unknowns: [],
  },
  claims: [
    {
      text: 'The API has not been tested.',
      sourceRefs: [
        { sourceId: 'note.body', quote: 'The API has not been tested.' },
      ],
      originKind: 'AUTHOR_REPORT',
      supportRelation: 'FULL',
    },
  ],
  coverage: [{ requirementIndex: 0, status: 'NOT_REPORTED', sourceRefs: [] }],
  gaps: [],
  taskContextStatus: 'CLEAR',
  noteAdequacy: 'ENOUGH_FOR_PURPOSE',
  nextQuestion: null,
});
describe('Task assessment sourced protocol', () => {
  it('builds an isolated task-aware request without tools or write authority', () => {
    const m = buildAssessmentMessages(input);
    expect(m[0].content).toContain('TASK_REQUIREMENT');
    const payload = JSON.parse(m.at(-1)!.content) as { sources: unknown };
    expect(payload.sources).toEqual(input.sources);
  });
  it('sends the targeted prior claim with an author correction instead of an uninterpretable ID alone', () => {
    const previous = assembleAssessment(input, output(), {
      sourceRevision: 1,
      taskContextHash: 'task',
      model: 'test/model',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    });
    const messages = buildAssessmentMessages({
      ...input,
      previous,
      correction: {
        targetId: previous.claims[0].id,
        text: 'Only local API changed.',
      },
    });
    const payload = JSON.parse(messages.at(-1)!.content) as {
      previous: { correctionTarget: { id: string; text: string } };
    };
    expect(payload.previous.correctionTarget).toMatchObject({
      id: previous.claims[0].id,
      text: previous.claims[0].text,
    });
    expect(previous.claims[0].text).toBe(input.sources[0].text);
  });
  it('reports options-only recovery without inventing question content or weakening source validation', () => {
    const raw = {
      ...output(),
      gaps: [
        {
          kind: 'EVIDENCE',
          target: 'environment',
          impact: 'BLOCKING',
          owner: 'NOTE_AUTHOR',
          sourceRefs: [{ sourceId: 'note.body', quote: input.sources[0].text }],
        },
      ],
      nextQuestion: {
        gapIndex: 0,
        text: 'Which environment?',
        reason: 'The note does not specify the environment.',
      },
    };
    expect(() =>
      parseAssessmentCompletion(input, JSON.stringify(raw), false),
    ).toThrow();
    const recovered = parseAssessmentCompletion(
      input,
      JSON.stringify(raw),
      true,
    );
    expect(recovered.result.nextQuestion?.options).toEqual([]);
    expect(recovered.formattingRecovery).toEqual(['nextQuestion.options']);
    raw.gaps[0].sourceRefs[0].quote = 'Invented source text';
    expect(() =>
      parseAssessmentCompletion(input, JSON.stringify(raw), true),
    ).toThrow('INVALID_SOURCE_REFERENCE');
  });
  it('uses well-formed examples with genuine source quotes and distinct purpose decisions', () => {
    for (const e of ASSESSMENT_EXAMPLES)
      expect(() =>
        parseAssessmentOutput(e.input, JSON.stringify(e.output)),
      ).not.toThrow();
    const progress = ASSESSMENT_EXAMPLES.find(
      (e) =>
        e.input.purpose === 'PROGRESS' &&
        e.input.sources.some((s) => s.text.includes('Chưa kiểm thử')),
    )!;
    expect(progress.output.nextQuestion).toBeNull();
    expect(progress.output.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
  });
  it('binds completeness policy to the requested purpose without letting Task completion status override it', () => {
    const progress = JSON.parse(
      buildAssessmentMessages({ ...input, purpose: 'PROGRESS' }).at(-1)!
        .content,
    ) as { assessmentPolicy: { requireWholeTaskAcceptance: boolean } };
    const completion = JSON.parse(
      buildAssessmentMessages({ ...input, purpose: 'COMPLETION' }).at(-1)!
        .content,
    ) as { assessmentPolicy: { requireWholeTaskAcceptance: boolean } };
    expect(progress.assessmentPolicy.requireWholeTaskAcceptance).toBe(false);
    expect(completion.assessmentPolicy.requireWholeTaskAcceptance).toBe(true);
  });
  it('accepts extractive author evidence without declaring independent verification', () => {
    expect(
      parseAssessmentOutput(input, JSON.stringify(output())).claims[0]
        .supportRelation,
    ).toBe('FULL');
  });
  it('canonicalizes capitalization-only quotes back to the exact source passage', () => {
    const v = output();
    v.claims[0].sourceRefs[0].quote = 'the API has not been tested.';
    expect(
      parseAssessmentOutput(input, JSON.stringify(v)).claims[0].sourceRefs[0]
        .quote,
    ).toBe('The API has not been tested.');
    v.claims[0].sourceRefs[0].quote = 'The API has been tested.';
    expect(() => parseAssessmentOutput(input, JSON.stringify(v))).toThrow(
      'INVALID_SOURCE_REFERENCE',
    );
  });
  it('does not reject evidence for a genuine negative requirement solely because it contains negation', () => {
    const i = structuredClone(input);
    i.sources[1].text = 'Never retry automatically.';
    i.sources[0].text = 'Never retry automatically.';
    const v = output();
    v.taskUnderstanding.requirements[0] = {
      text: 'Never retry automatically.',
      sourceRefs: [
        { sourceId: 'task.title', quote: 'Never retry automatically.' },
      ],
    };
    v.claims[0] = {
      ...v.claims[0],
      text: 'Never retry automatically.',
      sourceRefs: [
        { sourceId: 'note.body', quote: 'Never retry automatically.' },
      ],
    };
    v.coverage[0] = {
      requirementIndex: 0,
      status: 'SUPPORTED',
      sourceRefs: [
        { sourceId: 'note.body', quote: 'Never retry automatically.' },
      ],
    };
    expect(parseAssessmentOutput(i, JSON.stringify(v)).coverage[0].status).toBe(
      'SUPPORTED',
    );
  });
  it('accepts a valid evidence excerpt inside a fully grounded author statement without losing polarity', () => {
    const i = structuredClone(input);
    i.sources[0].text = 'Author can edit; outsiders are denied.';
    i.sources[1].text = 'Author can edit.';
    const v = output();
    v.taskUnderstanding.requirements = [
      {
        text: 'Author can edit.',
        sourceRefs: [{ sourceId: 'task.title', quote: 'Author can edit.' }],
      },
    ];
    v.claims = [
      {
        text: i.sources[0].text,
        sourceRefs: [{ sourceId: 'note.body', quote: i.sources[0].text }],
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
      },
    ];
    v.coverage = [
      {
        requirementIndex: 0,
        status: 'SUPPORTED',
        sourceRefs: [{ sourceId: 'note.body', quote: 'Author can edit' }],
      },
    ];
    expect(parseAssessmentOutput(i, JSON.stringify(v)).coverage[0].status).toBe(
      'SUPPORTED',
    );
    i.sources[0].text = 'Author cannot edit; outsiders are denied.';
    v.claims[0].text = i.sources[0].text;
    v.claims[0].sourceRefs[0].quote = i.sources[0].text;
    v.coverage[0].sourceRefs[0].quote = 'edit';
    expect(parseAssessmentOutput(i, JSON.stringify(v)).coverage[0].status).toBe(
      'PARTIAL',
    );
  });
  it('rejects a genuine quote used to assert its opposite', () => {
    const v = output();
    v.claims[0].text = 'The API has been tested successfully.';
    expect(() => parseAssessmentOutput(input, JSON.stringify(v))).toThrow();
  });
  it('rejects invented citations and server-owned fields', () => {
    const v = output();
    v.claims[0].sourceRefs[0].sourceId = 'secret';
    expect(() => parseAssessmentOutput(input, JSON.stringify(v))).toThrow();
    expect(() =>
      parseAssessmentOutput(
        input,
        JSON.stringify({ ...output(), id: 'model-id' }),
      ),
    ).toThrow();
  });
  it('does not promote task requirements into author-reported results', () => {
    const v = output();
    v.claims[0].sourceRefs = [
      { sourceId: 'task.title', quote: 'Implement API.' },
    ];
    v.claims[0].text = 'Implement API.';
    expect(() => parseAssessmentOutput(input, JSON.stringify(v))).toThrow();
  });
  it('downgrades nonextractive semantic support instead of claiming a general entailment guarantee', () => {
    const v = output();
    v.claims[0].text = 'API testing is still pending.';
    expect(
      parseAssessmentOutput(input, JSON.stringify(v)).claims[0].supportRelation,
    ).toBe('PARTIAL');
  });
  it('accepts a new neutral question linked to a sourced gap, not a literal source sentence', () => {
    const v = output();
    v.noteAdequacy = 'NEEDS_AUTHOR_INPUT';
    v.gaps = [
      {
        kind: 'EVIDENCE',
        target: 'environment',
        impact: 'BLOCKING',
        owner: 'NOTE_AUTHOR',
        sourceRefs: [
          { sourceId: 'note.body', quote: 'The API has not been tested.' },
        ],
      },
    ];
    v.nextQuestion = {
      gapIndex: 0,
      text: 'Which environment is affected?',
      reason: 'The environment is not stated.',
      options: [],
    };
    expect(
      parseAssessmentOutput(input, JSON.stringify(v)).nextQuestion?.text,
    ).toContain('environment');
  });
});
