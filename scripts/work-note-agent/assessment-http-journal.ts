import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

type Entry = {
  hash: string;
  state: 'pending' | 'retryable' | 'complete';
  status?: number;
  body?: string;
  headers?: [string, string][];
};
/** Synthetic evaluation transport journal. Unknown POST outcomes fail closed. */
export class AssessmentHttpJournal {
  lastReadKind: 'FETCH' | 'PHASE_REPLAY' = 'FETCH';
  private data: { identity: string; entries: Record<string, Entry> };
  private lock: number | undefined;
  constructor(
    private readonly path: string,
    identity: string,
  ) {
    this.data = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as typeof this.data)
      : { identity, entries: {} };
    if (this.data.identity !== identity)
      throw Error('HTTP_JOURNAL_MANIFEST_MISMATCH');
    if (Object.values(this.data.entries).some((e) => e.state === 'pending'))
      throw Error('HTTP_JOURNAL_UNCERTAIN_POST_OUTCOME');
    mkdirSync(dirname(path), { recursive: true });
    const lockPath = path + '.lock';
    if (existsSync(lockPath)) {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        pid: number;
      };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
        throw Error('HTTP_JOURNAL_LOCK_INVALID');
      try {
        process.kill(owner.pid, 0);
        throw Error('HTTP_JOURNAL_BUSY');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        unlinkSync(lockPath);
      }
    }
    this.lock = openSync(lockPath, 'wx');
    writeFileSync(this.lock, JSON.stringify({ pid: process.pid }));
  }
  close() {
    if (this.lock !== undefined) {
      closeSync(this.lock);
      this.lock = undefined;
      unlinkSync(this.path + '.lock');
    }
  }
  private save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
  async call(
    slot: string,
    url: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
    fetcher: typeof fetch,
    redact: (s: string) => string,
  ): Promise<Response> {
    if (typeof init?.body !== 'string')
      throw Error('HTTP_JOURNAL_BODY_REQUIRED');
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    delete payload.user; // The opaque provider request ID has no semantic content.
    const hash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    const prior = this.data.entries[slot];
    if (prior && prior.hash !== hash) throw Error('HTTP_JOURNAL_REQUEST_DRIFT');
    if (prior?.state === 'pending')
      throw Error('HTTP_JOURNAL_UNCERTAIN_POST_OUTCOME');
    if (prior?.state === 'complete') {
      this.lastReadKind = 'PHASE_REPLAY';
      return new Response(
        [204, 205, 304].includes(prior.status!) ? null : prior.body,
        {
          status: prior.status,
          headers: prior.headers,
        },
      );
    }
    this.data.entries[slot] = { hash, state: 'pending' };
    this.save();
    // Leave pending if the process dies or the POST outcome is unknown. Never
    // silently repeat such a request or pick a different model response.
    this.lastReadKind = 'FETCH';
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (error) {
      if (
        error instanceof Error &&
        /^(?:PHASE_)?(?:HTTP_ATTEMPT|TOKEN_RESERVATION)_BUDGET$/u.test(
          error.message,
        )
      ) {
        this.data.entries[slot] = { hash, state: 'retryable' };
        this.save();
      }
      throw error;
    }
    const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
    const body = await response.clone().text();
    if (Buffer.byteLength(body) > 1_000_000)
      throw Error('HTTP_JOURNAL_RESPONSE_LIMIT');
    this.data.entries[slot] = retryable
      ? { hash, state: 'retryable' }
      : {
          hash,
          state: 'complete',
          status: response.status,
          body: redact(body),
          headers: [
            [
              'content-type',
              response.headers.get('content-type') ?? 'application/json',
            ],
          ],
        };
    this.save();
    return response;
  }
}
