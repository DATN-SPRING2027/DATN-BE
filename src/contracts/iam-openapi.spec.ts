import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type JsonObject = Record<string, unknown>;

interface OpenApiOperation extends JsonObject {
  operationId: string;
  description?: string;
  parameters?: JsonObject[];
  responses: Record<string, JsonObject>;
}

interface OpenApiPathItem extends JsonObject {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  patch?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
}

interface OpenApiDocument extends JsonObject {
  openapi: string;
  paths: Record<string, OpenApiPathItem>;
  components: {
    schemas: Record<string, JsonObject>;
    parameters: Record<string, JsonObject>;
    responses: Record<string, JsonObject>;
  };
}

function loadContract(): OpenApiDocument {
  const contractPath = resolve(
    process.cwd(),
    'docs/openapi/iam-v1.openapi.json',
  );

  return JSON.parse(readFileSync(contractPath, 'utf8')) as OpenApiDocument;
}

function operations(document: OpenApiDocument): OpenApiOperation[] {
  const methods = ['get', 'post', 'patch', 'put', 'delete'] as const;

  return Object.values(document.paths).flatMap((pathItem) =>
    methods.flatMap((method) => {
      const operation = pathItem[method];
      return operation ? [operation] : [];
    }),
  );
}

function resolveLocalReference(
  document: OpenApiDocument,
  reference: string,
): unknown {
  return reference
    .slice(2)
    .split('/')
    .reduce<unknown>((current, segment) => {
      if (typeof current !== 'object' || current === null) {
        return undefined;
      }

      return (current as JsonObject)[segment];
    }, document);
}

