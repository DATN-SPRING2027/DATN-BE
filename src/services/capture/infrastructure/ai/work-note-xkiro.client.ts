import type { AgentMessage } from '../../application/work-note-agent/work-note-agent.types';

export type XkiroConfig = Readonly<{
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  retries?: number;
  jsonMode?: boolean;
  reasoningEffort?: string;
  temperature?: number;
}>;
export type XkiroCompletion = Readonly<{
  content: string;
  responseId: string | null;
  requestedModel: string;
  reportedModel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  elapsedMs: number;
  attempts: number;
}>;
export class XkiroError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONFIG'
      | 'HTTP_ERROR'
      | 'NETWORK_ERROR'
      | 'TIMEOUT'
      | 'TRUNCATED'
      | 'INVALID_RESPONSE',
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'XkiroError';
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
const label = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= 200 ? value : null;

/** Explicit experimental client. Not registered in CaptureModule or exposed as a business API. */
export class WorkNoteXkiroClient {
  #apiKey: string;
  private readonly config: Omit<XkiroConfig, 'apiKey'>;
  constructor(
    config: XkiroConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (
      !config.apiKey?.trim() ||
      /[\r\n]/.test(config.apiKey) ||
      !/^[\w.-]+\/[\w.:-]+$/.test(config.model) ||
      !Number.isSafeInteger(config.maxTokens) ||
      config.maxTokens < 128 ||
      config.maxTokens > 16_384 ||
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 100 ||
      config.timeoutMs > 90_000 ||
      (config.retries !== undefined &&
        (!Number.isInteger(config.retries) ||
          config.retries < 0 ||
          config.retries > 2)) ||
      (config.temperature !== undefined &&
        (!Number.isFinite(config.temperature) ||
          config.temperature < 0 ||
          config.temperature > 2))
    ) {
      throw new XkiroError(
        'INVALID_CONFIG',
        'Invalid xKiro client configuration.',
      );
    }
    const { apiKey, ...safeConfig } = config;
    this.#apiKey = apiKey.trim();
    this.config = safeConfig;
  }

  async complete(
    messages: readonly AgentMessage[],
    evaluationId: string,
  ): Promise<XkiroCompletion> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(evaluationId))
      throw new XkiroError(
        'INVALID_CONFIG',
        'Use an opaque evaluation identity.',
      );
    const payload = JSON.stringify({
      model: this.config.model,
      messages,
      stream: false,
      max_tokens: this.config.maxTokens,
      user: evaluationId,
      ...(this.config.jsonMode
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...(this.config.reasoningEffort
        ? { reasoning_effort: this.config.reasoningEffort }
        : {}),
      ...(this.config.temperature !== undefined && !this.config.reasoningEffort
        ? { temperature: this.config.temperature }
        : {}),
    });
    const started = Date.now();
    const deadline = started + this.config.timeoutMs;
    const maxAttempts = (this.config.retries ?? 1) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new XkiroError(
          'TIMEOUT',
          'xKiro request failed before a complete response.',
        );
      let response: Response;
      const signal = AbortSignal.timeout(remaining);
      try {
        response = await this.fetcher(
          'https://api.xkiro.com/v1/chat/completions',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: payload,
            signal,
            redirect: 'error',
          },
        );
      } catch (error) {
        // A dropped POST may already have reached the provider. Do not blindly retry ambiguous network errors.
        throw new XkiroError(
          signal.aborted || record(error).name === 'TimeoutError'
            ? 'TIMEOUT'
            : 'NETWORK_ERROR',
          'xKiro request failed before a complete response.',
        );
      }
      if (!response.ok) {
        const retryable = [429, 500, 502, 503].includes(response.status);
        await response.body?.cancel().catch(() => undefined);
        if (retryable && attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const delay =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 2_000)
              : 100 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
          if (Date.now() + delay >= deadline)
            throw new XkiroError(
              'HTTP_ERROR',
              'xKiro returned a non-success response.',
              response.status,
            );
          await this.sleep(delay);
          continue;
        }
        throw new XkiroError(
          'HTTP_ERROR',
          'xKiro returned a non-success response.',
          response.status,
        );
      }
      let raw: unknown;
      try {
        const reader = response.body?.getReader();
        if (!reader) throw new Error('empty');
        let bytes = 0;
        let text = '';
        const decoder = new TextDecoder();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 512_000) {
            await reader.cancel();
            throw new Error('oversized');
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        raw = JSON.parse(text);
      } catch {
        throw new XkiroError(
          signal.aborted ? 'TIMEOUT' : 'INVALID_RESPONSE',
          'xKiro returned an incomplete or invalid response.',
        );
      }
      const envelope = record(raw);
      const choices: unknown[] = Array.isArray(envelope.choices)
        ? envelope.choices
        : [];
      const choice = record(choices[0]);
      if (choice.finish_reason === 'length')
        throw new XkiroError(
          'TRUNCATED',
          'xKiro output reached the token budget; it cannot be applied.',
        );
      const message = record(choice.message);
      if (
        choice.finish_reason !== 'stop' ||
        typeof message.content !== 'string' ||
        !message.content.trim() ||
        message.content.length > 100_000 ||
        choices.length !== 1
      )
        throw new XkiroError(
          'INVALID_RESPONSE',
          'xKiro returned an unexpected response shape or finish reason.',
        );
      const usage = record(envelope.usage);
      return {
        content: message.content,
        responseId: label(envelope.id),
        requestedModel: this.config.model,
        reportedModel: label(envelope.model),
        promptTokens: count(usage.prompt_tokens),
        completionTokens: count(usage.completion_tokens),
        totalTokens: count(usage.total_tokens),
        elapsedMs: Date.now() - started,
        attempts: attempt,
      };
    }
    throw new XkiroError(
      'NETWORK_ERROR',
      'xKiro request failed before a complete response.',
    );
  }
}
