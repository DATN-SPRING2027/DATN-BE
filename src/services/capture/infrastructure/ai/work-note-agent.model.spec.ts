import { ConfigService } from '@nestjs/config';
import { WorkNoteAgentModel } from './work-note-agent.model';
import {
  buildAssessmentEditorInput,
  assertAssessmentEditorProposal,
} from '../../application/work-note-agent/work-note-assessment-editor';
const input = () =>
  buildAssessmentEditorInput(
    {
      revision: 1,
      title: 'Synthetic progress',
      body: 'Updated API. Not tested.',
    },
    null,
    {
      purpose: 'PROGRESS',
      noteAdequacy: 'ENOUGH_FOR_PURPOSE',
      answers: [],
      gaps: [],
    },
  );
const response = (init?: RequestInit) => {
  const request = JSON.parse(init?.body as string) as {
    messages: { content: string }[];
  };
  const payload = JSON.parse(request.messages.at(-1)!.content) as {
    source: { text: string };
  };
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              status: 'SUGGESTION_READY',
              message: 'Kept uncertainty.',
              suggestion: {
                replacementText: payload.source.text,
                suggestedTitle: null,
                changeSummary: ['Retained author facts.'],
              },
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    }),
    { status: 200 },
  );
};
describe('Assessed Editor uses the same bounded provider policy as evaluation', () => {
  afterEach(() => jest.restoreAllMocks());
  const model = () =>
    new WorkNoteAgentModel(
      new ConfigService({
        WORKNOTE_AGENT_ENABLED: true,
        XKIRO_API_KEY: 'SYNTHETIC_TEST_KEY',
        XKIRO_MODEL: 'test/model',
        WORKNOTE_AGENT_FORMATTING_RECOVERY: true,
      }),
    );
  it('sends the shared custom request, reports recovery and never auto-applies', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) => Promise.resolve(response(init)));
    const source = input();
    const completion = await model().rewrite(source, 'assessment');
    expect(() =>
      assertAssessmentEditorProposal(source, completion.result),
    ).not.toThrow();
    expect(completion.provenance.formattingRecovery).toEqual([
      'questions',
      'uncertainties',
    ]);
    expect(completion.provenance.httpAttempts).toBe(1);
    const body = JSON.parse(network.mock.calls[0][1]?.body as string) as {
      max_tokens: number;
      messages: { content: string }[];
    };
    expect(body.max_tokens).toBe(4096);
    const payload = JSON.parse(body.messages.at(-1)!.content) as {
      operation: string;
    };
    expect(payload.operation).toBe('custom');
    expect(source.draft.body).toBe('Updated API. Not tested.');
  });
  it('does not retry an assessment Editor HTTP429', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 429 }));
    await expect(model().rewrite(input(), 'assessment')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 429,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('keeps the existing standalone Editor retry behavior compatible', async () => {
    let count = 0;
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((_url, init) =>
        Promise.resolve(
          ++count === 1
            ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
            : response(init),
        ),
      );
    const completion = await model().rewrite(input());
    expect(completion.provenance.httpAttempts).toBe(2);
    expect(network).toHaveBeenCalledTimes(2);
  });
});