describe('IAM OpenAPI contract', () => {
  const contract = loadContract();

  it('uses OpenAPI 3.1 and the /api/v1 base path', () => {
    expect(contract.openapi).toBe('3.1.0');
    expect(Object.keys(contract.paths).length).toBeGreaterThan(0);

    for (const path of Object.keys(contract.paths)) {
      expect(path).toMatch(/^\/api\/v1(?:\/|$)/);
    }
  });

  it('defines unique operation IDs', () => {
    const operationIds = operations(contract).map(
      (operation) => operation.operationId,
    );

    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('documents ACTIVE Organization Membership as the project.create boundary', () => {
    const createProject = contract.paths['/api/v1/iam/projects'].post;
    expect(createProject?.description).toContain(
      'ACTIVE Organization Membership',
    );
    expect(createProject?.description).toContain(
      'trusted Organization Context',
    );
    expect(createProject?.description).toContain(
      'project.create capability grant are not required',
    );
    expect(createProject?.description).toContain('New Projects are PRIVATE');
    expect(createProject?.description).toContain(
      'does not automatically create a ProjectMembership',
    );
    expect(createProject?.description).toContain(
      'project-scoped RoleAssignment, Team, Project Leader appointment',
    );
    expect(createProject?.description).toContain(
      'createdBy does not itself grant Project access',
    );
  });

  it('documents PUBLIC Project metadata visibility for active Organization members', () => {
    const listProjects = contract.paths['/api/v1/iam/projects'].get;
    const getProject = contract.paths['/api/v1/iam/projects/{projectId}'].get;
    expect(listProjects?.description).toContain('PUBLIC Project metadata');
    expect(listProjects?.description).toContain(
      'ACTIVE Organization Membership',
    );
    expect(getProject?.description).toContain('PUBLIC Project metadata');
    expect(getProject?.description).toContain(
      'Nested Project resources are outside this endpoint contract',
    );
  });

  it('documents Project Access V1 scope, permission codes, and leader replacement', () => {
    const visibility =
      contract.paths['/api/v1/iam/projects/{projectId}/visibility'].patch;
    const memberList =
      contract.paths['/api/v1/iam/projects/{projectId}/memberships'].get;
    const memberAdd =
      contract.paths['/api/v1/iam/projects/{projectId}/memberships'].post;
    const memberRemove =
      contract.paths[
        '/api/v1/iam/projects/{projectId}/memberships/{membershipId}'
      ].delete;
    const proposedMembershipPatch =
      contract.paths[
        '/api/v1/iam/projects/{projectId}/memberships/{membershipId}'
      ].patch;
    const leaders = contract.paths['/api/v1/iam/projects/{projectId}/leaders'];
    expect(visibility?.description).toContain('project.visibility.manage');
    expect(visibility?.description).toContain('PRIVATE to PUBLIC');
    expect(visibility?.description).toContain(
      'already-PUBLIC active Project returns 409 after authorization succeeds',
    );
    expect(visibility?.responses['409']).toEqual({
      $ref: '#/components/responses/Conflict',
    });
    expect(memberList?.description).toContain('project.members.list');
    expect(memberAdd?.description).toContain('project.members.add');
    expect(memberRemove?.description).toContain('project.members.remove');
    expect(memberRemove?.description).toContain(
      'already-INACTIVE membership or repeated DELETE returns 204',
    );
    expect(memberRemove?.responses['204']?.description).toContain(
      'repeated DELETE also returns 204',
    );
    expect(proposedMembershipPatch?.description).toContain(
      'no generic ProjectMembership PATCH is enabled',
    );
    expect(proposedMembershipPatch?.description).toContain(
      'project.members.role.change permission is disabled',
    );
    expect(leaders.post?.description).toContain('project.leader.manage');
    expect(leaders.put?.description).toContain('PROJECT_LEADER_CHANGED');
    expect(
      contract.paths['/api/v1/iam/projects/{projectId}/leaders/{userId}'].delete
        ?.description,
    ).toContain('project.leader.manage');
    expect(leaders.put?.requestBody).toBeDefined();
  });

  it('defines the required pagination defaults and limit', () => {
    expect(contract.components.parameters.Page).toMatchObject({
      name: 'page',
      in: 'query',
      schema: { type: 'integer', default: 1, minimum: 1 },
    });
    expect(contract.components.parameters.PageSize).toMatchObject({
      name: 'pageSize',
      in: 'query',
      schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
    });

    const listOperationIds = new Set([
      'listUsers',
      'listProjects',
      'listProjectMemberships',
      'listTeams',
      'listTeamMemberships',
    ]);

    for (const operation of operations(contract)) {
      if (!listOperationIds.has(operation.operationId)) {
        continue;
      }

      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/PageSize' },
        ]),
      );
    }
  });

  it('uses the standard error response shape', () => {
    expect(contract.components.schemas.ErrorResponse).toMatchObject({
      type: 'object',
      required: ['code', 'message', 'details', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object' },
        requestId: { type: 'string' },
      },
    });
  });

  it('models every resource ID as an opaque string', () => {
    const resourceSchemas = [
      'User',
      'Project',
      'ProjectMembership',
      'Team',
      'TeamMembership',
    ];

    for (const schemaName of resourceSchemas) {
      expect(contract.components.schemas[schemaName]).toMatchObject({
        properties: { id: { type: 'string' } },
      });
    }
  });

  it('requires UTC ISO-8601 timestamps', () => {
    expect(contract.components.schemas.UtcTimestamp).toMatchObject({
      type: 'string',
      format: 'date-time',
      pattern: 'Z$',
    });
  });

  it('defines reusable responses for every required error status', () => {
    for (const responseName of [
      'Unauthorized',
      'Forbidden',
      'NotFound',
      'Conflict',
      'ValidationFailed',
      'TooManyRequests',
    ]) {
      expect(contract.components.responses[responseName]).toBeDefined();
    }

    const responseCodes = new Set(
      operations(contract).flatMap((operation) =>
        Object.keys(operation.responses),
      ),
    );

    for (const status of ['401', '403', '404', '409', '422', '429']) {
      expect(responseCodes).toContain(status);
    }

    const expectedReferences: Record<string, string> = {
      '401': '#/components/responses/Unauthorized',
      '403': '#/components/responses/Forbidden',
      '404': '#/components/responses/NotFound',
      '409': '#/components/responses/Conflict',
      '422': '#/components/responses/ValidationFailed',
      '429': '#/components/responses/TooManyRequests',
    };

    for (const operation of operations(contract)) {
      for (const [status, reference] of Object.entries(expectedReferences)) {
        const response = operation.responses[status];
        if (response) {
          expect(response).toEqual({
            $ref:
              operation.operationId === 'login' && status === '409'
                ? '#/components/responses/OrganizationSelectionRequired'
                : reference,
          });
        }
      }
    }
  });

  it('documents the implemented browser auth response without a JSON token', () => {
    const login = contract.paths['/api/v1/auth/login'].post!;
    const currentUser = contract.paths['/api/v1/auth/me'].get!;
    const logout = contract.paths['/api/v1/auth/logout'].post!;
    expect(login.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/LoginResponse' },
        },
      },
      headers: { 'Set-Cookie': { schema: { type: 'string' } } },
    });
    expect(contract.components.schemas.LoginResponse).toMatchObject({
      properties: { user: { $ref: '#/components/schemas/CurrentUser' } },
    });
    expect(currentUser.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CurrentUser' },
        },
      },
    });
    expect(logout.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/LogoutResponse' },
        },
      },
    });
    expect(logout.requestBody).toBeUndefined();
  });

  it('uses camelCase schema properties and parameter names', () => {
    const camelCase = /^[a-z][A-Za-z0-9]*$/;

    for (const schema of Object.values(contract.components.schemas)) {
      const properties = schema.properties as JsonObject | undefined;
      for (const propertyName of Object.keys(properties ?? {})) {
        expect(propertyName).toMatch(camelCase);
      }
    }

    for (const parameter of Object.values(contract.components.parameters)) {
      expect(parameter.name).toMatch(camelCase);
    }
  });

  it('resolves every local reference', () => {
    const references = JSON.stringify(contract).match(/#\/components\/[^"]+/g);

    for (const reference of new Set(references ?? [])) {
      expect(resolveLocalReference(contract, reference)).toBeDefined();
    }
  });

  it('contains no environment URI or credential example', () => {
    expect(contract).not.toHaveProperty('servers');

    const loginRequest = contract.components.schemas.LoginRequest;
    const loginProperties = loginRequest.properties as JsonObject;
    expect(loginProperties.password).not.toHaveProperty('example');
    expect(loginProperties.password).not.toHaveProperty('default');

    const tokenPair = contract.components.schemas.TokenPair;
    const tokenProperties = tokenPair.properties as JsonObject;
    expect(tokenProperties.accessToken).not.toHaveProperty('example');
    expect(tokenProperties.refreshToken).not.toHaveProperty('example');
  });
});
