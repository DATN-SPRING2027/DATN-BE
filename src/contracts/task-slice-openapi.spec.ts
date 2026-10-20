import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface ResponseContract {
  $ref?: string;
  description?: string;
  headers?: Partial<
    Record<'Cache-Control' | 'WWW-Authenticate', { schema: { const: string } }>
  >;
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
  description?: string;
}
interface SchemaContract extends PropertyContract {
  required?: string[];
  properties?: Record<string, PropertyContract>;
  additionalProperties?: boolean;
}
interface OpenApiDocument {
  'x-approval-status': string;
  'x-approval-conditions': string[];
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

function collectReferences(value: unknown, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.add(item);
      else collectReferences(item, found);
    }
  }
  return found;
}

function resolveReference(document: unknown, reference: string): unknown {
  return reference
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (current, segment) =>
        typeof current === 'object' && current !== null
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      document,
    );
}

describe('DATN-97 Task slice OpenAPI (approved D05-DR1 list/detail contract)', () => {
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

  it('records the Leader approval for list and detail only and keeps AUTH-1 deferred', () => {
    const pendingIds = document['x-pending-decisions'].map(
      (entry) => entry.split(':')[0],
    );
    expect(pendingIds).toEqual(['AUTH-1']);
    const refs = document['x-decision-refs'].join('\n');
    expect(refs).toMatch(/DR-4[^\n]*approved[^\n]*issuecomment-6258355860/);
    expect(refs).toMatch(/OpenAPI approval[^\n]*issuecomment-6263376181/);
    expect(document['x-approval-status']).toMatch(
      /^APPROVED for the list and detail operations/,
    );
    expect(document['x-approval-status']).toMatch(
      /Create, DR-3, DR-7\(c\)\(d\), DR-8 and AUTH-1 are not approved/,
    );
    for (const operations of Object.values(document.paths)) {
      expect(operations.get.description).toMatch(/DR-4/);
    }
  });

  it('keeps the approval conditions that limit what may be built', () => {
    const conditions = document['x-approval-conditions'].join('\n');
    for (const required of [
      /Reviewed revision:[^\n]*issuecomment-6263376181/,
      /only to the list and detail APIs/,
      /DR-4 stays as approved[^\n]*ACTIVE[^\n]*no Events/,
      /DR-3, DR-7\(c\)\(d\) and DR-8 stay DEFER/,
      /AUTH-1 is not approved/,
      /No route activation, production use or policy ALLOW/,
      /create API is not part of this approved OpenAPI/,
      /must not answer a generic 403/,
    ]) {
      expect(conditions).toMatch(required);
    }
    expect(document['x-approval-conditions']).toHaveLength(8);
  });

  it('records the five task-owner decisions and keeps DR-5 limited to non-member and cross-scope', () => {
    const ownerIds = document['x-owner-decisions']
      .map((entry) => entry.split(' ')[0])
      .filter((id) => !id.startsWith('SOURCE'));
    expect(ownerIds).toEqual([
      'PATH-1',
      'LIMIT-1',
      'CURSOR-1',
      'ERR-1',
      'CACHE-1',
      'ERR-2',
      'HDR-1',
      'CACHE-2',
      'STATUS-1',
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

  it('marks every response no-store, every 401 with WWW-Authenticate: Bearer, and every error as the existing BE error shape', () => {
    for (const operations of Object.values(document.paths)) {
      for (const [status, response] of Object.entries(
        operations.get.responses,
      )) {
        const resolved = (
          response.$ref ? resolveReference(document, response.$ref) : response
        ) as ResponseContract;
        expect(resolved.headers?.['Cache-Control']?.schema.const).toBe(
          'no-store',
        );
        if (status === '401') {
          expect(resolved.headers?.['WWW-Authenticate']?.schema.const).toBe(
            'Bearer',
          );
        } else {
          expect(resolved.headers?.['WWW-Authenticate']).toBeUndefined();
        }
        if (status === '200') continue;
        expect(response.$ref).toMatch(/^#\/components\/responses\/\w+$/);
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

  const ownerDecision = (id: string) =>
    document['x-owner-decisions'].find((entry) => entry.startsWith(`${id} `)) ??
    '';

  it('maps every denial reason of the authorization boundary in ERR-2 (reviewer change request 20/10/2026)', () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        'src/services/task/runtime/task-authorization-boundary.ts',
      ),
      'utf8',
    );
    const union =
      /export type TaskAuthorizationDenialReason =([^;]+);/.exec(source)?.[1] ??
      '';
    const reasons = [...union.matchAll(/'([A-Z_]+)'/g)].map(
      (match) => match[1],
    );
    expect(reasons.length).toBeGreaterThanOrEqual(9);
    const mapping = ownerDecision('ERR-2');
    for (const reason of reasons) expect(mapping).toContain(reason);
    expect(mapping).toMatch(/UNVERIFIED_CONTEXT[^.]*map to 401/);
    expect(mapping).toMatch(
      /PROJECT_MISMATCH, RESOURCE_SCOPE_MISMATCH, PROJECT_SCOPE_DENIED, PERMISSION_DENIED and RESOURCE_SCOPE_UNRESOLVED map to 404/,
    );
    expect(mapping).toMatch(
      /PROJECT_SCOPE_UNAVAILABLE, PERMISSION_POLICY_UNAVAILABLE and RESOURCE_SCOPE_UNAVAILABLE map to 503/,
    );
    expect(mapping).toMatch(/RESOURCE_SCOPE_UNAVAILABLE is a new reason/);
    expect(mapping).toMatch(/never reported as a missing Task/);
    expect(mapping).toMatch(
      /INVALID_REQUEST[^.]*generic 500[^.]*never reported as 404/,
    );
    expect(mapping).toMatch(/none becomes false and a generic 403/);
    const internal = document.components.responses.InternalError.description;
    expect(internal).toMatch(/INVALID_REQUEST/);
    const unavailable =
      document.components.responses.AuthorizationUnavailable.description ?? '';
    expect(unavailable).toMatch(/RESOURCE_SCOPE_UNAVAILABLE/);
    expect(unavailable).toMatch(/never reported as a missing Task/);
  });

  it('records HDR-1, CACHE-2 and STATUS-1 and keeps the approved ERR-1 and CACHE-1 text as written', () => {
    expect(ownerDecision('HDR-1')).toMatch(
      /WWW-Authenticate: Bearer, as RFC 9110 section 15\.5\.2 requires/,
    );
    expect(ownerDecision('CACHE-2')).toMatch(
      /every response of both routes, errors included/,
    );
    expect(ownerDecision('CACHE-2')).toMatch(/extends CACHE-1/);
    const status = ownerDecision('STATUS-1');
    expect(status).toMatch(
      /including CANCELLED and every other lifecycle status/,
    );
    expect(status).toMatch(/no implicit status filter/);
    expect(status).toMatch(/exactly the seven approved fields, without status/);
    for (const operations of Object.values(document.paths)) {
      expect(operations.get.description).toMatch(/STATUS-1/);
      expect(operations.get.description).toMatch(/CANCELLED/);
    }
    expect(ownerDecision('CACHE-1')).toMatch(/on 200 responses\.$/);
    expect(ownerDecision('ERR-1')).toMatch(
      /returns a boolean and drops the denial reason/,
    );
  });

  it('keeps the reviewer additions unapproved by the Leader until repeated', () => {
    const source = document['x-owner-decisions'].find((entry) =>
      entry.startsWith('SOURCE-2:'),
    );
    expect(source).toMatch(/kudotruong212/);
    expect(source).toMatch(/pullrequestreview-5579678413/);
    expect(source).toMatch(/has not been repeated for these additions/);
    expect(source).toMatch(
      /no route activation, production use or policy ALLOW/,
    );
    expect(document['x-approval-status']).toMatch(
      /has not repeated the approval for those additions/,
    );
    expect(document['x-approval-conditions']).toHaveLength(8);
  });

  it('describes updatedAt and version as the stored values, not creation-only (lifecycle DB contract, PR #58)', () => {
    const { updatedAt, version } = document.components.schemas.Task.properties!;
    expect(updatedAt.description).toMatch(/never earlier than createdAt/);
    expect(updatedAt.description).not.toMatch(
      /equal to createdAt in this slice/i,
    );
    expect(version.description).toMatch(/may be greater than 1/);
    expect(version.description).not.toMatch(/creation ordinal/i);
  });

  it('resolves every local $ref and leaves no unreferenced component', () => {
    const references = collectReferences(document);
    for (const reference of references) {
      expect(reference).toMatch(
        /^#\/components\/(parameters|responses|schemas)\/\w+$/,
      );
      expect(resolveReference(document, reference)).toBeDefined();
    }
    for (const [section, entries] of Object.entries(document.components)) {
      if (section === 'securitySchemes') continue;
      for (const name of Object.keys(entries)) {
        expect(references).toContain(`#/components/${section}/${name}`);
      }
    }
  });
});
