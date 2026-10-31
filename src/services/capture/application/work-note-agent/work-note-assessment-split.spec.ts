import { ASSESSMENT_EXAMPLES } from './work-note-assessment.prompt';
import {
  buildTaskAssessorMessages,
  buildTaskInterpreterMessages,
  parseTaskAssessorCompletion,
  parseTaskAssessorOutput,
  parseTaskInterpreterOutput,
  type TaskAssessorOutput,
  type TaskInterpreterOutput,
} from './work-note-assessment-split';
import type { AssessmentModelInput } from './work-note-assessment.types';

describe('Split Task Interpreter + Assessor / Questioner architecture', () => {
  const sample = () => structuredClone(ASSESSMENT_EXAMPLES[1]);

  it('exposes only TASK sources to the Task Interpreter and never leaks note or answer text', () => {
    const ex = sample();
    const input: AssessmentModelInput = {
      ...ex.input,
      sources: [
        ...ex.input.sources,
        {
          id: 'answer.a1',
          kind: 'ANSWER',
          label: 'Clarification',
          text: 'Bí mật câu trả lời không gửi cho Interpreter.',
          version: '1',
          loadStatus: 'LOADED',
          includedInRequest: true,
        },
      ],
    };
    const messages = buildTaskInterpreterMessages(input);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('note.body');
    expect(serialized).not.toContain(
      'Bí mật câu trả lời không gửi cho Interpreter.',
    );
    const lastPayload = JSON.parse(messages.at(-1)!.content) as {
      taskSources: { id: string; kind: string }[];
    };
    expect(lastPayload.taskSources.every((s) => s.kind === 'TASK')).toBe(true);
  });

  it('validates Task Interpreter output strictly against TASK quotes and blocks Assessor fields', () => {
    const ex = sample();
    const valid: TaskInterpreterOutput = {
      taskContextStatus: ex.output.taskContextStatus,
      taskUnderstanding: ex.output.taskUnderstanding,
    };
    expect(parseTaskInterpreterOutput(ex.input, JSON.stringify(valid))).toEqual(
      valid,
    );

    // Reject note.body citation in Task Interpreter
    const badNoteRef = structuredClone(valid);
    badNoteRef.taskUnderstanding.requirements[0] = {
      text: ex.input.sources.find((s) => s.id === 'note.body')!.text,
      sourceRefs: [
        {
          sourceId: 'note.body',
          quote: ex.input.sources.find((s) => s.id === 'note.body')!.text,
        },
      ],
    };
    expect(() =>
      parseTaskInterpreterOutput(ex.input, JSON.stringify(badNoteRef)),
    ).toThrow('INVALID_REQUIREMENT_SOURCE');

    // Reject task.status citation
    const badStatusRef = structuredClone(valid);
    badStatusRef.taskUnderstanding.requirements[0] = {
      text: 'IN_PROGRESS',
      sourceRefs: [{ sourceId: 'task.status', quote: 'IN_PROGRESS' }],
    };
    expect(() =>
      parseTaskInterpreterOutput(ex.input, JSON.stringify(badStatusRef)),
    ).toThrow('INVALID_REQUIREMENT_SOURCE');

    // Reject Assessor fields inside Task Interpreter output
    expect(() =>
      parseTaskInterpreterOutput(
        ex.input,
        JSON.stringify({ ...valid, noteAdequacy: 'ENOUGH_FOR_PURPOSE' }),
      ),
    ).toThrow();
  });

  it('projects and validates every multi-step few-shot example cleanly across Interpreter and Assessor', () => {
    for (const ex of ASSESSMENT_EXAMPLES) {
      const interpreted = parseTaskInterpreterOutput(
        ex.input,
        JSON.stringify({
          taskContextStatus: ex.output.taskContextStatus,
          taskUnderstanding: ex.output.taskUnderstanding,
        }),
      );
      const messages = buildTaskAssessorMessages(ex.input, interpreted);
      expect(messages.length).toBeGreaterThanOrEqual(3);
      const assessorRaw: TaskAssessorOutput = {
        purpose: ex.output.purpose,
        claims: ex.output.claims,
        coverage: ex.output.coverage,
        gaps: ex.output.gaps,
        noteAdequacy: ex.output.noteAdequacy,
        nextQuestion: ex.output.nextQuestion,
      };
      const merged = parseTaskAssessorOutput(
        ex.input,
        interpreted,
        JSON.stringify(assessorRaw),
      );
      expect(merged).toEqual(ex.output);
    }
  });

  it('prevents Assessor from overriding Task Understanding and recovers missing options only when enabled', () => {
    const ex = structuredClone(
      ASSESSMENT_EXAMPLES.find((e) => e.output.nextQuestion !== null)!,
    );
    const interpreted: TaskInterpreterOutput = {
      taskContextStatus: ex.output.taskContextStatus,
      taskUnderstanding: ex.output.taskUnderstanding,
    };
    const assessorRaw: TaskAssessorOutput = {
      purpose: ex.output.purpose,
      claims: ex.output.claims,
      coverage: ex.output.coverage,
      gaps: ex.output.gaps,
      noteAdequacy: ex.output.noteAdequacy,
      nextQuestion: ex.output.nextQuestion,
    };
    expect(() =>
      parseTaskAssessorOutput(
        ex.input,
        interpreted,
        JSON.stringify({
          ...assessorRaw,
          taskContextStatus: 'INSUFFICIENT',
        }),
      ),
    ).toThrow();

    const withoutOptions = {
      ...assessorRaw,
      nextQuestion: {
        gapIndex: assessorRaw.nextQuestion!.gapIndex,
        text: assessorRaw.nextQuestion!.text,
        reason: assessorRaw.nextQuestion!.reason,
      },
    };
    expect(() =>
      parseTaskAssessorCompletion(
        ex.input,
        interpreted,
        JSON.stringify(withoutOptions),
        false,
      ),
    ).toThrow();
    const recovered = parseTaskAssessorCompletion(
      ex.input,
      interpreted,
      JSON.stringify(withoutOptions),
      true,
    );
    expect(recovered.formattingRecovery).toEqual(['nextQuestion.options']);
    expect(recovered.result.nextQuestion?.options).toEqual([]);
  });
});
