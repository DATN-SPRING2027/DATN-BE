import {
  applySuggestion,
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
} from './work-note-agent';

const input = (patch: Partial<AgentInput> = {}): AgentInput => ({
  operation: 'grammar',
  scope: 'whole_note',
  instruction: 'Sửa ngữ pháp, giữ nguyên ý.',
  workflow: 'TASK_NOTE',
  draft: { revision: 1, title: 'API refresh', body: 'Đã sửa API. Chưa test.' },
  task: { title: 'Sửa refresh', description: null, status: 'DONE', steps: [] },
  clarifications: [],
  history: [],
  ...patch,
});
const json = (
  replacementText: string,
  overrides: Record<string, unknown> = {},
) =>
  JSON.stringify({
    status: 'SUGGESTION_READY',
    message: 'Đã chỉnh câu.',
    suggestion: {
      replacementText,
      suggestedTitle: null,
      changeSummary: ['Sửa câu.'],
    },
    questions: [],
    uncertainties: [],
    ...overrides,
  });

describe('WorkNote Agent boundary (offline, no runtime registration)', () => {
  it('keeps signs and identifiers containing embedded digits inside the protected fragment', () => {
    const body = 'Chưa xác minh p95Latency với độ lệch -0.5% và +1.25ms.';
    const prepared = prepareAgentRequest(
      input({ draft: { revision: 1, title: 'Metrics', body } }),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    expect(payload.source.text).not.toContain('-');
    expect(payload.source.text).not.toContain('+');
    expect(payload.source.text).not.toContain('p95Latency');
    expect(
      parseAgentResult(prepared, json(payload.source.text)).suggestion
        ?.replacementText,
    ).toBe(body);
  });
  it('preserves numeric literals, dates, issue keys and bare technical identifiers exactly', () => {
    const body =
      'Chưa test refreshToken cho DATN-842. Tỷ lệ 0.5%, timeout 1500ms, ngày 2026-10-27, bản v2.1.0.';
    const prepared = prepareAgentRequest(
      input({ draft: { revision: 1, title: 'API', body } }),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    expect(payload.source.text).not.toContain('0.5%');
    expect(payload.source.text).not.toContain('refreshToken');
    expect(payload.source.text).not.toContain('DATN-842');
    expect(
      parseAgentResult(prepared, json(payload.source.text)).suggestion
        ?.replacementText,
    ).toBe(body);
    expect(() =>
      parseAgentResult(
        prepared,
        json(
          payload.source.text.replace(
            /__WN_PROTECTED_[A-Za-z0-9_]+?__/,
            '0,5%',
          ),
        ),
      ),
    ).toThrow();
  });
  it('rejects Markdown wrappers added around protected fragments', () => {
    const prepared = prepareAgentRequest(
      input({
        draft: { revision: 1, title: 'x', body: 'Chưa test `refreshToken`.' },
      }),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    expect(() =>
      parseAgentResult(
        prepared,
        json(
          payload.source.text.replace(
            /(__WN_PROTECTED_[A-Za-z0-9_]+?__)/,
            '`$1`',
          ),
        ),
      ),
    ).toThrow();
  });
  it('rejects a replacement larger than the draft input budget after fragment restoration', () => {
    const prepared = prepareAgentRequest(input());
    expect(() =>
      parseAgentResult(prepared, json('x'.repeat(30_001))),
    ).toThrow();
  });
  it('protects a selection inside a code fence, including when the fence is outside the selected range', () => {
    const body = 'Context\n```ts\nconst value = 1;\n```\nAfter';
    const quote = 'value = 1';
    const start = body.indexOf(quote);
    const prepared = prepareAgentRequest(
      input({
        scope: 'selection',
        draft: { revision: 1, title: 'Code', body },
        selection: { start, end: start + quote.length, quote },
      }),
    );
    expect(() => parseAgentResult(prepared, json('value = 2'))).toThrow();
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    expect(
      parseAgentResult(prepared, json(payload.source.text)).suggestion
        ?.replacementText,
    ).toBe(quote);
  });
  it('separates source data from instructions and does not send revision or user identity', () => {
    const prepared = prepareAgentRequest(input());
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      scope: 'whole_note',
      operation: 'grammar',
    });
    expect(prepared.messages[0].role).toBe('system');
    expect(prepared.messages[0].content).toContain('DONE');
    expect(prepared.messages.at(-1)!.content).not.toContain('"revision"');
  });

  it('sends only selection and bounded neighbours unless whole-note context is explicitly enabled', () => {
    const body =
      'PRIVATE START '.repeat(50) + 'Sửa câu này' + ' PRIVATE END'.repeat(50);
    const start = body.indexOf('Sửa câu này');
    const prepared = prepareAgentRequest(
      input({
        scope: 'selection',
        draft: { revision: 1, title: 'Note', body },
        selection: {
          start,
          end: start + 'Sửa câu này'.length,
          quote: 'Sửa câu này',
        },
      }),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: {
        text: string;
        before: string;
        after: string;
        wholeNote: string | null;
      };
    };
    expect(payload.source.text).toBe('Sửa câu này');
    expect(payload.source.before.length).toBeLessThanOrEqual(320);
    expect(payload.source.after.length).toBeLessThanOrEqual(320);
    expect(payload.source.wholeNote).toBeNull();
    expect(() => prepareAgentRequest(input({ scope: 'selection' }))).toThrow();
  });

  it('rejects a mismatched quote, an oversized request and a fake Task on a Project Document', () => {
    expect(() =>
      prepareAgentRequest(
        input({
          scope: 'selection',
          selection: { start: 0, end: 3, quote: 'wrong' },
        }),
      ),
    ).toThrow();
    expect(() =>
      prepareAgentRequest(
        input({ draft: { revision: 1, title: 'x', body: 'x'.repeat(30_001) } }),
      ),
    ).toThrow();
    expect(() =>
      prepareAgentRequest(input({ workflow: 'PROJECT_DOCUMENT' })),
    ).toThrow();
  });

  it('rejects malformed JSON, extra fields, wrong result branches and blank replacements', () => {
    const prepared = prepareAgentRequest(input());
    for (const raw of [
      '```json\n{}\n```',
      '{}',
      json(''),
      json('text', { sourceRevision: 1 }),
      json('text', { status: 'ANSWER' }),
    ]) {
      expect(() => parseAgentResult(prepared, raw)).toThrow();
    }
  });

  it('protects code, inline identifiers and URLs and rejects missing, duplicated or invented markers', () => {
    const body =
      'Chưa test `refreshToken`.\n```ts\nconst n = 401;\n```\nhttps://example.test/a?x=1';
    const prepared = prepareAgentRequest(
      input({ draft: { revision: 1, title: 'API', body } }),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string };
    };
    expect(payload.source.text).not.toContain('const n = 401');
    expect(
      parseAgentResult(prepared, json(payload.source.text)).suggestion
        ?.replacementText,
    ).toBe(body);
    expect(() => parseAgentResult(prepared, json('Bỏ hết code'))).toThrow();
    expect(() =>
      parseAgentResult(
        prepared,
        json(payload.source.text + payload.source.text),
      ),
    ).toThrow();
    expect(() =>
      parseAgentResult(
        prepared,
        json(payload.source.text + ' __WN_PROTECTED_FAKE_99__'),
      ),
    ).toThrow();
  });

  it('requires a single clarification without a suggestion and does not repeat resolved questions', () => {
    const prepared = prepareAgentRequest(
      input({
        clarifications: [
          {
            id: 'q1',
            question: 'Đã test staging chưa?',
            state: 'answered',
            answer: 'Chưa test.',
          },
        ],
      }),
    );
    const raw = JSON.stringify({
      status: 'CLARIFICATION_REQUIRED',
      message: 'Cần làm rõ.',
      suggestion: null,
      questions: [
        { text: 'Đã test staging chưa?', reason: 'Cần biết.', options: [] },
      ],
      uncertainties: [],
    });
    expect(() => parseAgentResult(prepared, raw)).toThrow();
    const valid = raw.replace(
      'Đã test staging chưa?',
      'Timeout xuất hiện ở bước nào?',
    );
    expect(parseAgentResult(prepared, valid).status).toBe(
      'CLARIFICATION_REQUIRED',
    );
  });

  it('binds a result to the exact snapshot; Apply changes only a draft and refuses stale revisions', () => {
    const original = input();
    const prepared = prepareAgentRequest(original);
    const result = parseAgentResult(
      prepared,
      json('Đã sửa API. Chưa kiểm thử.'),
    );
    const applied = applySuggestion(original.draft, result.suggestion!);
    expect(applied).toEqual({
      revision: 2,
      title: original.draft.title,
      body: 'Đã sửa API. Chưa kiểm thử.',
    });
    expect(original.draft.body).toBe('Đã sửa API. Chưa test.');
    expect(() =>
      applySuggestion({ ...original.draft, revision: 2 }, result.suggestion!),
    ).toThrow();
    expect(() =>
      applySuggestion(
        { ...original.draft, body: 'Changed while waiting' },
        result.suggestion!,
      ),
    ).toThrow();
  });

  it('replaces exactly the selected occurrence, preserves emoji/CRLF, and keeps a proposed title opt-in', () => {
    const body = '🙂 same\r\nsame\r\nend';
    const start = body.lastIndexOf('same');
    const original = input({
      scope: 'selection',
      draft: { revision: 4, title: 'Old', body },
      selection: { start, end: start + 4, quote: 'same' },
    });
    const result = parseAgentResult(prepareAgentRequest(original), json('new'));
    expect(applySuggestion(original.draft, result.suggestion!).body).toBe(
      '🙂 same\r\nnew\r\nend',
    );
    expect(() =>
      parseAgentResult(
        prepareAgentRequest(original),
        json('new').replace('"suggestedTitle":null', '"suggestedTitle":"New"'),
      ),
    ).toThrow();
    const full = input();
    const titleResult = parseAgentResult(
      prepareAgentRequest(full),
      json('Nội dung.', {
        suggestion: {
          replacementText: 'Nội dung.',
          suggestedTitle: 'New title',
          changeSummary: ['Sửa.'],
        },
      }),
    );
    expect(applySuggestion(full.draft, titleResult.suggestion!).title).toBe(
      full.draft.title,
    );
    expect(
      applySuggestion(full.draft, titleResult.suggestion!, true).title,
    ).toBe('New title');
  });

  it('supports title-only suggestions without replacing the body', () => {
    const original = input({ operation: 'title' });
    const result = parseAgentResult(
      prepareAgentRequest(original),
      json('unused', {
        suggestion: {
          replacementText: null,
          suggestedTitle: 'Khắc phục API refresh',
          changeSummary: ['Gợi ý tiêu đề.'],
        },
      }),
    );
    expect(
      applySuggestion(original.draft, result.suggestion!, true),
    ).toMatchObject({
      title: 'Khắc phục API refresh',
      body: original.draft.body,
    });
  });

  it('allows whole-note custom chat/assistance on an empty draft body while still rejecting text-rewrite tools on empty drafts', () => {
    const emptyCustom = input({
      operation: 'custom',
      scope: 'whole_note',
      instruction: 'Task này cần lưu ý những mục gì khi viết ghi chú?',
      draft: { revision: 1, title: '', body: '' },
    });
    const prepared = prepareAgentRequest(emptyCustom);
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string; title: string };
    };
    expect(payload.source).toMatchObject({ text: '', title: '' });

    const answerResult = parseAgentResult(
      prepared,
      JSON.stringify({
        status: 'ANSWER',
        message: 'Bạn nên nêu tiến độ API refresh và trạng thái kiểm thử.',
        suggestion: null,
        questions: [],
        uncertainties: [],
      }),
    );
    expect(answerResult.status).toBe('ANSWER');

    for (const op of [
      'grammar',
      'clarify',
      'shorten',
      'restructure',
      'tone',
      'handover',
    ] as const) {
      expect(() =>
        prepareAgentRequest(
          input({
            operation: op,
            scope: 'whole_note',
            draft: { revision: 1, title: '', body: '   ' },
          }),
        ),
      ).toThrow();
    }
  });
});
