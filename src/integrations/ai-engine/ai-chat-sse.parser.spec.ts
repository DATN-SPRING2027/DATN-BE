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
});
