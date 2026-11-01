import { recoverEmptyContainers } from './work-note-agent.formatting';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from './work-note-agent';

const source: AgentInput = {
  operation: 'grammar',
  scope: 'whole_note',
  instruction: 'Fix grammar.',
  workflow: 'TASK_NOTE',
  draft: { revision: 1, title: 'Queue', body: 'We have not tested the queue.' },
  task: null,
  clarifications: [],
  history: [],
};
const good = {
  status: 'SUGGESTION_READY',
  message: 'Proposed.',
  suggestion: {
    replacementText: 'We have not tested the queue.',
    suggestedTitle: null,
    changeSummary: ['Kept the testing limitation.'],
  },
};

describe('explicit formatting recovery, never semantic repair', () => {
  it('adds only missing empty envelope containers and records the change separately', () => {
    const recovery = recoverEmptyContainers(JSON.stringify(good));
    expect(recovery?.addedFields).toEqual(['questions', 'uncertainties']);
    expect(
      parseAgentResult(prepareAgentRequest(source), recovery!.json).status,
    ).toBe('SUGGESTION_READY');
    expect(JSON.parse(recovery!.json)).toMatchObject(good);
    expect(() =>
      parseAgentResult(prepareAgentRequest(source), JSON.stringify(good)),
    ).toThrow();
  });
  it('never fabricates a question, changes an enum, fixes invalid JSON or removes unknown fields', () => {
    for (const raw of [
      'bad json',
      JSON.stringify({
        ...good,
        status: 'CLARIFICATION_REQUIRED',
        suggestion: null,
      }),
      JSON.stringify({ ...good, status: 'SUGGESTED_READY' }),
      JSON.stringify({ ...good, unknown: true }),
      JSON.stringify({ ...good, questions: null, uncertainties: [] }),
    ])
      expect(recoverEmptyContainers(raw)).toBeNull();
  });
  it('fills missing options only for an existing single complete question', () => {
    const raw = JSON.stringify({
      status: 'CLARIFICATION_REQUIRED',
      message: 'One detail.',
      suggestion: null,
      questions: [
        {
          text: 'Which environment?',
          reason: 'Needed to identify the failure.',
        },
      ],
      uncertainties: [],
    });
    const recovery = recoverEmptyContainers(raw);
    expect(recovery?.addedFields).toEqual(['questions[0].options']);
    expect(
      parseAgentResult(prepareAgentRequest(source), recovery!.json).status,
    ).toBe('CLARIFICATION_REQUIRED');
  });
  it('does not recover an already complete result or weaken protected-content validation', () => {
    expect(
      recoverEmptyContainers(
        JSON.stringify({ ...good, questions: [], uncertainties: [] }),
      ),
    ).toBeNull();
    const prepared = prepareAgentRequest({
      ...source,
      draft: { ...source.draft, body: 'Do not change `refreshToken`.' },
    });
    const recovery = recoverEmptyContainers(JSON.stringify(good));
    expect(() => parseAgentResult(prepared, recovery!.json)).toThrow();
  });
});
