import {
  type AiChatCitationDto,
  type AiChatRetrievalStepDto,
  type AiChatSseFrame,
  extractSanitizedStepsAndSessionCitations,
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
  const replyToMessageId =
    typeof payload.reply_to_message_id === 'string' &&
    payload.reply_to_message_id.trim()
      ? payload.reply_to_message_id.trim().slice(0, 128)
      : undefined;
  const regeneratedFromMessageId =
    typeof payload.regenerated_from_message_id === 'string' &&
    payload.regenerated_from_message_id.trim()
      ? payload.regenerated_from_message_id.trim().slice(0, 128)
      : undefined;

  if (eventType === 'run.cancelled') {
    return {
      event: 'failed',
      data: {
        code: 'CANCELLED',
        message: SAFE_ERROR_MESSAGES.CANCELLED,
        retryable: true,
        ...(messageId ? { messageId } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        ...(regeneratedFromMessageId ? { regeneratedFromMessageId } : {}),
      },
    };
  }

  const errorObj = isRecord(payload.error) ? payload.error : {};
  const normalizedCode =
    typeof errorObj.code === 'string' ? errorObj.code.trim().toUpperCase() : '';
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
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...(regeneratedFromMessageId ? { regeneratedFromMessageId } : {}),
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

function sanitizeStepId(raw: unknown, prefix: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96);
  return cleaned ? `${prefix}${cleaned}` : undefined;
}

function extractTurnNumber(
  parsed: Record<string, unknown>,
  payload: Record<string, unknown>,
): number | undefined {
  const raw = parsed.turn ?? payload.turn;
  if (
    typeof raw === 'number' &&
    Number.isInteger(raw) &&
    raw >= 1 &&
    Number.isSafeInteger(raw)
  ) {
    return raw;
  }
  return undefined;
}

function extractDurationMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return 0;
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
  let sawToolExecution = false;
  let fallbackToolCounter = 0;
  const collectedSteps: AiChatRetrievalStepDto[] = [];
  const startedToolLabels = new Map<string, string>();
  const activeModelTurns = new Map<number, 'thinking' | 'answer'>();

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
      if (isRecord(payload.session_context)) {
        const mode =
          typeof payload.session_context.mode === 'string'
            ? payload.session_context.mode.trim().slice(0, 32)
            : '';
        if (mode && mode !== 'off') {
          const durationMs = extractDurationMs(
            payload.session_context.ms ?? payload.session_context.duration_ms,
          );
          const cleanSessionStep: AiChatRetrievalStepDto = {
            kind: 'session_context',
            label: 'Session Memory (ECCE)',
            durationMs,
            mode,
          };
          collectedSteps.push(cleanSessionStep);
          yield {
            event: 'step',
            data: {
              id: 'session-context',
              status: 'completed',
              ...cleanSessionStep,
            },
          };
        }
      }
      return;
    }

    if (effectiveType === 'turn.started') {
      const turn = extractTurnNumber(parsed, payload);
      if (turn !== undefined) {
        const toolCount =
          typeof payload.tool_count === 'number' && payload.tool_count > 0
            ? payload.tool_count
            : 0;
        const kind: 'thinking' | 'answer' =
          turn === 1 && !sawToolExecution && toolCount > 0
            ? 'thinking'
            : 'answer';
        const label = kind === 'thinking' ? 'Reasoning' : 'Answer Synthesis';
        activeModelTurns.set(turn, kind);
        yield {
          event: 'step',
          data: {
            id: `model-turn-${turn}`,
            status: 'running',
            kind,
            label,
            durationMs: 0,
          },
        };
      }
      return;
    }

    if (effectiveType === 'message.completed') {
      const msg = isRecord(payload.message) ? payload.message : null;
      if (msg && msg.role === 'assistant') {
        const turn = extractTurnNumber(parsed, payload);
        const kind: 'thinking' | 'answer' =
          payload.has_tool_calls === true ? 'thinking' : 'answer';
        const label = kind === 'thinking' ? 'Reasoning' : 'Answer Synthesis';
        const durationMs = extractDurationMs(payload.duration_ms);
        const cleanModelStep: AiChatRetrievalStepDto = {
          kind,
          label,
          durationMs,
        };
        collectedSteps.push(cleanModelStep);
        if (turn !== undefined) {
          activeModelTurns.delete(turn);
          yield {
            event: 'step',
            data: {
              id: `model-turn-${turn}`,
              status: 'completed',
              ...cleanModelStep,
            },
          };
        } else {
          yield {
            event: 'step',
            data: {
              status: 'completed',
              ...cleanModelStep,
            },
          };
        }
      }
      return;
    }

    if (
      effectiveType === 'tool.started' ||
      effectiveType === 'tool.approval_required'
    ) {
      sawToolExecution = true;
      const explicitStepId = sanitizeStepId(payload.tool_call_id, 'tool-');
      fallbackToolCounter += 1;
      const stepId = explicitStepId ?? `tool-auto-${fallbackToolCounter}`;
      const rawLabel =
        (typeof payload.label === 'string' && payload.label.trim()) ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        'Knowledge Retrieval';
      const label = rawLabel.slice(0, 160);
      startedToolLabels.set(stepId, label);
      yield {
        event: 'step',
        data: {
          id: stepId,
          status: 'running',
          kind: 'tool',
          label,
          durationMs: 0,
        },
      };
      return;
    }

    if (effectiveType === 'tool.completed') {
      sawToolExecution = true;
      const explicitStepId = sanitizeStepId(payload.tool_call_id, 'tool-');
      const rememberedLabel = explicitStepId
        ? startedToolLabels.get(explicitStepId)
        : undefined;
      const label =
        (typeof payload.label === 'string' && payload.label.trim()) ||
        rememberedLabel ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        'Knowledge Retrieval';
      const durationMs = extractDurationMs(payload.duration_ms);
      const details = isRecord(payload.details) ? payload.details : {};
      const count =
        typeof details.count === 'number' &&
        Number.isInteger(details.count) &&
        details.count >= 0
          ? details.count
          : undefined;
      const cleanStep: AiChatRetrievalStepDto = {
        kind: 'tool',
        label: label.slice(0, 160),
        durationMs,
        ...(count !== undefined ? { count } : {}),
      };
      collectedSteps.push(cleanStep);
      yield {
        event: 'step',
        data: explicitStepId
          ? { id: explicitStepId, status: 'completed', ...cleanStep }
          : cleanStep,
      };
      return;
    }

    if (effectiveType === 'tool.failed') {
      sawToolExecution = true;
      const explicitStepId = sanitizeStepId(payload.tool_call_id, 'tool-');
      const rememberedLabel = explicitStepId
        ? startedToolLabels.get(explicitStepId)
        : undefined;
      const label =
        (typeof payload.label === 'string' && payload.label.trim()) ||
        rememberedLabel ||
        (typeof payload.name === 'string' && payload.name.trim()) ||
        'Knowledge Retrieval';
      const durationMs = extractDurationMs(payload.duration_ms);
      const failedStep: AiChatRetrievalStepDto = {
        status: 'failed',
        kind: 'tool',
        label: label.slice(0, 160),
        durationMs,
      };
      collectedSteps.push(failedStep);
      yield {
        event: 'step',
        data: explicitStepId
          ? { id: explicitStepId, ...failedStep }
          : failedStep,
      };
      return;
    }

    if (
      effectiveType === 'message.delta' &&
      payload.role === 'assistant' &&
      typeof payload.delta === 'string' &&
      payload.delta.length > 0
    ) {
      const turn = extractTurnNumber(parsed, payload);
      if (turn !== undefined && activeModelTurns.get(turn) === 'thinking') {
        activeModelTurns.set(turn, 'answer');
        yield {
          event: 'step',
          data: {
            id: `model-turn-${turn}`,
            status: 'running',
            kind: 'answer',
            label: 'Answer Synthesis',
            durationMs: 0,
          },
        };
      }
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
      const replyToMessageId =
        typeof payload.reply_to_message_id === 'string' &&
        payload.reply_to_message_id.trim()
          ? payload.reply_to_message_id.trim().slice(0, 128)
          : undefined;
      const regeneratedFromMessageId =
        typeof payload.regenerated_from_message_id === 'string' &&
        payload.regenerated_from_message_id.trim()
          ? payload.regenerated_from_message_id.trim().slice(0, 128)
          : undefined;
      const content = typeof payload.output === 'string' ? payload.output : '';
      const answerStatus =
        payload.answer_status === 'no_answer' ? 'no_answer' : 'answered';
      const citations = Array.isArray(payload.citations)
        ? payload.citations
            .map(mapSagCitation)
            .filter((item): item is AiChatCitationDto => item !== null)
        : [];
      const extracted = Array.isArray(payload.steps)
        ? extractSanitizedStepsAndSessionCitations(payload.steps)
        : null;
      yield {
        event: 'completed',
        data: {
          messageId,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(regeneratedFromMessageId ? { regeneratedFromMessageId } : {}),
          content,
          answerStatus,
          citations,
          sessionCitations: extracted ? extracted.sessionCitations : [],
          retrievalSteps:
            extracted && extracted.retrievalSteps.length > 0
              ? extracted.retrievalSteps
              : [...collectedSteps],
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
