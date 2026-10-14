import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('C-02 membership read response metadata', () => {
  const document = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'docs/openapi/iam-v1.openapi.json'),
      'utf8',
    ),
  ) as {
    paths: Record<
      string,
      { get: { responses: Record<string, ResponseContract> } }
    >;
    components: { responses: Record<string, ResponseContract> };
  };
  interface ResponseContract {
    $ref?: string;
    description: string;
    headers?: { 'Cache-Control'?: { schema: { const: string } } };
  }
  it.each([
    '/api/v1/iam/organizations/{organizationId}/memberships',
    '/api/v1/iam/organizations/{organizationId}/memberships/{membershipId}',
  ])('declares no-store for every response of %s', (path) => {
    for (const response of Object.values(document.paths[path].get.responses)) {
      const resolved = response.$ref
        ? document.components.responses[response.$ref.split('/').at(-1)!]
        : response;
      expect(resolved.headers?.['Cache-Control']?.schema.const).toBe(
        'no-store',
      );
    }
    expect(document.paths[path].get.responses['500'].description).not.toMatch(
      /audit|outbox|rollback|transaction/i,
    );
  });
});
