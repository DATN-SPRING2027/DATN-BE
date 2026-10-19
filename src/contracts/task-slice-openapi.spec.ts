import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ResponseContract {
  $ref?: string;
  description?: string;
  headers?: { 'Cache-Control'?: { schema: { const: string } } };
  content?: { 'application/json': { schema: { $ref: string } } };
}
interface Operation {
  description?: string;
  parameters?: { $ref?: string; name?: string }[];
  requestBody?: unknown;
  responses: Record<string, ResponseContract>;
}
interface PropertyContract {
  pattern?: string;
  maxItems?: number;
}
interface SchemaContract extends PropertyContract {
  required?: string[];
  properties?: Record<string, PropertyContract>;
  additionalProperties?: boolean;
}
interface OpenApiDocument {
  'x-approval-status': string;
  'x-decision-refs': string[];
  'x-owner-decisions': string[];
  'x-pending-decisions': string[];
  security?: Record<string, string[]>[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string }>;
    parameters: Record<
      string,
      {
        schema: {
          $ref?: string;
          minimum?: number;
          maximum?: number;
          default?: number;
        };
      }
    >;
    responses: Record<string, ResponseContract>;
    schemas: Record<string, SchemaContract>;
  };
}

describe('DATN-97 Task slice OpenAPI (proposed D05-DR1 contract)', () => {
  const document = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'docs/openapi/task-v1-d05-slice.openapi.json'),
      'utf8',
    ),
  ) as OpenApiDocument;
  const listPath = '/internal/tasks/projects/{projectId}/tasks';
  const detailPath = `${listPath}/{taskId}`;

  it('declares only list and detail GET operations under /internal/tasks', () => {
    expect(Object.keys(document.paths).sort()).toEqual(
      [listPath, detailPath].sort(),
    );
    for (const operations of Object.values(document.paths)) {
      expect(Object.keys(operations)).toEqual(['get']);
      expect(operations.get.requestBody).toBeUndefined();
    }
  });

  it('keeps deferred behavior out: no Idempotency-Key, expectedVersion, filter or sort', () => {
    const names = Object.values(document.paths).flatMap((operations) =>
      (operations.get.parameters ?? []).map((parameter) =>
        parameter.$ref ? parameter.$ref.split('/').at(-1) : parameter.name,
      ),
    );
    expect(new Set(names)).toEqual(
      new Set(['ProjectId', 'TaskId', 'Limit', 'AfterId']),
    );
  });

  it('records DR-4 as approved, keeps the OpenAPI itself pending approval and AUTH-1 deferred', () => {
    const pendingIds = document['x-pending-decisions'].map(
      (entry) => entry.split(':')[0],
    );
    expect(pendingIds.sort()).toEqual(['APPROVAL-1', 'AUTH-1']);
    expect(document['x-decision-refs'].join('\n')).toMatch(
      /DR-4[^\n]*approved[^\n]*issuecomment-6258355860/,
    );
    expect(document['x-approval-status']).toMatch(/not approved/i);
    for (const operations of Object.values(document.paths)) {
      expect(operations.get.description).toMatch(/DR-4/);
    }
  });

  it('records the five task-owner decisions and keeps DR-5 limited to non-member and cross-scope', () => {
    const ownerIds = document['x-owner-decisions']
      .map((entry) => entry.split(' ')[0])
      .filter((id) => id !== 'SOURCE:');
    expect(ownerIds).toEqual([
      'PATH-1',
      'LIMIT-1',
      'CURSOR-1',
      'ERR-1',
      'CACHE-1',
    ]);
    const errorDecision = document['x-owner-decisions'].find((entry) =>
      entry.startsWith('ERR-1'),
    );
    expect(errorDecision).toMatch(/guard returns a boolean/i);
    const notFound = document.components.responses.NotFound.description ?? '';
    expect(notFound).toMatch(/non-member and cross-scope/i);
    expect(notFound).toMatch(/task-owner decision ERR-1/);
  });

  it('requires the opaque delegated bearer credential on every operation', () => {
    expect(document.security).toEqual([{ taskDelegationBearer: [] }]);
    expect(document.components.securitySchemes.taskDelegationBearer).toEqual(
      expect.objectContaining({ type: 'http', scheme: 'bearer' }),
    );
    for (const operations of Object.values(document.paths)) {
      expect(operations.get).not.toHaveProperty('security');
    }
  });

  it('exposes exactly the seven approved Task fields with strict id formats', () => {
    const task = document.components.schemas.Task;
    const fields = [
      'id',
      'projectId',
      'title',
      'createdBy',
      'createdAt',
      'updatedAt',
      'version',
    ];
    expect(task.additionalProperties).toBe(false);
    expect([...(task.required ?? [])].sort()).toEqual([...fields].sort());
    expect(Object.keys(task.properties ?? {}).sort()).toEqual(
      [...fields].sort(),
    );
    for (const field of ['id', 'projectId', 'createdBy']) {
      expect(task.properties?.[field].pattern).toBe('^[a-f0-9]{24}$');
    }
    expect(document.components.schemas.ObjectIdString.pattern).toBe(
      '^[a-fA-F0-9]{24}$',
    );
  });

  it('bounds the cursor page size to 1-100 in the request and the response (DR-6)', () => {
    const limit = document.components.parameters.Limit.schema;
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(100);
    expect(limit.default).toBe(20);
    const page = document.components.schemas.TaskPage;
    expect(page.additionalProperties).toBe(false);
    expect([...(page.required ?? [])].sort()).toEqual(['items', 'nextAfterId']);
    expect(page.properties?.items.maxItems).toBe(100);
  });

  it('documents 422 only for the list query and 404 for non-member or malformed path ids', () => {
    expect(Object.keys(document.paths[listPath].get.responses).sort()).toEqual([
      '200',
      '401',
      '404',
      '422',
      '500',
      '503',
    ]);
    expect(
      Object.keys(document.paths[detailPath].get.responses).sort(),
    ).toEqual(['200', '401', '404', '500', '503']);
  });

  it('marks every 200 response no-store and every error as the existing BE error shape', () => {
    for (const operations of Object.values(document.paths)) {
      const responses = operations.get.responses;
      expect(responses['200'].headers?.['Cache-Control']?.schema.const).toBe(
        'no-store',
      );
      for (const [status, response] of Object.entries(responses)) {
        if (status === '200') continue;
        const resolved =
          document.components.responses[response.$ref!.split('/').at(-1)!];
        expect(resolved.content?.['application/json'].schema.$ref).toBe(
          '#/components/schemas/ErrorResponse',
        );
      }
    }
    const error = document.components.schemas.ErrorResponse;
    expect(error.additionalProperties).toBe(false);
    expect([...(error.required ?? [])].sort()).toEqual([
      'code',
      'details',
      'message',
      'requestId',
    ]);
  });
});
