import {
  type AiChatCitationDto,
  type AiChatRetrievalStepDto,
  type AiChatSseFrame,
  mapSagCitation,
} from './ai-chat.types';

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  SEARCH_UNAVAILABLE:
    'Knowledge search index is temporarily unavailable. Please try again.',
  LLM_TIMEOUT: 'AI generation timed out. Please try again.',
  LLM_RATE_LIMIT: 'AI model is temporarily busy. Please retry in a moment.',
  LLM_UNAVAILABLE: 'AI model is currently unavailable.',
  CONFIGURATION_ERROR: 'AI Chat model is not configured on the engine.',
  STREAM_ERROR: 'AI response stream encountered an error. Please try again.',
  CANCELLED: 'Generation was stopped.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeFailureEvent(
  eventType: string,
  payload: Record<string, unknown>,
): Extract<AiChatSseFrame, { event: 'failed' }> {
  const messageId =
    typeof payload.message_id === 'string' && payload.message_id.trim()
      ? payload.message_id.trim().slice(0, 128)
      : undefined;

  if (eventType === 'run.cancelled') {
    return {
      event: 'failed',
      data: {
        code: 'CANCELLED',
        message: SAFE_ERROR_MESSAGES.CANCELLED,
        retryable: true,
        ...(messageId ? { messageId } : {}),
      },
    };
  }

  const errorObj = isRecord(payload.error) ? payload.error : {};
  const normalizedCode =
    typeof errorObj.code === 'string'
      ? errorObj.code.trim().toUpperCase()
      : '';
  const rawCode = /^[A-Z0-9_]{2,64}$/.test(normalizedCode)
    ? normalizedCode
    : 'STREAM_ERROR';
  const retryable =
    typeof errorObj.retryable === 'boolean' ? errorObj.retryable : true;
  const message =
    SAFE_ERROR_MESSAGES[rawCode] ??
    'Unable to complete the AI response. Please try again.';

  return {
    event: 'failed',
    data: {
      code: rawCode,
      message,
      retryable,
      ...(messageId ? { messageId } : {}),
    },
  };
}

function parseRawSseFrame(
  rawBlock: string,
): { eventName: string; dataText: string } | null {
  const lines = rawBlock.split('\n');
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) {
      continue;
    }
    const colonIdx = rawLine.indexOf(':');
    const field = colonIdx === -1 ? rawLine : rawLine.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : rawLine.slice(colonIdx + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'event') {
      eventName = value.trim() || 'message';
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return null;
  }
  return {
    eventName,
    dataText: dataLines.join('\n'),
  };
}

