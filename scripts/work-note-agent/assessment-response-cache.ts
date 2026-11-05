import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

type Policy = { timeoutMs: number; retries: number };
type Origin = { artifactHash: string; phaseId: string };
export type ResponseCacheRead = {
  kind: 'LIVE_HTTP' | 'DEVELOPMENT_CACHE_REPLAY' | 'PHASE_JOURNAL_REPLAY';
  requestKey?: string;
  originalArtifactHash?: string;
  originalPhaseId?: string;
};
type RecordData = {
  version: 1;
  state: 'pending' | 'retryable' | 'complete';
  requestHash: string;
  model: string;
  policy: Policy;
  origin: Origin;
  status?: number;
  body?: string;
  bodyHash?: string;
};
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const endpoint = 'https://api.xkiro.com/v1/chat/completions';
export class DevelopmentResponseCache {
  private hits = 0;
  private fetched = 0;
  lastRead?: ResponseCacheRead;
  constructor(
    private readonly directory: string,
    private readonly origin: Origin,
    private readonly replayOnly = false,
  ) {
    mkdirSync(directory, { recursive: true });
  }
  private key(requestHash: string, policy: Policy) {
    return digest(
      JSON.stringify({ version: 1, endpoint, requestHash, policy }),
    );
  }
  private write(file: string, data: RecordData) {
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(data));
    renameSync(temp, file);
  }
  snapshot() {
    return {
      hits: this.hits,
      fetched: this.fetched,
      mode: this.replayOnly
        ? 'REPLAY_ONLY_NO_NETWORK'
        : 'DEVELOPMENT_EXACT_REQUEST',
      lastRead: this.lastRead,
    };
  }
  importCompleted(
    requestHash: string,
    policy: Policy,
    body: string,
    origin: Origin,
  ) {
    if (
      !/^[a-f0-9]{64}$/u.test(requestHash) ||
      Buffer.byteLength(body) > 1_000_000
    )
      throw Error('RESPONSE_CACHE_IMPORT_INVALID');
    const response = JSON.parse(body) as { model?: string };
    if (!response.model) throw Error('RESPONSE_CACHE_IMPORT_MODEL_REQUIRED');
    const file = join(this.directory, this.key(requestHash, policy) + '.json');
    if (existsSync(file)) return false;
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        state: 'complete',
        requestHash,
        model: response.model,
        policy,
        origin,
        status: 200,
        body,
        bodyHash: digest(body),
      } satisfies RecordData),
      { flag: 'wx' },
    );
    return true;
  }
  async call(
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    policy: Policy,
    fetcher: typeof fetch,
    redact: (s: string) => string,
  ): Promise<Response> {
    const address =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (address !== endpoint || typeof init?.body !== 'string')
      throw Error('RESPONSE_CACHE_REQUEST_INVALID');
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    delete payload.user; // Only the opaque request identity is excluded.
    const requestHash = digest(JSON.stringify(payload)),
      requestKey = this.key(requestHash, policy);
    const file = join(this.directory, requestKey + '.json');
    let prior: RecordData | undefined;
    if (existsSync(file)) {
      try {
        prior = JSON.parse(readFileSync(file, 'utf8')) as RecordData;
      } catch {
        throw Error('RESPONSE_CACHE_CORRUPT');
      }
      if (
        prior.version !== 1 ||
        prior.requestHash !== requestHash ||
        prior.model !== payload.model ||
        this.key(prior.requestHash, prior.policy) !== requestKey
      )
        throw Error('RESPONSE_CACHE_IDENTITY_MISMATCH');
      if (prior.state === 'pending')
        throw Error('RESPONSE_CACHE_UNCERTAIN_POST_OUTCOME');
      if (prior.state === 'complete') {
        if (
          prior.status !== 200 ||
          typeof prior.body !== 'string' ||
          digest(prior.body) !== prior.bodyHash
        )
          throw Error('RESPONSE_CACHE_CORRUPT');
        this.hits++;
        this.lastRead = {
          kind: 'DEVELOPMENT_CACHE_REPLAY',
          requestKey,
          originalArtifactHash: prior.origin.artifactHash,
          originalPhaseId: prior.origin.phaseId,
        };
        return new Response(prior.body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (prior.state !== 'retryable') throw Error('RESPONSE_CACHE_CORRUPT');
    }
    if (this.replayOnly)
      throw Error('RESPONSE_CACHE_MISS_REQUIRES_LIVE_AUTHORIZATION');
    const pending: RecordData = {
      version: 1,
      state: 'pending',
      requestHash,
      model: String(payload.model),
      policy,
      origin: this.origin,
    };
    if (prior) {
      // Known failed responses may be resumed. The exclusive file remains the
      // marker that prevents an uncertain POST being repeated after a crash.
      const retryLock = file + '.retry-lock';
      writeFileSync(retryLock, '', { flag: 'wx' });
      try {
        const current = JSON.parse(readFileSync(file, 'utf8')) as RecordData;
        if (current.state !== 'retryable')
          throw Error('RESPONSE_CACHE_UNCERTAIN_POST_OUTCOME');
        this.write(file, pending);
      } finally {
        unlinkSync(retryLock);
      }
    } else writeFileSync(file, JSON.stringify(pending), { flag: 'wx' });
    this.fetched++;
    this.lastRead = {
      kind: 'LIVE_HTTP',
      requestKey,
      originalArtifactHash: this.origin.artifactHash,
      originalPhaseId: this.origin.phaseId,
    };
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(?:PHASE_)?(?:HTTP_ATTEMPT|TOKEN_RESERVATION)_BUDGET$/u.test(
          error.message,
        )
      )
        this.write(file, { ...pending, state: 'retryable' });
      throw error;
    }
    const raw = await response.clone().text();
    if (Buffer.byteLength(raw) > 1_000_000)
      throw Error('RESPONSE_CACHE_RESPONSE_LIMIT');
    const body = redact(raw);
    this.write(
      file,
      response.status === 200
        ? {
            ...pending,
            state: 'complete',
            status: 200,
            body,
            bodyHash: digest(body),
          }
        : { ...pending, state: 'retryable', status: response.status },
    );
    return response;
  }
}
