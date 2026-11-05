import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevelopmentResponseCache } from '../../../../../scripts/work-note-agent/assessment-response-cache';
import { runAssessmentEvaluation } from '../../../../../scripts/work-note-agent/assessment-run';

describe('Development raw-response cache', () => {
  it('does not mark a POST uncertain when the budget denied it before network access', async () => {
    const blocked = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('HTTP_ATTEMPT_BUDGET'));
    const cache = new DevelopmentResponseCache(dir, {
      artifactHash: 'a',
      phaseId: 'one',
    });
    await expect(
      cache.call(url, request(), policy, blocked, (s) => s),
    ).rejects.toThrow('BUDGET');
    const fetcher = network();
    await expect(
      cache.call(url, request(), policy, fetcher, (s) => s),
    ).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  let dir: string;
  const url = 'https://api.xkiro.com/v1/chat/completions';
  const policy = { timeoutMs: 85000, retries: 0 };
  const request = (model = 'test/model', text = 'one', user = 'opaque-1') => ({
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: text }],
      max_tokens: 8192,
      user,
    }),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assessment-cache-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const network = () =>
    jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            '{"model":"test/model","choices":[{"message":{"content":"not-json"}}]}',
          ),
        ),
      );

  it('replays even a model-format failure across local artifact changes without another HTTP call', async () => {
    const fetcher = network();
    await new DevelopmentResponseCache(dir, {
      artifactHash: 'before',
      phaseId: 'phase-one',
    }).call(url, request(), policy, fetcher, (s) => s);
    const replay = new DevelopmentResponseCache(
      dir,
      { artifactHash: 'after', phaseId: 'phase-two' },
      true,
    );
    const response = await replay.call(
      url,
      request('test/model', 'one', 'opaque-2'),
      policy,
      fetcher,
      (s) => s,
    );
    expect(await response.text()).toContain('not-json');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replay.snapshot().hits).toBe(1);
    expect(replay.lastRead?.originalArtifactHash).toBe('before');
  });
  it.each(['model', 'messages', 'timeout'])(
    'never reuses a response after %s changes',
    async (change) => {
      const fetcher = network();
      const cache = new DevelopmentResponseCache(dir, {
        artifactHash: 'a',
        phaseId: 'one',
      });
      await cache.call(url, request(), policy, fetcher, (s) => s);
      const replay = new DevelopmentResponseCache(
        dir,
        { artifactHash: 'b', phaseId: 'two' },
        true,
      );
      await expect(
        replay.call(
          url,
          request(
            change === 'model' ? 'other/model' : 'test/model',
            change === 'messages' ? 'changed' : 'one',
          ),
          change === 'timeout' ? { ...policy, timeoutMs: 90000 } : policy,
          fetcher,
          (s) => s,
        ),
      ).rejects.toThrow('CACHE_MISS');
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('blocks a second POST after an uncertain network outcome', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('lost connection'));
    const cache = new DevelopmentResponseCache(dir, {
      artifactHash: 'a',
      phaseId: 'one',
    });
    await expect(
      cache.call(url, request(), policy, fetcher, (s) => s),
    ).rejects.toThrow('lost connection');
    await expect(
      new DevelopmentResponseCache(dir, {
        artifactHash: 'b',
        phaseId: 'two',
      }).call(url, request(), policy, fetcher, (s) => s),
    ).rejects.toThrow('UNCERTAIN_POST');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not cache an HTTP 429 as a completed model response', async () => {
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 429 })),
      );
    const cache = new DevelopmentResponseCache(dir, {
      artifactHash: 'a',
      phaseId: 'one',
    });
    await cache.call(url, request(), policy, fetcher, (s) => s);
    await cache.call(url, request(), policy, fetcher, (s) => s);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('regrades cached output through the runner without credentials, HTTP or a new phase ledger', async () => {
    const args = [
      '--corpus',
      'dev-v30',
      '--batch',
      'full',
      '--split',
      'development',
      '--cases',
      'dev27-progress-2',
      '--model',
      'test/model',
      '--max-attempts',
      '1',
      '--editor-limit',
      '0',
    ];
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'test/model',
              choices: [
                { message: { content: 'not-json' }, finish_reason: 'stop' },
              ],
              usage: { total_tokens: 3 },
            }),
          ),
        ),
      );
    await runAssessmentEvaluation(['--live', ...args], {
      developmentCacheDirectory: dir,
      readCredentials: () => Promise.resolve({ apiKey: 'synthetic' }),
      fetcher,
      writeReport: false,
    });
    fetcher.mockClear();
    const readCredentials = jest.fn(() =>
      Promise.reject(new Error('must not read credentials')),
    );
    const replay = await runAssessmentEvaluation(['--cache-only', ...args], {
      developmentCacheDirectory: dir,
      readCredentials,
      fetcher,
      writeReport: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readCredentials).not.toHaveBeenCalled();
    expect(replay.mode).toBe('offline-replay');
    expect('budget' in replay && replay.budget.actualHttpAttempts).toBe(0);
    expect(replay.rows[0].responseOrigins?.[0].kind).toBe(
      'DEVELOPMENT_CACHE_REPLAY',
    );
    expect(replay.rows[0].errorCode).toBe('INVALID_JSON');
    const miss = await runAssessmentEvaluation(
      ['--cache-only', ...args, '--model', 'other/model'],
      { developmentCacheDirectory: dir, fetcher, writeReport: false },
    );
    expect(miss.rows[0].errorCode).toBe(
      'RESPONSE_CACHE_MISS_REQUIRES_LIVE_AUTHORIZATION',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('forbids cache-only replay from substituting for a release measurement', async () => {
    await expect(
      runAssessmentEvaluation(
        [
          '--cache-only',
          '--corpus',
          'release60-v6',
          '--batch',
          'release',
          '--split',
          'validation',
          '--model',
          'test/model',
        ],
        { writeReport: false },
      ),
    ).rejects.toThrow('DEVELOPMENT_CORPUS');
  });
});
