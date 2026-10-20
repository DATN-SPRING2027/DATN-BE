import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidTaskTitle } from '../services/task/infrastructure/mongodb/task-contract';

interface HeaderContract {
  schema?: { const?: string; type?: string; pattern?: string };
}
interface ResponseContract {
  $ref?: string;
  description?: string;
  headers?: Record<string, HeaderContract>;
  content?: {
    'application/json': {
      schema: { $ref: string };
      examples?: Record<string, { value: Record<string, unknown> }>;
    };
  };
}
interface OperationContract {
  operationId?: string;
  description?: string;
  parameters?: { $ref?: string; name?: string }[];
  requestBody?: {
    required?: boolean;
    content: { 'application/json': { schema: { $ref: string } } };
  };
  responses: Record<string, ResponseContract>;
}
interface SchemaContract {
  required?: string[];
  properties?: Record<
    string,
    { pattern?: string; minLength?: number; maxLength?: number }
  >;
  additionalProperties?: boolean;
}
interface CreateDocument {
  'x-approval-status': string;
  'x-approval-conditions': string[];
  'x-owner-decisions': string[];
  'x-pending-decisions': string[];
  security?: Record<string, string[]>[];
  paths: Record<string, Record<string, OperationContract>>;
  components: {
    parameters: Record<string, unknown>;
    responses: Record<string, ResponseContract>;
    schemas: Record<string, SchemaContract>;
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8')) as T;
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

describe('DATN-97 Task create OpenAPI (proposal, not approved)', () => {
  const document = readJson<CreateDocument>(
    'docs/openapi/task-v1-d05-create.openapi.json',
  );
  const slice = readJson<CreateDocument>(
    'docs/openapi/task-v1-d05-slice.openapi.json',
  );
  const path = '/internal/tasks/projects/{projectId}/tasks';
  const create = document.paths[path]?.post;
  const ownerDecision = (id: string) =>
    document['x-owner-decisions'].find((entry) => entry.startsWith(`${id} `)) ??
    '';

  it('declares only the create operation and states that it is not approved', () => {
    expect(Object.keys(document.paths)).toEqual([path]);
    expect(Object.keys(document.paths[path])).toEqual(['post']);
    expect(create.operationId).toBe('createProjectTaskInternalV1');
    expect(document['x-approval-status']).toMatch(/^PROPOSED\. Not approved/);
    expect(document['x-approval-status']).toMatch(
      /No route activation, production use or policy ALLOW/,
    );
    expect(document['x-approval-conditions']).toHaveLength(5);
    expect(
      document['x-pending-decisions'].map((entry) => entry.split(':')[0]),
    ).toEqual(['APPROVAL-C', 'DR7-1', 'DR4-C', 'AUTH-1']);
  });

  it('takes only a title, with no Idempotency-Key, expectedVersion or caller-set field', () => {
    expect(create.requestBody?.required).toBe(true);
    expect(create.requestBody?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/CreateTaskRequest',
    );
    const request = document.components.schemas.CreateTaskRequest;
    expect(request.additionalProperties).toBe(false);
    expect(request.required).toEqual(['title']);
    expect(Object.keys(request.properties ?? {})).toEqual(['title']);
    expect(request.properties?.title.maxLength).toBeUndefined();
    expect(create.parameters).toEqual([
      { $ref: '#/components/parameters/ProjectId' },
    ]);
    expect(JSON.stringify(document)).not.toMatch(
      /"name": ?"Idempotency-Key"|expectedVersion":/i,
    );
    expect(create.description).toMatch(/There is no Idempotency-Key header/);
  });

  it('applies the same title rule as the repository', () => {
    const pattern = new RegExp(
      document.components.schemas.CreateTaskRequest.properties!.title.pattern!,
      'u',
    );
    const samples = [
      'a',
      ' a ',
      'Task 1',
      '   ',
      '\t\n\v\f\r',
      ' ',
      ' ',
      '   ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      ' ',
      '　',
      '　x',
      '\u0085',
      '​',
      '﻿',
      '😀',
      'x ',
      '',
    ];
    for (const sample of samples) {
      expect({ sample, ok: pattern.test(sample) }).toEqual({
        sample,
        ok: isValidTaskTitle(sample),
      });
    }
    expect(
      document.components.schemas.CreateTaskRequest.properties?.title.minLength,
    ).toBe(1);
  });

  it('documents exactly 201, 401, 404, 422, 500 and 503 with the existing error shape', () => {
    expect(Object.keys(create.responses).sort()).toEqual([
      '201',
      '401',
      '404',
      '422',
      '500',
      '503',
    ]);
    for (const [status, response] of Object.entries(create.responses)) {
      if (status === '201') continue;
      expect(response.$ref).toMatch(/^#\/components\/responses\/\w+$/);
      const resolved = resolveReference(
        document,
        response.$ref ?? '',
      ) as ResponseContract;
      expect(resolved.content?.['application/json'].schema.$ref).toBe(
        '#/components/schemas/ErrorResponse',
      );
    }
    expect(document.components.schemas.ErrorResponse).toEqual(
      slice.components.schemas.ErrorResponse,
    );
    expect(document.components.schemas.Task).toMatchObject({
      required: slice.components.schemas.Task.required,
      additionalProperties: false,
    });
    expect(
      Object.keys(document.components.schemas.Task.properties ?? {}).sort(),
    ).toEqual(
      Object.keys(slice.components.schemas.Task.properties ?? {}).sort(),
    );
  });

  it('marks every response no-store, 201 with Location and 401 with WWW-Authenticate: Bearer', () => {
    for (const [status, response] of Object.entries(create.responses)) {
      const resolved = (
        response.$ref ? resolveReference(document, response.$ref) : response
      ) as ResponseContract;
      expect(resolved.headers?.['Cache-Control']?.schema?.const).toBe(
        'no-store',
      );
      if (status === '401') {
        expect(resolved.headers?.['WWW-Authenticate']?.schema?.const).toBe(
          'Bearer',
        );
      } else {
        expect(resolved.headers?.['WWW-Authenticate']).toBeUndefined();
      }
      if (status === '201') {
        expect(resolved.headers?.Location?.schema?.pattern).toBe(
          '^/internal/tasks/projects/[a-f0-9]{24}/tasks/[a-f0-9]{24}$',
        );
      }
    }
  });

  it('tells the three 503 causes apart by code and returns the taskId only for an uncertain outcome (DR7D-1)', () => {
    const unavailable = document.components.responses.ServiceUnavailable;
    const examples = unavailable.content?.['application/json'].examples ?? {};
    expect(
      Object.values(examples)
        .map((example) => example.value.code)
        .sort(),
    ).toEqual([
      'RETRY_LATER',
      'TASK_AUTHORIZATION_UNAVAILABLE',
      'TASK_CREATE_UNCERTAIN',
    ]);
    expect(examples.uncertain.value.details).toEqual({
      taskId: expect.stringMatching(/^[a-f0-9]{24}$/) as string,
    });
    expect(examples.aborted.value.details).toEqual({});
    expect(unavailable.headers?.['Retry-After']).toBeDefined();
    expect(unavailable.description).toMatch(
      /resolves the outcome with the detail operation/,
    );
  });

  it('reports a server fault for a rejected trusted context and validates the body only after authorization', () => {
    expect(document.components.responses.InternalError.description).toMatch(
      /INVALID_TRUSTED_CONTEXT, a server fault/,
    );
    expect(document.components.responses.ValidationFailed.description).toMatch(
      /Authorization runs first/,
    );
    expect(create.description).toMatch(/Authorization runs before the body/);
    expect(create.description).toMatch(/body_sha256/);
  });

  it('records the proposals as unapproved and keeps create off by default', () => {
    const ids = document['x-owner-decisions']
      .map((entry) => entry.split(' ')[0])
      .map((id) => id.replace(/:$/, ''));
    expect(ids).toEqual([
      'SOURCE-3',
      'CREATE-1',
      'CREATE-2',
      'CREATE-3',
      'DR7C-1',
      'DR7D-1',
      'DR3-1',
      'DR8-1',
      'RISK-1',
    ]);
    expect(document['x-owner-decisions'][0]).toMatch(
      /NOT approved by any authority/,
    );
    expect(ownerDecision('CREATE-2')).toMatch(
      /COMMITTED, with or without reconciliation, is 201/,
    );
    expect(ownerDecision('CREATE-3')).toMatch(/its own explicit flag/);
    expect(ownerDecision('DR7C-1')).toMatch(/Idempotency-Key is excluded/);
    expect(ownerDecision('DR7D-1')).toMatch(/TaskHttpExceptionFilter/);
    expect(ownerDecision('DR3-1')).toMatch(
      /must be on before create or any mutation is enabled/,
    );
    expect(ownerDecision('DR3-1')).toMatch(/body_sha256/);
    expect(ownerDecision('DR8-1')).toMatch(/about 65 seconds/);
    expect(ownerDecision('RISK-1')).toMatch(/Before create or any mutation/);
  });

  it('requires the same opaque delegated bearer credential as the list and detail contract', () => {
    expect(document.security).toEqual(slice.security);
    expect(create).not.toHaveProperty('security');
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
