import { transformSagSseStream } from './ai-chat-sse.parser';
import { type AiChatSseFrame, mapSagMessage } from './ai-chat.types';

function streamFromByteChunks(
  chunks: Uint8Array[],
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk) {
        controller.enqueue(chunk);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

describe('transformSagSseStream', () => {
  it('reassembles split multi-byte Vietnamese UTF-8 chunks, strips prompt_preview/tool internals, and emits whitelisted events', async () => {
    const encoder = new TextEncoder();
    const rawSse =
      'event: run.started\r\n' +
      'data: {"run_id":"run-1","payload":{"user_message_id":"msg-u1","tools":["search_context"]}}\r\n\r\n' +
      'event: tool.completed\r\n' +
      'data: {"turn":1,"payload":{"name":"search_context","label":"Tìm kiếm kho tri thức","duration_ms":142,"arguments":{"secret_sql":"SELECT *"},"details":{"count":3}}}\r\n\r\n' +
      'event: message.delta\r\n' +
      'data: {"payload":{"role":"assistant","delta":"Kiến trúc hệ thống tuân thủ chuẩn bảo mật [1, S1]."}}\r\n\r\n' +
      'event: run.completed\r\n' +
      'data: ' +
      JSON.stringify({
        payload: {
          message_id: 'msg-a1',
          output: 'Kiến trúc hệ thống tuân thủ chuẩn bảo mật [1, S1].',
          answer_status: 'answered',
          prompt_preview: 'SYSTEM SECRET PROMPT DO NOT LEAK',
          citations: [
            {
              n: 1,
              source_id: 'src-1',
              source_name: 'Architecture Docs',
              document_id: 'doc-1',
              document_name: 'SAG Spec v2.4',
              version_no: 2,
              heading: 'Zero Trust BFF',
              snippet: 'All browser calls pass through BFF.',
              page_from: 3,
              page_to: 4,
              mapped: true,
              claim_level: 'claim',
              internal_secret: 'never-forward',
            },
          ],
        },
      }) +
      '\r\n\r\n';

    const fullBytes = encoder.encode(rawSse);
    const byteChunks: Uint8Array[] = [];
    for (let offset = 0; offset < fullBytes.length; offset += 11) {
      byteChunks.push(fullBytes.subarray(offset, offset + 11));
    }

    const collected: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks(byteChunks),
      { threadId: 'thread-1' },
    )) {
      collected.push(frame);
    }

    expect(collected).toEqual([
      {
        event: 'started',
        data: {
          runId: 'run-1',
          threadId: 'thread-1',
          userMessageId: 'msg-u1',
        },
      },
      {
        event: 'step',
        data: {
          kind: 'tool',
          label: 'Tìm kiếm kho tri thức',
          durationMs: 142,
          count: 3,
        },
      },
      {
        event: 'delta',
        data: {
          text: 'Kiến trúc hệ thống tuân thủ chuẩn bảo mật [1, S1].',
        },
      },
      {
        event: 'completed',
        data: {
          messageId: 'msg-a1',
          content: 'Kiến trúc hệ thống tuân thủ chuẩn bảo mật [1, S1].',
          answerStatus: 'answered',
          citations: [
            {
              number: 1,
              sourceId: 'src-1',
              sourceName: 'Architecture Docs',
              documentId: 'doc-1',
              documentName: 'SAG Spec v2.4',
              versionNo: 2,
              heading: 'Zero Trust BFF',
              snippet: 'All browser calls pass through BFF.',
              label: 'SAG Spec v2.4 · Zero Trust BFF',
              pageFrom: 3,
              pageTo: 4,
              mapped: true,
              claimLevel: 'claim',
            },
          ],
          sessionCitations: [],
          retrievalSteps: [
            {
              kind: 'tool',
              label: 'Tìm kiếm kho tri thức',
              durationMs: 142,
              count: 3,
            },
          ],
        },
      },
    ]);

    const serialized = JSON.stringify(collected);
    expect(serialized).not.toContain('SYSTEM SECRET PROMPT');
    expect(serialized).not.toContain('secret_sql');
    expect(serialized).not.toContain('never-forward');
  });

  it('emits at most one terminal failed event with sanitized message and synthesizes STREAM_INTERRUPTED on unexpected EOF', async () => {
    const encoder = new TextEncoder();
    const truncated = encoder.encode(
      'event: message.delta\ndata: {"payload":{"role":"assistant","delta":"Partial"}}\n\n',
    );
    const truncatedFrames: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks([truncated]),
      { threadId: 't1' },
    )) {
      truncatedFrames.push(frame);
    }
    expect(truncatedFrames).toEqual([
      { event: 'delta', data: { text: 'Partial' } },
      {
        event: 'failed',
        data: {
          code: 'STREAM_INTERRUPTED',
          message: 'AI response stream ended unexpectedly. Please try again.',
          retryable: true,
        },
      },
    ]);

    const duplicateFailure = encoder.encode(
      'event: run.failed\n' +
        'data: {"payload":{"message_id":"m-err","error":{"code":"LLM_TIMEOUT","message":"Traceback (most recent call last): internal key=sk-12345","retryable":true}}}\n\n' +
        'event: run.failed\n' +
        'data: {"payload":{"error":{"code":"SECOND","message":"second","retryable":false}}}\n\n',
    );
    const failedFrames: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks([duplicateFailure]),
      { threadId: 't1' },
    )) {
      failedFrames.push(frame);
    }
    expect(failedFrames).toHaveLength(1);
    expect(failedFrames[0]).toEqual({
      event: 'failed',
      data: {
        code: 'LLM_TIMEOUT',
        message: 'AI generation timed out. Please try again.',
        retryable: true,
        messageId: 'm-err',
      },
    });
    expect(JSON.stringify(failedFrames)).not.toContain('sk-12345');
  });

  it('normalizes lowercase search_unavailable failure code from SAG and maps whitelisted errorCode on persisted failed messages', async () => {
    const encoder = new TextEncoder();
    const searchOutage = encoder.encode(
      'event: run.failed\n' +
        'data: {"payload":{"message_id":"m-search-err","error":{"code":"search_unavailable","message":"Qdrant connection refused at 127.0.0.1:6333","retryable":true}}}\n\n',
    );
    const frames: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks([searchOutage]),
      { threadId: 't-search' },
    )) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      {
        event: 'failed',
        data: {
          code: 'SEARCH_UNAVAILABLE',
          message:
            'Knowledge search index is temporarily unavailable. Please try again.',
          retryable: true,
          messageId: 'm-search-err',
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain('6333');

    const persistedFailed = mapSagMessage({
      id: 'm-search-err',
      role: 'assistant',
      content: '',
      status: 'failed',
      error: {
        code: 'search_unavailable',
        message: 'Qdrant internal error',
      },
      citations: [],
      steps: [],
      created_at: '2026-10-30T07:00:00Z',
    });
    expect(persistedFailed?.errorCode).toBe('SEARCH_UNAVAILABLE');
  });

  it('streams real-time execution trace steps (session_context, thinking, tool running->completed, answer synthesis) and extracts sessionCitations on completion', async () => {
    const encoder = new TextEncoder();
    const rawSse =
      'event: run.started\n' +
      'data: {"run_id":"run-live-1","payload":{"user_message_id":"msg-u2","session_context":{"mode":"on","ms":42}}}\n\n' +
      'event: turn.started\n' +
      'data: {"turn":1,"payload":{"message_count":2,"tool_count":1}}\n\n' +
      'event: message.completed\n' +
      'data: {"turn":1,"payload":{"message":{"role":"assistant","content":"PRIVATE_COT"},"duration_ms":210,"has_tool_calls":true}}\n\n' +
      'event: tool.started\n' +
      'data: {"turn":1,"payload":{"tool_call_id":"call-99","name":"search_context","label":"Tìm trong kho tri thức","arguments":{"query":"secret internal query"}}}\n\n' +
      'event: tool.completed\n' +
      'data: {"turn":1,"payload":{"tool_call_id":"call-99","name":"search_context","duration_ms":640,"details":{"count":5}}}\n\n' +
      'event: turn.started\n' +
      'data: {"turn":2,"payload":{"message_count":4,"tool_count":1}}\n\n' +
      'event: message.completed\n' +
      'data: {"turn":2,"payload":{"message":{"role":"assistant","content":"Final [1] [S1]."},"duration_ms":1180,"has_tool_calls":false}}\n\n' +
      'event: message.delta\n' +
      'data: {"turn":2,"payload":{"role":"assistant","delta":"Final [1] [S1]."}}\n\n' +
      'event: run.completed\n' +
      'data: ' +
      JSON.stringify({
        payload: {
          message_id: 'msg-a2',
          reply_to_message_id: 'msg-u2',
          output: 'Final [1] [S1].',
          answer_status: 'answered',
          citations: [],
          steps: [
            {
              kind: 'session_context',
              mode: 'on',
              ms: 42,
              audit: { selected_groups: [{ citation_tag: 'S1' }] },
              session_citations: [
                {
                  ref: 'S1',
                  source: 'selected_group',
                  group_id: 'grp-1',
                  turn_ids: ['msg-prev-1'],
                  summary_excerpt: 'Prior sprint handover agreement.',
                  mapped: true,
                  claim_level: 'claim',
                },
              ],
            },
            { kind: 'thinking', step: 1, ms: 210 },
            {
              kind: 'tool',
              step: 1,
              name: 'search_context',
              label: 'Tìm trong kho tri thức',
              ms: 640,
              count: 5,
            },
            { kind: 'answer', step: 2, ms: 1180 },
          ],
        },
      }) +
      '\n\n';

    const frames: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks([encoder.encode(rawSse)]),
      { threadId: 'thread-live' },
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        event: 'started',
        data: {
          runId: 'run-live-1',
          threadId: 'thread-live',
          userMessageId: 'msg-u2',
        },
      },
      {
        event: 'step',
        data: {
          id: 'session-context',
          status: 'completed',
          kind: 'session_context',
          label: 'Session Memory (ECCE)',
          durationMs: 42,
          mode: 'on',
        },
      },
      {
        event: 'step',
        data: {
          id: 'model-turn-1',
          status: 'running',
          kind: 'thinking',
          label: 'Reasoning',
          durationMs: 0,
        },
      },
      {
        event: 'step',
        data: {
          id: 'model-turn-1',
          status: 'completed',
          kind: 'thinking',
          label: 'Reasoning',
          durationMs: 210,
        },
      },
      {
        event: 'step',
        data: {
          id: 'tool-call-99',
          status: 'running',
          kind: 'tool',
          label: 'Tìm trong kho tri thức',
          durationMs: 0,
        },
      },
      {
        event: 'step',
        data: {
          id: 'tool-call-99',
          status: 'completed',
          kind: 'tool',
          label: 'Tìm trong kho tri thức',
          durationMs: 640,
          count: 5,
        },
      },
      {
        event: 'step',
        data: {
          id: 'model-turn-2',
          status: 'running',
          kind: 'answer',
          label: 'Answer Synthesis',
          durationMs: 0,
        },
      },
      {
        event: 'step',
        data: {
          id: 'model-turn-2',
          status: 'completed',
          kind: 'answer',
          label: 'Answer Synthesis',
          durationMs: 1180,
        },
      },
      {
        event: 'delta',
        data: { text: 'Final [1] [S1].' },
      },
      {
        event: 'completed',
        data: {
          messageId: 'msg-a2',
          replyToMessageId: 'msg-u2',
          content: 'Final [1] [S1].',
          answerStatus: 'answered',
          citations: [],
          sessionCitations: [
            {
              ref: 'S1',
              source: 'selected_group',
              groupId: 'grp-1',
              turnIds: ['msg-prev-1'],
              summaryExcerpt: 'Prior sprint handover agreement.',
              mapped: true,
              claimLevel: 'claim',
            },
          ],
          retrievalSteps: [
            {
              kind: 'session_context',
              label: 'Session Memory (ECCE)',
              durationMs: 42,
              mode: 'on',
            },
            {
              kind: 'thinking',
              label: 'Reasoning',
              durationMs: 210,
            },
            {
              kind: 'tool',
              label: 'Tìm trong kho tri thức',
              durationMs: 640,
              count: 5,
            },
            {
              kind: 'answer',
              label: 'Answer Synthesis',
              durationMs: 1180,
            },
          ],
        },
      },
    ]);

    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain('PRIVATE_COT');
    expect(serialized).not.toContain('secret internal query');
  });

  it('marks failed tool steps with status failed while stripping internal tool error messages', async () => {
    const encoder = new TextEncoder();
    const rawSse =
      'event: tool.started\n' +
      'data: {"turn":1,"payload":{"tool_call_id":"call-err","name":"get_entity","label":"Tra cứu thực thể"}}\n\n' +
      'event: tool.failed\n' +
      'data: {"turn":1,"payload":{"tool_call_id":"call-err","name":"get_entity","duration_ms":65,"error":{"message":"Postgres DSN postgres://admin:secret@10.0.0.5"}}}\n\n' +
      'event: run.completed\n' +
      'data: {"payload":{"message_id":"msg-a3","output":"Fallback","answer_status":"no_answer","citations":[]}}\n\n';

    const frames: AiChatSseFrame[] = [];
    for await (const frame of transformSagSseStream(
      streamFromByteChunks([encoder.encode(rawSse)]),
      { threadId: 'thread-err' },
    )) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        event: 'step',
        data: {
          id: 'tool-call-err',
          status: 'running',
          kind: 'tool',
          label: 'Tra cứu thực thể',
          durationMs: 0,
        },
      },
      {
        event: 'step',
        data: {
          id: 'tool-call-err',
          status: 'failed',
          kind: 'tool',
          label: 'Tra cứu thực thể',
          durationMs: 65,
        },
      },
      {
        event: 'completed',
        data: {
          messageId: 'msg-a3',
          content: 'Fallback',
          answerStatus: 'no_answer',
          citations: [],
          sessionCitations: [],
          retrievalSteps: [
            {
              status: 'failed',
              kind: 'tool',
              label: 'Tra cứu thực thể',
              durationMs: 65,
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(frames)).not.toContain('10.0.0.5');
    expect(JSON.stringify(frames)).not.toContain('admin:secret');

    const persistedWithFailedTool = mapSagMessage({
      id: 'msg-a3',
      role: 'assistant',
      content: 'Fallback',
      status: 'ok',
      citations: [],
      steps: [
        {
          kind: 'tool',
          step: 1,
          name: 'get_entity',
          label: 'Tra cứu thực thể',
          ms: 65,
          error: 'Postgres DSN postgres://admin:secret@10.0.0.5',
        },
      ],
      created_at: '2026-10-30T08:00:00Z',
    });
    expect(persistedWithFailedTool?.retrievalSteps).toEqual([
      {
        status: 'failed',
        kind: 'tool',
        label: 'Tra cứu thực thể',
        durationMs: 65,
      },
    ]);
    expect(JSON.stringify(persistedWithFailedTool)).not.toContain(
      'admin:secret',
    );
  });
});
