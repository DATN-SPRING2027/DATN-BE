import { parseOptions, run } from '../../../../../scripts/work-note-agent/run';

describe('WorkNote evaluator command safety', () => {
  it('defaults to an offline dry run without reading credentials or calling a network', async () => {
    const network = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('must not call'));
    const output = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    try {
      expect(parseOptions([]).live).toBe(false);
      expect(await run(['--dry-run', '--split', 'all'])).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
      output.mockRestore();
    }
  });
  it('rejects unknown flags, unbounded concurrency and live batches exceeding the declared budget', async () => {
    expect(
      parseOptions(['--corpus', 'v2', '--recover-empty-containers']),
    ).toMatchObject({ corpus: 'v2', recoverEmptyContainers: true });
    expect(() => parseOptions(['--corpus', '../.env'])).toThrow();
    expect(() =>
      parseOptions(['--api-key', 'do-not-pass-credentials']),
    ).toThrow();
    expect(() => parseOptions(['--concurrency', '99'])).toThrow();
    await expect(run(['--live', '--split', 'all'])).rejects.toThrow(
      'Planned calls exceed',
    );
  });
});