export async function* transformSagSseStream(
  stream: ReadableStream<Uint8Array>,
  context: Readonly<{ threadId: string; signal?: AbortSignal }>,
): AsyncGenerator<AiChatSseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let pendingCarriageReturn = false;
  let terminalEmitted = false;
  const collectedSteps: AiChatRetrievalStepDto[] = [];

  function normalizeChunk(decoded: string): string {
    let text = decoded;
    if (pendingCarriageReturn) {
      pendingCarriageReturn = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
      }
    }
    if (text.endsWith('\r')) {
      pendingCarriageReturn = true;
      text = `${text.slice(0, -1)}\n`;
    }
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function* processFrame(
    eventName: string,
    dataText: string,
  ): Generator<AiChatSseFrame> {
    if (terminalEmitted) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const effectiveType =
      typeof parsed.type === 'string' && parsed.type.trim()
        ? parsed.type.trim()
        : eventName;
    const payload = isRecord(parsed.payload) ? parsed.payload : parsed;

    if (effectiveType === 'run.started') {
      const runId =
        typeof parsed.run_id === 'string' && parsed.run_id.trim()
          ? parsed.run_id.trim().slice(0, 128)
          : '';
      const userMessageId =
        typeof payload.user_message_id === 'string' &&
        payload.user_message_id.trim()
          ? payload.user_message_id.trim().slice(0, 128)
          : undefined;
      yield {
        event: 'started',
        data: {
          runId,
          threadId: context.threadId,
          ...(userMessageId ? { userMessageId } : {}),
        },
      };
      return;
    }

    if (effectiveType === 'tool.completed') {
      const label =
        (typeof payload.label === 'string' && payload.label.trim()) ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        'Knowledge Retrieval';
      const durationMs =
        typeof payload.duration_ms === 'number' &&
        Number.isFinite(payload.duration_ms) &&
        payload.duration_ms >= 0
          ? Math.round(payload.duration_ms)
          : 0;
      const details = isRecord(payload.details) ? payload.details : {};
      const count =
        typeof details.count === 'number' &&
        Number.isInteger(details.count) &&
        details.count >= 0
          ? details.count
          : undefined;
      const step: AiChatRetrievalStepDto = {
        kind: 'tool',
        label: label.slice(0, 160),
        durationMs,
        ...(count !== undefined ? { count } : {}),
      };
      collectedSteps.push(step);
      yield { event: 'step', data: step };
      return;
    }

    if (
      effectiveType === 'message.delta' &&
      payload.role === 'assistant' &&
      typeof payload.delta === 'string' &&
      payload.delta.length > 0
    ) {
      yield {
        event: 'delta',
        data: { text: payload.delta },
      };
      return;
    }

    if (effectiveType === 'run.completed') {
      terminalEmitted = true;
      const messageId =
        typeof payload.message_id === 'string' && payload.message_id.trim()
          ? payload.message_id.trim().slice(0, 128)
          : '';
      const content = typeof payload.output === 'string' ? payload.output : '';
      const answerStatus =
        payload.answer_status === 'no_answer' ? 'no_answer' : 'answered';
      const citations = Array.isArray(payload.citations)
        ? payload.citations
            .map(mapSagCitation)
            .filter((item): item is AiChatCitationDto => item !== null)
        : [];
      yield {
        event: 'completed',
        data: {
          messageId,
          content,
          answerStatus,
          citations,
          sessionCitations: [],
          retrievalSteps: [...collectedSteps],
        },
      };
      return;
    }

    if (effectiveType === 'run.failed' || effectiveType === 'run.cancelled') {
      terminalEmitted = true;
      yield sanitizeFailureEvent(effectiveType, payload);
    }
  }

  try {
    while (true) {
      if (context.signal?.aborted) {
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        buffer += normalizeChunk(decoder.decode(value, { stream: true }));
        let boundaryIdx = buffer.indexOf('\n\n');
        while (boundaryIdx !== -1) {
          const rawBlock = buffer.slice(0, boundaryIdx);
          buffer = buffer.slice(boundaryIdx + 2);
          const parsedFrame = parseRawSseFrame(rawBlock);
          if (parsedFrame) {
            for (const out of processFrame(
              parsedFrame.eventName,
              parsedFrame.dataText,
            )) {
              yield out;
            }
          }
          boundaryIdx = buffer.indexOf('\n\n');
        }
      }
    }

    const tail = normalizeChunk(decoder.decode());
    if (tail) {
      buffer += tail;
    }
    const trimmedRemaining = buffer.trim();
    if (trimmedRemaining && !terminalEmitted) {
      const parsedFrame = parseRawSseFrame(trimmedRemaining);
      if (parsedFrame) {
        for (const out of processFrame(
          parsedFrame.eventName,
          parsedFrame.dataText,
        )) {
          yield out;
        }
      }
    }

    if (!terminalEmitted && !context.signal?.aborted) {
      terminalEmitted = true;
      yield {
        event: 'failed',
        data: {
          code: 'STREAM_INTERRUPTED',
          message: 'AI response stream ended unexpectedly. Please try again.',
          retryable: true,
        },
      };
    }
  } catch {
    if (!terminalEmitted && !context.signal?.aborted) {
      terminalEmitted = true;
      yield {
        event: 'failed',
        data: {
          code: 'STREAM_INTERRUPTED',
          message: 'AI response stream ended unexpectedly. Please try again.',
          retryable: true,
        },
      };
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
