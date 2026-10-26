import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Platform rate-limit contract', () => {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, '../../docs/openapi/iam-v1.openapi.json'),
      'utf8',
    ),
  ) as {
    'x-platform-rate-limit': {
      windowSeconds: number;
      readLimit: number;
      writeLimit: number;
    };
    paths: Record<
      string,
      Record<string, { responses?: Record<string, unknown> }>
    >;
  };
  it('documents the shared read/write budgets', () => {
    expect(contract['x-platform-rate-limit']).toMatchObject({
      windowSeconds: 60,
      readLimit: 120,
      writeLimit: 20,
    });
  });
  it('documents 429 and dependency failure for every guarded operation', () => {
    for (const [path, item] of Object.entries(contract.paths)) {
      if (!path.startsWith('/api/v1/iam/platform')) continue;
      for (const operation of Object.values(item)) {
        if (!operation.responses) continue;
        expect(operation.responses['429']).toEqual({
          $ref: '#/components/responses/TooManyRequests',
        });
        expect(operation.responses['503']).toBeDefined();
      }
    }
  });
});
