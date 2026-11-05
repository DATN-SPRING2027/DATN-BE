import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssessmentHttpJournal } from '../../../../../scripts/work-note-agent/assessment-http-journal';

describe('Durable synthetic evaluation HTTP journal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'worknote-journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const url = 'https://api.xkiro.com/v1/chat/completions';
  const init = {
    body: JSON.stringify({
      model: 'test/model',
      messages: [],
      user: 'opaque-1',
    }),
  };
  it('reuses a completed response after restart without another HTTP call', async () => {
    const path = join(dir, 'journal.json');
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(new Response('{"value":"secret-test"}'));
    const redact = (s: string) => s.replace('secret-test', '[REDACTED]');
    const first = new AssessmentHttpJournal(path, 'hash');
    await first.call('case:turn:analysis', url, init, fetcher, redact);
    first.close();
    const restarted = new AssessmentHttpJournal(path, 'hash');
    const replay = await restarted.call(
      'case:turn:analysis',
      url,
      {
        body: JSON.stringify({
          model: 'test/model',
          messages: [],
          user: 'opaque-2',
        }),
      },
      fetcher,
      redact,
    );
    expect(await replay.text()).toContain('[REDACTED]');
    expect(fetcher).toHaveBeenCalledTimes(1);
    restarted.close();
    expect(() => new AssessmentHttpJournal(path, 'changed')).toThrow(
      'MANIFEST_MISMATCH',
    );
  });
  it('blocks retry of an uncertain POST after restart', async () => {
    const path = join(dir, 'journal.json');
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockRejectedValue(new Error('connection lost'));
    await expect(
      new AssessmentHttpJournal(path, 'hash').call(
        'one',
        url,
        init,
        fetcher,
        (s) => s,
      ),
    ).rejects.toThrow();
    expect(() => new AssessmentHttpJournal(path, 'hash')).toThrow(
      'UNCERTAIN_POST_OUTCOME',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not cache quota errors as permanent model results', async () => {
    const path = join(dir, 'journal.json');
    const fetcher = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockImplementation(() =>
        Promise.resolve(new Response('{}', { status: 429 })),
      );
    const first = new AssessmentHttpJournal(path, 'hash');
    await first.call('one', url, init, fetcher, (s) => s);
    first.close();
    await new AssessmentHttpJournal(path, 'hash').call(
      'one',
      url,
      init,
      fetcher,
      (s) => s,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
