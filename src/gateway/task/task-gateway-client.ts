import { createHash } from 'node:crypto';

/** Request facts the Task-side verifier already binds to the opaque proof. */
export interface TaskGatewayRequestBinding {
  method: string;
  target: string;
  projectId: string;
  bodySha256?: string;
}

/**
 * A future trusted fixture/runtime integration must provide the proof. This
 * adapter deliberately knows no token profile, issuer, audience, key source,
 * actor header, Project authorization policy, or permission matrix.
 */
export interface TaskGatewayProofProvider {
  createProof(
    this: void,
    binding: TaskGatewayRequestBinding,
    signal: AbortSignal,
  ): string | Promise<string>;
}

export interface TaskGatewayRequest {
  method: string;
  /** Exact origin-relative HTTP target observed by the Task HTTP server. */
  target: string;
  /** Request scope to bind to the injected proof; it is not authorization. */
  projectId: string;
  /** Exact bytes/string sent as the request body. */
  body?: string | Uint8Array;
}

export interface TaskGatewayClientOptions {
  /** Explicit local/test Task endpoint. There is no environment fallback. */
  endpoint?: string;
  /** Explicit per-fixture deadline; no production deadline is selected here. */
  timeoutMs?: number;
  proofProvider?: TaskGatewayProofProvider;
  /** Explicit transport override; required for loopback HTTPS test fixtures. */
  fetch?: typeof globalThis.fetch;
}

export type TaskGatewayClientErrorCode =
  | 'CONFIGURATION_UNAVAILABLE'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_REQUEST'
  | 'PROOF_UNAVAILABLE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UPSTREAM_UNAVAILABLE';

const safeErrorMessages: Record<TaskGatewayClientErrorCode, string> = {
  CONFIGURATION_UNAVAILABLE: 'Task adapter configuration is unavailable',
  INVALID_CONFIGURATION: 'Task adapter configuration is invalid',
  INVALID_REQUEST: 'Task adapter request is invalid',
  PROOF_UNAVAILABLE: 'Task request proof is unavailable',
  TIMEOUT: 'Task request timed out',
  CANCELLED: 'Task request was cancelled',
  UPSTREAM_UNAVAILABLE: 'Task service is unavailable',
};

/** Error details are deliberately static so provider/fetch internals stay private. */
export class TaskGatewayClientError extends Error {
  constructor(readonly code: TaskGatewayClientErrorCode) {
    super(safeErrorMessages[code]);
    this.name = TaskGatewayClientError.name;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasForbiddenTargetCharacter(target: string): boolean {
  for (const character of target) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      character === '#' ||
      character === '\\'
    ) {
      return true;
    }
  }
  return false;
}

function parseLoopbackEndpoint(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (hostname === '127.0.0.1' || hostname === '::1') &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === '/' &&
      url.search.length === 0 &&
      url.hash.length === 0
    ) {
      return url;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseRequest(value: unknown):
  | {
      binding: TaskGatewayRequestBinding;
      body?: Uint8Array;
    }
  | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const method = value.method;
    const target = value.target;
    const projectId = value.projectId;
    const suppliedBody = value.body;
    if (
      typeof method !== 'string' ||
      !/^[A-Za-z]+$/.test(method) ||
      typeof target !== 'string' ||
      target.length === 0 ||
      target.length > 8_192 ||
      !target.startsWith('/') ||
      target.startsWith('//') ||
      hasForbiddenTargetCharacter(target) ||
      typeof projectId !== 'string' ||
      projectId.length === 0 ||
      projectId.length > 512 ||
      /[\r\n]/.test(projectId)
    ) {
      return undefined;
    }

    const normalizedMethod = method.toUpperCase();
    let body: Uint8Array | undefined;
    if (typeof suppliedBody === 'string') {
      body = Buffer.from(suppliedBody);
    } else if (suppliedBody instanceof Uint8Array) {
      body = new Uint8Array(suppliedBody);
    } else if (suppliedBody !== undefined) {
      return undefined;
    }
    if (
      (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && !body) ||
      ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && body)
    ) {
      return undefined;
    }

    const binding: TaskGatewayRequestBinding = {
      method: normalizedMethod,
      target,
      projectId,
      ...(body === undefined
        ? {}
        : {
            bodySha256: createHash('sha256').update(body).digest('base64url'),
          }),
    };
    return { binding, ...(body === undefined ? {} : { body }) };
  } catch {
    return undefined;
  }
}

