import { parseDraftInput } from './work-note-agent-drafts.validation';
import { randomUUID } from 'node:crypto';
describe('Agent HTTP input boundary', () => {
  const base = { operationId: randomUUID(), expectedRevision: 1 };
  const message = {
    ...base,
    operation: 'grammar',
    scope: 'whole_note',
    instruction: 'Fix.',
    includeWholeNoteContext: false,
  };
  it('rejects caller authority, bad revisions and malformed selections', () => {
    for (const value of [
      { ...message, task: { title: 'Fake' } },
      { ...message, model: 'fake/model' },
      { ...message, expectedRevision: 0 },
      { ...message, scope: 'selection' },
      { ...message, selection: { start: 0, end: 1, quote: 'x' } },
      {
        ...message,
        operation: 'title',
        scope: 'selection',
        selection: { start: 0, end: 1, quote: 'x' },
      },
    ])
      expect(() => parseDraftInput('message', value)).toThrow();
  });
  it('requires a complete, exclusive question disposition', () => {
    expect(() =>
      parseDraftInput('message', { ...message, answer: 'invented' }),
    ).toThrow();
    expect(() =>
      parseDraftInput('message', {
        ...message,
        replyToQuestionId: randomUUID(),
        questionDisposition: 'skipped',
        answer: 'not allowed',
      }),
    ).toThrow();
    expect(
      parseDraftInput('message', {
        ...message,
        replyToQuestionId: randomUUID(),
        questionDisposition: 'answered',
        answer: 'Not tested.',
      }),
    ).toMatchObject({ answer: 'Not tested.' });
  });
  it('accepts freeform whitespace verbatim and validates destructive confirmation', () => {
    const value = {
      ...base,
      title: ' Note ',
      contentMarkdown: '  code\r\n  line  ',
    };
    expect(parseDraftInput('update', value)).toEqual(value);
    expect(() =>
      parseDraftInput('save', { ...base, discardOriginalConfirmed: 'true' }),
    ).toThrow();
    expect(() =>
      parseDraftInput('create', { operationId: randomUUID(), taskId: 'bad' }),
    ).toThrow();
  });
  it('accepts bounded AI Chat source references without excerpts or caller URLs', () => {
    const aiChatSource = {
      threadId: 'thread-1',
      messageId: 'message-1',
      citations: [
        {
          number: 1,
          sourceLabel: 'Architecture runbook',
          documentId: '507f1f77bcf86cd799439088',
          versionNo: 2,
          heading: 'Project boundaries',
          pageFrom: 3,
          pageTo: 4,
        },
      ],
      sessionCitations: [
        { ref: 'S1', groupId: 'group-1', turnIds: ['turn-1', 'turn-2'] },
      ],
    };
    const save = {
      ...base,
      discardOriginalConfirmed: false,
      aiChatSource,
    };
    expect(parseDraftInput('save', save)).toMatchObject(save);
    expect(() =>
      parseDraftInput('save', {
        ...save,
        aiChatSource: {
          ...aiChatSource,
          citations: [
            { ...aiChatSource.citations[0], snippet: 'private excerpt' },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      parseDraftInput('save', {
        ...save,
        aiChatSource: {
          ...aiChatSource,
          citations: [
            { ...aiChatSource.citations[0], documentId: 'foreign-document' },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      parseDraftInput('save', {
        ...save,
        aiChatSource: {
          ...aiChatSource,
          citations: Array.from({ length: 101 }, (_, index) => ({
            number: index + 1,
            sourceLabel: 'Source',
          })),
        },
      }),
    ).toThrow();
  });
});