function resolveTarget(endpoint: URL, target: string): URL | undefined {
  try {
    const resolved = new URL(target, endpoint);
    if (
      resolved.origin !== endpoint.origin ||
      `${resolved.pathname}${resolved.search}` !== target
    ) {
      return undefined;
    }
    return resolved;
  } catch {
    return undefined;
  }
}

function safeProof(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\s,]/.test(value)
  );
}

/**
 * Dormant local/test-only transport adapter. It is intentionally not a Nest
 * provider and accepts only explicit loopback HTTP(S) endpoints. HTTPS requires
 * an injected transport so certificate trust and client identity are explicit;
 * this adapter does not provide production mTLS or establish delegation trust.
 */
export class TaskGatewayClient {
  constructor(private readonly options: TaskGatewayClientOptions = {}) {}

  async request(
    requestValue: TaskGatewayRequest,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const options = this.options;
    if (
      !options.endpoint ||
      !options.proofProvider ||
      !(options.fetch ?? globalThis.fetch) ||
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs! <= 0
    ) {
      throw new TaskGatewayClientError('CONFIGURATION_UNAVAILABLE');
    }
    if (
      process.env.NODE_ENV !== 'test' &&
      process.env.NODE_ENV !== 'development'
    ) {
      throw new TaskGatewayClientError('INVALID_CONFIGURATION');
    }

    const endpoint = parseLoopbackEndpoint(options.endpoint);
    if (!endpoint) throw new TaskGatewayClientError('INVALID_CONFIGURATION');
    if (endpoint.protocol === 'https:' && !options.fetch) {
      // Do not silently use a default transport without explicit TLS
      // configuration for a local/test mutual TLS fixture.
      throw new TaskGatewayClientError('INVALID_CONFIGURATION');
    }
    const parsedRequest = parseRequest(requestValue);
    if (!parsedRequest) throw new TaskGatewayClientError('INVALID_REQUEST');
    const target = resolveTarget(endpoint, parsedRequest.binding.target);
    if (!target) throw new TaskGatewayClientError('INVALID_REQUEST');
    if (callerSignal?.aborted) throw new TaskGatewayClientError('CANCELLED');

    const controller = new AbortController();
    let abortCode: 'TIMEOUT' | 'CANCELLED' | undefined;
    const abortFromCaller = () => {
      abortCode = 'CANCELLED';
      controller.abort();
    };
    const timeout = setTimeout(() => {
      abortCode = 'TIMEOUT';
      controller.abort();
    }, options.timeoutMs);
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true });

    let rejectOnAbort!: (error: TaskGatewayClientError) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = reject;
    });
    const onAbort = () => {
      rejectOnAbort(new TaskGatewayClientError(abortCode ?? 'CANCELLED'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (callerSignal?.aborted) abortFromCaller();

    const waitForAbort = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, aborted]);

    try {
      let proof: string;
      try {
        proof = await waitForAbort(
          Promise.resolve().then(() =>
            options.proofProvider!.createProof(
              parsedRequest.binding,
              controller.signal,
            ),
          ),
        );
      } catch (error) {
        if (error instanceof TaskGatewayClientError) throw error;
        if (controller.signal.aborted) {
          throw new TaskGatewayClientError(abortCode ?? 'CANCELLED');
        }
        throw new TaskGatewayClientError('PROOF_UNAVAILABLE');
      }
      if (!safeProof(proof)) {
        throw new TaskGatewayClientError('PROOF_UNAVAILABLE');
      }

      const headers = new Headers({ authorization: `Bearer ${proof}` });
      if (parsedRequest.body !== undefined) {
        headers.set('content-type', 'application/json');
      }
      const fetchImplementation = options.fetch ?? globalThis.fetch;
      const response = await waitForAbort(
        Promise.resolve(
          fetchImplementation(target, {
            method: parsedRequest.binding.method,
            headers,
            ...(parsedRequest.body === undefined
              ? {}
              : { body: parsedRequest.body as BodyInit }),
            signal: controller.signal,
            redirect: 'manual',
          }),
        ),
      );
      const responseBody =
        response.body === null ||
        response.status === 204 ||
        response.status === 205 ||
        response.status === 304
          ? null
          : await waitForAbort(response.arrayBuffer());
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof TaskGatewayClientError) throw error;
      if (controller.signal.aborted) {
        throw new TaskGatewayClientError(abortCode ?? 'CANCELLED');
      }
      // Provider and transport exception details may contain secrets or keys.
      throw new TaskGatewayClientError('UPSTREAM_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', abortFromCaller);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
