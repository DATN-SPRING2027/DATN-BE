/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Jest asymmetric matchers are typed as any. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PlatformController } from '../services/iam/controllers/platform.controller';
import {
  PLATFORM_A04_PERMISSIONS,
  PLATFORM_V2_PERMISSIONS,
} from '../services/iam/application/authorization/authorization.policy';

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
    securitySchemes: Record<string, JsonObject>;
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

  it('supports both self-service account Organization bootstrap and PLATFORM_OPERATOR Organization provisioning', () => {
    expect(contract.paths['/api/v1/iam/organizations']?.post?.operationId).toBe(
      'createOwnOrganization',
    );
    expect(
      contract.paths['/api/v1/iam/platform/organizations'].post?.[
        'x-platform-permission'
      ],
    ).toBe('organization.create');
  });

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

  it('documents the required permission and PLATFORM scope for every Platform operation', () => {
    const methods = ['get', 'post', 'patch', 'put', 'delete'];
    const platformOperations = Object.entries(contract.paths)
      .filter(([path]) => path.startsWith('/api/v1/iam/platform'))
      .flatMap(([path, pathItem]) =>
        Object.entries(pathItem)
          .filter(([method]) => methods.includes(method))
          .map(([method, operation]) => ({
            path,
            method,
            operation: operation as OpenApiOperation,
          })),
      );

    expect(platformOperations.length).toBeGreaterThan(0);
    for (const { operation } of platformOperations) {
      expect(operation['x-platform-permission']).toEqual(expect.any(String));
      expect(operation.description).toMatch(/PLATFORM scope/i);
      expect(operation.operationId).toEqual(expect.any(String));
    }
  });

  it('documents the generic one-time password reset contract', () => {
    const request = contract.paths['/api/v1/auth/password-reset/request'].post;
    const confirm = contract.paths['/api/v1/auth/password-reset/confirm'].post;
    const requestSchema = contract.components.schemas.PasswordResetRequest;
    const confirmSchema = contract.components.schemas.PasswordResetConfirm;

    expect(request?.operationId).toBe('requestPasswordReset');
    expect(request?.security).toEqual([]);
    expect(request?.description).toContain('same generic 202');
    expect(request?.description).toContain('durably recorded');
    expect(request?.description).toContain('normalized email');
    expect(request?.responses['202']).toBeDefined();
    expect(request?.responses['429']).toBeDefined();
    expect(request?.responses['503']).toBeDefined();
    expect(confirm?.operationId).toBe('confirmPasswordReset');
    expect(confirm?.description).toContain('single-use');
    expect(confirm?.description).toContain(
      'revokes all of its refresh sessions',
    );
    expect(confirm?.description).toContain('15-minute expiry');
    expect(confirm?.responses['204']).toBeDefined();
    expect(confirm?.responses['400']).toBeDefined();
    expect(confirm?.responses['429']).toBeDefined();
    expect(requestSchema).toMatchObject({
      additionalProperties: false,
      required: ['email'],
    });
    expect(confirmSchema).toMatchObject({
      additionalProperties: false,
      required: ['token', 'password'],
    });
    expect(JSON.stringify(confirmSchema)).toContain('72 UTF-8 bytes');
  });

  it('keeps public email registration independent from Organization invitations', () => {
    const registration = contract.paths['/api/v1/auth/registrations'].post;
    const registrationSchema =
      contract.components.schemas.EmailRegistrationRequest;
    const properties = registrationSchema.properties as JsonObject;

    expect(registration?.operationId).toBe('requestEmailRegistration');
    expect(registration?.description).toContain(
      'independent from Organization invitation flows',
    );
    expect(registration?.description).toContain(
      'separately existing eligible account',
    );
    expect(registrationSchema).toMatchObject({
      additionalProperties: false,
      required: ['fullName', 'email'],
    });
    expect(Object.keys(properties).sort()).toEqual(['email', 'fullName']);
  });

  it('documents that Organization invitations target existing eligible accounts', () => {
    const invite =
      contract.paths['/api/v1/iam/organizations/{organizationId}/invitations']
        .post;
    const response = invite?.responses['422'];

    expect(invite?.operationId).toBe('createOrganizationInvitation');
    expect(invite?.summary).toContain('existing eligible account');
    expect(invite?.description).toContain(
      'unknown and inactive accounts receive the same generic 422 code INVITATION_TARGET_NOT_ELIGIBLE',
    );
    expect(response?.description).toContain('INVITATION_TARGET_NOT_ELIGIBLE');
  });

  it('preserves A-04 semantics and documents the separately versioned V2 permission registry', () => {
    const organization =
      contract.paths['/api/v1/iam/platform/organizations'].post;
    const health = contract.paths['/api/v1/iam/platform/health'].get;
    const audit = contract.paths['/api/v1/iam/platform/audit'].get;
    expect(organization?.['x-platform-permission']).toBe('organization.create');
    expect(organization?.description).toContain('first active ADMIN');
    expect(organization?.description).toContain(
      'not made an Organization member or ADMIN',
    );
    expect(health?.['x-platform-permission']).toBe('platform.health.read');
    expect(health?.description).toContain('does not return configuration');
    expect(health?.summary).toBe('Read IAM process liveness');
    expect(health?.description).toContain('liveness response only');
    expect(health?.description).toContain(
      'does not report MongoDB, Redis, BullMQ',
    );
    expect(audit?.['x-platform-permission']).toBe('platform.audit.read');
    expect(audit?.description).toContain('Project records');
    const platformPermission = contract.components.schemas
      .PlatformPermission as {
      type: string;
      enum: string[];
    };
    expect(platformPermission.type).toBe('string');
    expect(platformPermission.enum).toEqual([...PLATFORM_V2_PERMISSIONS]);
    expect(
      platformPermission.enum.filter((permission) =>
        PLATFORM_A04_PERMISSIONS.includes(permission as never),
      ),
    ).toEqual([...PLATFORM_A04_PERMISSIONS]);
    expect(
      JSON.stringify(contract.components.schemas.PlatformPermission),
    ).not.toContain('platform.configuration');
  });

  it('documents Platform-safe project projections and real IAM dashboard counts', () => {
    const projectList = contract.paths['/api/v1/iam/platform/projects'].get;
    const projectDetail =
      contract.paths['/api/v1/iam/platform/projects/{projectId}'].get;
    const dashboard = contract.paths['/api/v1/iam/platform/dashboard'].get;
    expect(projectList?.operationId).toBe('listPlatformProjects');
    expect(projectList?.['x-platform-permission']).toBe(
      'platform.projects.project.read',
    );
    expect(projectList?.parameters).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/parameters/Page' },
        { $ref: '#/components/parameters/PageSize' },
      ]),
    );
    expect(projectList?.description).toContain(
      'documents, chunks, prompts and tenant content are excluded',
    );
    expect(projectDetail?.responses['200']).toBeDefined();
    expect(dashboard?.['x-platform-permission']).toBe(
      'platform.dashboard.summary.read',
    );
    expect(dashboard?.operationId).toBe('readPlatformDashboardOverview');
    expect(dashboard?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/PlatformDashboardOverview',
          },
        },
      },
    });
    expect(dashboard?.description).toContain('bounded readiness probes');
    expect(contract.components.schemas.PlatformProjectSummary).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['organization', 'memberCount']),
    });
    expect(contract.components.schemas.PlatformDashboardSummary).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'organizations',
        'users',
        'projects',
        'memberships',
      ]),
    });
    expect(contract.components.schemas.PlatformDashboardOverview).toMatchObject(
      {
        additionalProperties: false,
        required: expect.arrayContaining([
          'serviceHealth',
          'recentOperationalActivity',
        ]),
      },
    );
    expect(
      JSON.stringify(contract.components.schemas.PlatformDashboardOverview),
    ).not.toMatch(/actorUserId|resourceId|rawError|responseBody/i);
  });

  it('documents global Platform membership search, filters and safe detail', () => {
    const list = contract.paths['/api/v1/iam/platform/memberships'].get;
    const detail =
      contract.paths['/api/v1/iam/platform/memberships/{membershipId}'].get;
    expect(list?.operationId).toBe('listPlatformMemberships');
    expect(list?.['x-platform-permission']).toBe(
      'platform.memberships.membership.read',
    );
    expect(list?.description).toContain('stably sorted');
    expect(list?.parameters).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/parameters/Page' },
        { $ref: '#/components/parameters/PageSize' },
        expect.objectContaining({ name: 'organizationId', in: 'query' }),
        expect.objectContaining({ name: 'status', in: 'query' }),
        expect.objectContaining({ name: 'roleCode', in: 'query' }),
      ]),
    );
    expect(detail?.operationId).toBe('readPlatformMembership');
    expect(detail?.['x-platform-permission']).toBe(
      'platform.memberships.membership.read',
    );
    expect(detail?.responses['404']).toBeDefined();
    expect(contract.components.schemas.PlatformMembershipSummary).toMatchObject(
      {
        additionalProperties: false,
        properties: {
          organization: {
            oneOf: expect.arrayContaining([
              { $ref: '#/components/schemas/PlatformProjectOrganization' },
            ]),
          },
        },
      },
    );
  });

  it('documents Platform project membership metadata with both resource scope keys', () => {
    const operation =
      contract.paths['/api/v1/iam/platform/projects/{projectId}/memberships']
        .get;
    const schema = contract.components.schemas.PlatformProjectMemberSummary;
    expect(operation?.operationId).toBe('listPlatformProjectMemberships');
    expect(operation?.['x-platform-permission']).toBe(
      'platform.projects.project.read',
    );
    expect(operation?.description).toContain(
      'fences membership rows to both identifiers',
    );
    expect(operation?.responses['404']).toBeDefined();
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'projectId',
        'organizationId',
        'userId',
        'status',
        'joinedAt',
      ]),
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /description|document|chunk|prompt|content|roleId/i,
    );
  });

  it('documents Platform pending invitation metadata under the membership read permission', () => {
    const invitations =
      contract.paths[
        '/api/v1/iam/platform/organizations/{organizationId}/invitations'
      ].get;
    expect(invitations?.operationId).toBe(
      'listPlatformOrganizationInvitations',
    );
    expect(invitations?.['x-platform-permission']).toBe(
      'platform.memberships.membership.read',
    );
    expect(invitations?.responses['404']).toBeDefined();
    expect(invitations?.description).toContain(
      'unexpired V3 invitation metadata',
    );
    expect(
      JSON.stringify(contract.components.schemas.C02AdminInvitation),
    ).not.toMatch(/token|secret|credential/i);
  });

  it('documents Platform invitation commands with asynchronous email delivery', () => {
    const invite =
      contract.paths[
        '/api/v1/iam/platform/organizations/{organizationId}/invitations'
      ].post;
    const resend =
      contract.paths[
        '/api/v1/iam/platform/organizations/{organizationId}/invitations/{invitationId}/resend'
      ].post;
    const cancel =
      contract.paths[
        '/api/v1/iam/platform/organizations/{organizationId}/invitations/{invitationId}/cancel'
      ].post;

    expect(invite?.operationId).toBe('createPlatformOrganizationInvitation');
    expect(resend?.operationId).toBe('resendPlatformOrganizationInvitation');
    expect(cancel?.operationId).toBe('cancelPlatformOrganizationInvitation');
    for (const operation of [invite, resend, cancel]) {
      expect(operation).toMatchObject({
        'x-platform-permission': 'platform.memberships.invitation.manage',
        'x-contract-status': 'USER_APPROVED',
        'x-runtime-status': 'IMPLEMENTED_BACKEND',
      });
      expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining([
          'Idempotency-Key',
          'X-CSRF-Token',
          '__Host-csrf',
        ]),
      );
      expect(operation?.responses['503']).toBeDefined();
    }
    expect(invite?.['x-readiness-gates']).toEqual([
      'A7_NOTIFICATION_CONTRACT_PROVIDER',
      'A8_COORDINATED_CUTOVER',
    ]);
    expect(resend?.['x-readiness-gates']).toEqual([
      'A7_NOTIFICATION_CONTRACT_PROVIDER',
      'A8_COORDINATED_CUTOVER',
    ]);
    expect(cancel?.['x-readiness-gates']).toEqual(['A8_COORDINATED_CUTOVER']);
    expect(invite?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/C02InviteMemberRequest' },
        },
      },
    });
    expect(invite?.description).toContain(
      'Email delivery remains asynchronous',
    );
    expect(resend?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/C02ResendInvitationRequest' },
        },
      },
    });
    expect(cancel?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/C02CancelInvitationRequest' },
        },
      },
    });
  });

  it('documents Platform service health probes with bounded safe projections', () => {
    const list = contract.paths['/api/v1/iam/platform/services'].get;
    const detail =
      contract.paths['/api/v1/iam/platform/services/{serviceId}'].get;
    const summary =
      contract.components.schemas.PlatformServiceOperationsSummary;
    expect(list?.operationId).toBe('listPlatformServices');
    expect(detail?.operationId).toBe('readPlatformService');
    expect(list?.['x-platform-permission']).toBe(
      'platform.services.service.read',
    );
    expect(detail?.['x-platform-permission']).toBe(
      'platform.services.service.read',
    );
    expect(list?.description).toContain('readiness endpoint');
    expect(summary).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'status',
        'availability',
        'liveness',
        'readiness',
        'dependencies',
        'lastCheckedAt',
      ]),
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /credential|token|secret|payload|responseBody/i,
    );
  });

  it('documents BullMQ queue and job reads with payload-safe projections', () => {
    const jobs = contract.paths['/api/v1/iam/platform/jobs'].get;
    const job =
      contract.paths['/api/v1/iam/platform/jobs/{queueId}/{jobId}'].get;
    const queues = contract.paths['/api/v1/iam/platform/queues'].get;
    const queue = contract.paths['/api/v1/iam/platform/queues/{queueId}'].get;
    const summary = contract.components.schemas.PlatformJobSummary;
    const properties = summary.properties as Record<string, unknown>;
    for (const operation of [jobs, job, queues, queue]) {
      expect(operation?.['x-platform-permission']).toBe(
        'platform.jobs.job.read',
      );
    }
    expect(jobs?.responses['200']).toBeDefined();
    expect(queue?.responses['404']).toBeDefined();
    expect(properties).not.toHaveProperty('data');
    expect(properties).not.toHaveProperty('result');
    expect(properties).not.toHaveProperty('payload');
    expect(properties).not.toHaveProperty('failedReason');
    expect(
      contract.components.schemas.PlatformQueueOperationsSummary,
    ).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['depth', 'counts', 'availability']),
    });
  });

  it('documents retry and cancel with manage permission, CSRF, idempotency, and bounded results', () => {
    const retry =
      contract.paths['/api/v1/iam/platform/jobs/{queueId}/{jobId}/retry'].post;
    const cancel =
      contract.paths['/api/v1/iam/platform/jobs/{queueId}/{jobId}/cancel'].post;
    for (const operation of [retry, cancel]) {
      expect(operation?.['x-platform-permission']).toBe(
        'platform.jobs.job.manage',
      );
      expect(operation?.responses['200']).toBeDefined();
      expect(operation?.responses['409']).toBeDefined();
      expect(operation?.responses['503']).toBeDefined();
      expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining([
          'X-CSRF-Token',
          '__Host-csrf',
          'Idempotency-Key',
        ]),
      );
    }
    expect(retry?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PlatformJobRetryRequest' },
        },
      },
    });
    expect(cancel?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PlatformJobCancelRequest' },
        },
      },
    });
  });

  it('documents SAG as an external operational owner with explicit safe unavailable fields', () => {
    const operation = contract.paths['/api/v1/iam/platform/ai/operations'].get;
    const schema = contract.components.schemas.PlatformAiOperationsSummary;
    expect(operation?.['x-platform-permission']).toBe(
      'platform.ai.operations.read',
    );
    expect(operation?.description).toContain('current SAG operational API');
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'liveness',
        'readiness',
        'dependencies',
        'lastCheckedAt',
      ]),
    });
    expect(JSON.stringify(schema)).not.toMatch(
      /apiKey|credential|token|prompt|document|chunk|embedding/i,
    );
  });

  it('documents Jira-owned integration metadata without credential fields', () => {
    const list = contract.paths['/api/v1/iam/platform/integrations'].get;
    const detail =
      contract.paths['/api/v1/iam/platform/integrations/{integrationId}'].get;
    const summary = contract.components.schemas.PlatformIntegrationSummary;
    const properties = summary.properties as Record<string, unknown>;
    expect(list?.['x-platform-permission']).toBe(
      'platform.integrations.integration.read',
    );
    expect(detail?.['x-platform-permission']).toBe(
      'platform.integrations.integration.read',
    );
    expect(list?.description).toContain('signed internal request');
    expect(list?.description).toContain(
      'Jira owner has no credential decryptor/provider client',
    );
    expect(summary).toMatchObject({ additionalProperties: false });
    expect(properties).not.toHaveProperty('credentialsEncrypted');
    expect(properties).not.toHaveProperty('webhookSecret');
    expect(properties).not.toHaveProperty('atlassianUrl');
    expect(properties).not.toHaveProperty('errorLog');
  });

  it('documents blocked Jira connection commands with safe unavailable contracts', () => {
    const test =
      contract.paths['/api/v1/iam/platform/integrations/{integrationId}/test']
        .post;
    const reconnect =
      contract.paths[
        '/api/v1/iam/platform/integrations/{integrationId}/reconnect'
      ].post;
    expect(test?.['x-platform-permission']).toBe(
      'platform.integrations.integration.manage',
    );
    expect(reconnect?.['x-platform-permission']).toBe(
      'platform.integrations.integration.manage',
    );
    expect(test?.['x-runtime-status']).toBe('BLOCKED_EXTERNAL_DEPENDENCY');
    expect(reconnect?.['x-runtime-status']).toBe('BLOCKED_EXTERNAL_DEPENDENCY');
    expect(test?.responses['503']).toBeDefined();
    expect(reconnect?.responses['503']).toBeDefined();
    expect(test?.description).toContain('never fabricate a successful test');
    expect(reconnect?.description).toContain('never fabricate a reconnect');
    expect(reconnect?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/PlatformIntegrationReconnectRequest',
          },
        },
      },
    });
    expect(
      contract.components.schemas.PlatformIntegrationReconnectRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: ['expectedUpdatedAt'],
    });
    for (const operation of [test, reconnect]) {
      expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining([
          'integrationId',
          'X-CSRF-Token',
          '__Host-csrf',
          'Idempotency-Key',
        ]),
      );
    }
  });

  it('documents filtered, paginated Platform audit event and resource history APIs', () => {
    const events = contract.paths['/api/v1/iam/platform/audit/events'].get;
    const detail =
      contract.paths['/api/v1/iam/platform/audit/events/{eventId}'].get;
    const history =
      contract.paths[
        '/api/v1/iam/platform/audit/resources/{resourceType}/{resourceId}/history'
      ].get;
    expect(events?.operationId).toBe('listPlatformAuditEvents');
    expect(events?.['x-platform-permission']).toBe('platform.audit.read');
    expect(events?.parameters).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/parameters/Page' },
        { $ref: '#/components/parameters/PageSize' },
      ]),
    );
    expect(events?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining([
        'actorUserId',
        'action',
        'resourceType',
        'resourceId',
        'organizationId',
        'from',
        'to',
      ]),
    );
    expect(detail?.responses['200']).toBeDefined();
    expect(history?.['x-platform-permission']).toBe('platform.audit.read');
    expect(contract.components.schemas.PlatformAuditEvent).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'eventId',
        'occurredAt',
        'actorUserId',
        'action',
        'resourceType',
        'resourceId',
        'scope',
        'result',
      ]),
    });
    expect(contract.components.schemas.PlatformAuditAction.enum).toEqual(
      expect.arrayContaining([
        'platform.session.revoked',
        'platform.sessions.revoked_all',
      ]),
    );
    expect(
      contract.components.schemas.PlatformAuditResourceType.enum,
    ).toContain('SESSION');
  });

  it('documents Platform session administration with safe projections and matching permissions', () => {
    const paths = [
      {
        path: '/api/v1/iam/platform/users/{userId}/sessions',
        method: 'get',
        permission: 'platform.sessions.session.read',
        operationId: 'listPlatformUserSessions',
      },
      {
        path: '/api/v1/iam/platform/users/{userId}/sessions/{sessionId}',
        method: 'get',
        permission: 'platform.sessions.session.read',
        operationId: 'readPlatformUserSession',
      },
      {
        path: '/api/v1/iam/platform/users/{userId}/sessions/{sessionId}/revoke',
        method: 'post',
        permission: 'platform.sessions.session.manage',
        operationId: 'revokePlatformUserSession',
      },
      {
        path: '/api/v1/iam/platform/users/{userId}/sessions/revoke-bulk',
        method: 'post',
        permission: 'platform.sessions.session.manage',
        operationId: 'revokePlatformUserSessions',
      },
      {
        path: '/api/v1/iam/platform/users/{userId}/sessions/revoke-all',
        method: 'post',
        permission: 'platform.sessions.session.manage',
        operationId: 'revokeAllPlatformUserSessions',
      },
    ] as const;

    for (const { path, method, permission, operationId } of paths) {
      const operation = contract.paths[path][method];
      expect(operation?.operationId).toBe(operationId);
      expect(operation?.['x-platform-permission']).toBe(permission);
      expect(operation?.responses['401']).toBeDefined();
      expect(operation?.responses['403']).toBeDefined();
      expect(operation?.responses['422']).toBeDefined();
      expect(operation?.responses['503']).toBeDefined();
    }

    const safeSession = contract.components.schemas.PlatformSessionSummary;
    expect(safeSession).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        'id',
        'userId',
        'context',
        'status',
        'createdAt',
        'updatedAt',
        'expiresAt',
      ]),
    });
    expect(JSON.stringify(safeSession)).not.toMatch(
      /tokenHash|refreshToken|accessToken|ipAddress|userAgent/i,
    );
    expect(
      contract.components.schemas.PlatformSessionBulkRevokeRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: ['sessions', 'reasonCode'],
    });
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
      'ACTIVE ProjectMembership with a project-scoped TEAM_LEADER RoleAssignment',
    );
    expect(createProject?.description).toContain('project.members.add');
    expect(createProject?.description).toContain('project.members.remove');
    expect(createProject?.description).toContain('project.update');
    expect(createProject?.description).toContain('project.visibility.manage');
    expect(createProject?.description).toContain(
      'no separate Project owner or Team record',
    );
  });

  it('documents the authorized, capped member candidate search contract', () => {
    const candidates =
      contract.paths['/api/v1/iam/projects/{projectId}/member-candidates'].get;
    expect(candidates?.operationId).toBe('listProjectMemberCandidates');
    expect(candidates?.description).toContain('project.members.add');
    expect(candidates?.description).toContain('at most 50 candidates');
    expect(candidates?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ProjectMemberCandidates' },
        },
      },
    });
    expect(contract.components.schemas.ProjectMemberCandidates).toMatchObject({
      properties: { data: { maxItems: 50 } },
    });
    expect(contract.components.schemas.ProjectMemberCandidate).toMatchObject({
      required: expect.arrayContaining([
        'userId',
        'email',
        'organizationMembershipStatus',
        'isProjectMember',
      ]),
    });
  });

  it('documents PUBLIC Project metadata visibility for active Organization members', () => {
    const listProjects = contract.paths['/api/v1/iam/projects'].get;
    const getProject = contract.paths['/api/v1/iam/projects/{projectId}'].get;
    expect(listProjects?.description).toContain('PUBLIC Project metadata');
    expect(listProjects?.description).toContain(
      'ACTIVE Organization Membership',
    );
    expect(listProjects?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'q',
          in: 'query',
          schema: { type: 'string', minLength: 2, maxLength: 80 },
        }),
      ]),
    );
    expect(getProject?.description).toContain('PUBLIC Project metadata');
    expect(getProject?.description).toContain(
      'Nested Project resources are outside this endpoint contract',
    );
  });

  it('documents Project Access V1 scope, permission codes, and leader replacement', () => {
    const project = contract.paths['/api/v1/iam/projects/{projectId}'];
    const settingsAccess =
      contract.paths['/api/v1/iam/projects/{projectId}/settings-access'].get;
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
    const leaderCandidates =
      contract.paths['/api/v1/iam/projects/{projectId}/leader-candidates'].get;
    expect(project.patch?.operationId).toBe('updateProject');
    expect(project.patch?.description).toContain('project.update');
    expect(project.patch?.description).toContain('name and/or description');
    expect(project.patch?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/UpdateProjectRequest' },
        },
      },
    });
    expect(contract.components.schemas.UpdateProjectRequest).toMatchObject({
      additionalProperties: false,
      minProperties: 1,
      properties: {
        name: { type: 'string', maxLength: 200 },
        description: { type: ['string', 'null'], maxLength: 2000 },
      },
    });
    expect(
      contract.components.schemas.UpdateProjectRequest.properties,
    ).not.toHaveProperty('status');
    expect(settingsAccess?.operationId).toBe('getProjectSettingsAccess');
    expect(settingsAccess?.description).toContain('project.update');
    expect(settingsAccess?.responses['200']).toBeDefined();
    expect(visibility?.description).toContain('project.visibility.manage');
    expect(visibility?.description).toContain('PRIVATE to PUBLIC');
    expect(visibility?.description).toContain('PUBLIC to PRIVATE');
    expect(
      contract.paths['/api/v1/iam/projects/{projectId}/visibility'].get
        ?.responses['403'],
    ).toEqual({ $ref: '#/components/responses/Forbidden' });
    expect(
      contract.components.schemas.MakeProjectPublicRequest.properties,
    ).toEqual({
      visibility: { $ref: '#/components/schemas/ProjectVisibility' },
    });
    expect(visibility?.description).toContain(
      'current visibility returns 409 after authorization succeeds',
    );
    expect(visibility?.responses['409']).toEqual({
      $ref: '#/components/responses/Conflict',
    });
    expect(memberList?.description).toContain('project.members.list');
    expect(memberList?.description).toContain(
      'optional user profile projection',
    );
    expect(contract.components.schemas.ProjectMembership).toMatchObject({
      properties: {
        user: { $ref: '#/components/schemas/ProjectMemberUser' },
      },
    });
    expect(contract.components.schemas.ProjectMemberUser).toMatchObject({
      required: ['id', 'email', 'avatarUrl'],
      properties: { avatarUrl: { type: ['string', 'null'] } },
    });
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
    expect(leaders.post?.description).toContain('0 effective Project Leaders');
    expect(leaders.get?.operationId).toBe('listProjectLeaders');
    expect(leaders.get?.description).toContain('project.members.list');
    expect(leaders.get?.description).toContain('only userId, fullName, email');
    expect(leaderCandidates?.operationId).toBe('listProjectLeaderCandidates');
    expect(leaderCandidates?.description).toContain('project.leader.manage');
    expect(
      contract.components.schemas.ProjectLeader.properties,
    ).not.toHaveProperty('password');
    expect(
      contract.components.schemas.ProjectLeader.properties,
    ).not.toHaveProperty('token');
    expect(leaders.put?.description).toContain('PROJECT_LEADER_CHANGED');
    expect(
      contract.paths['/api/v1/iam/projects/{projectId}/leaders/{userId}'].delete
        ?.description,
    ).toContain('project.leader.manage');
    expect(
      contract.paths['/api/v1/iam/projects/{projectId}/leaders/{userId}'].delete
        ?.description,
    ).toContain('LAST_PROJECT_LEADER_REQUIRED');
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
          if (
            [
              'listOrganizationMembershipsV1',
              'getOrganizationMembershipV1',
              'listOrganizationInvitations',
              'getAccountInvitationV3',
              'listAccountInvitationsV3',
              'acceptOrganizationInvitationV3',
              'resolveOrganizationInvitationTokenV3',
              'createOrganizationInvitation',
              'resendOrganizationMembershipInvitation',
              'cancelOrganizationMembershipInvitation',
              'suspendOrganizationMembership',
              'setOrganizationMembershipRole',
            ].includes(operation.operationId)
          ) {
            const name = reference.split('/').at(-1)!;
            const scopedName = `C02Membership${name}`;
            if (response.$ref === `#/components/responses/${scopedName}`) {
              expect(contract.components.responses[scopedName].content).toEqual(
                contract.components.responses[name].content,
              );
            } else if (response.$ref === reference) {
              expect(contract.components.responses[name]).toBeDefined();
            } else {
              expect(response).toHaveProperty('description');
            }
            continue;
          }
          if (
            (status === '422' || status === '429') &&
            (operation.operationId === 'requestEmailRegistration' ||
              operation.operationId === 'verifyEmailRegistration')
          ) {
            expect(typeof response.description).toBe('string');
            expect(response.headers).toMatchObject({
              'Cache-Control': {
                schema: { type: 'string', const: 'no-store' },
              },
              'Referrer-Policy': {
                schema: { type: 'string', const: 'no-referrer' },
              },
            });
            expect(response).toHaveProperty(
              'content.application/json.schema.$ref',
              '#/components/schemas/ErrorResponse',
            );
            if (status === '429') {
              expect(response.headers).toHaveProperty(
                'Retry-After.schema.type',
                'string',
              );
            }
            continue;
          }
          expect(response).toEqual({
            $ref:
              operation.operationId === 'login' && status === '409'
                ? '#/components/responses/OrganizationSelectionRequired'
                : operation.operationId === 'refreshSession' && status === '401'
                  ? '#/components/responses/RefreshInvalid'
                  : operation.operationId === 'refreshSession' &&
                      status === '403'
                    ? '#/components/responses/RefreshCsrfInvalid'
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
    expect(login.description).toContain(
      'every Organization membership count (zero, one, or many) receives an ACCOUNT session',
    );
    expect(
      contract.components.responses.OrganizationSelectionRequired.description,
    ).toContain(
      'does not use this response merely to display Organization options',
    );
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
      headers: {
        'Set-Cookie': { schema: { type: 'string' } },
        'Cache-Control': { schema: { const: 'no-store' } },
      },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/LogoutResponse' },
        },
      },
    });
    expect(logout.requestBody).toBeUndefined();
  });

  it('documents Google OAuth code flow, verified identity, and membership boundary', () => {
    const start = contract.paths['/api/v1/auth/google'].get!;
    const callback = contract.paths['/api/v1/auth/google/callback'].get!;

    expect(start.security).toEqual([]);
    expect(start.parameters?.[0]?.schema).toMatchObject({
      minLength: 24,
      maxLength: 24,
      pattern: '^[a-fA-F0-9]{24}$',
    });
    expect(start.description).toContain('authorization-code flow with PKCE');
    expect(start.description).toContain('state and nonce');
    expect(start.description).toContain('openid, email and profile');
    expect(start.responses['302']).toMatchObject({
      headers: {
        Location: { schema: { type: 'string', format: 'uri' } },
        'Set-Cookie': { schema: { type: 'string' } },
      },
    });
    expect(start.responses['422']).toEqual({
      $ref: '#/components/responses/ValidationFailed',
    });

    expect(callback.description).toContain('ID-token signature, audience');
    expect(callback.description).toContain('stable sub and verified email');
    expect(callback.description).toContain(
      'zero, one, or multiple active Organizations receive an ACCOUNT session',
    );
    expect(callback.description).toContain(
      'Google signup creates no Organization, membership, role or platform authority',
    );
    expect(callback.responses['302']).toHaveProperty('headers.Set-Cookie');
    expect(callback.responses['403']).toEqual({
      $ref: '#/components/responses/Forbidden',
    });
    expect(callback.responses['409']).toEqual({
      $ref: '#/components/responses/Conflict',
    });
    expect(callback.parameters?.map((parameter) => parameter.name)).toEqual([
      'code',
      'state',
      'error',
    ]);
  });

  it('documents the approved V3 Organization invitation commands and acceptance', () => {
    const accountList = contract.paths['/api/v1/auth/invitations'].get!;
    const accountDetail =
      contract.paths['/api/v1/auth/invitations/{invitationId}'].get!;
    const accept =
      contract.paths['/api/v1/auth/invitations/{invitationId}/accept'].post!;
    const resolve = contract.paths['/api/v1/auth/invitations/resolve'].post!;
    const orgPath =
      contract.paths['/api/v1/iam/organizations/{organizationId}/invitations'];
    const resend =
      contract.paths[
        '/api/v1/iam/organizations/{organizationId}/invitations/{invitationId}/resend'
      ].post!;
    const cancel =
      contract.paths[
        '/api/v1/iam/organizations/{organizationId}/invitations/{invitationId}/cancel'
      ].post!;
    const suspend =
      contract.paths[
        '/api/v1/iam/organizations/{organizationId}/memberships/{membershipId}/suspend'
      ].post!;

    expect(accountList.operationId).toBe('listAccountInvitationsV3');
    expect(accountDetail.operationId).toBe('getAccountInvitationV3');
    expect(accountList.description).toContain('exact normalized account email');
    expect(accept.operationId).toBe('acceptOrganizationInvitationV3');
    expect(accept.description).toContain('authenticated account email');
    expect(accept.description).toContain('commit atomically');
    expect(accept.responses['503']).toBeDefined();
    expect(accept['x-readiness-gates']).toEqual([
      'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF',
      'A8_COORDINATED_CUTOVER',
    ]);
    expect(accept.responses['410']).toBeDefined();
    expect(accept.responses['200']).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/C02AcceptInvitationAck',
    );
    expect(resolve).toMatchObject({
      operationId: 'resolveOrganizationInvitationTokenV3',
      security: [],
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-readiness-gates': [],
      responses: {
        '200': {
          headers: {
            'Cache-Control': { schema: { const: 'no-store' } },
          },
        },
      },
    });
    expect(resolve.requestBody).toHaveProperty(
      'content.application/json.schema.$ref',
      '#/components/schemas/C02ResolveInvitationRequest',
    );
    expect(accept.parameters?.map((parameter) => parameter.name)).toEqual([
      'invitationId',
      'Idempotency-Key',
      'X-CSRF-Token',
      '__Host-csrf',
    ]);
    expect(orgPath.get?.description).toContain('current ADMIN Role');
    expect(orgPath.get?.description).toContain('organization.memberships.read');
    expect(orgPath.get).toMatchObject({
      'x-contract-status': 'USER_APPROVED',
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-permission': 'organization.memberships.read',
      'x-readiness-gates': [],
    });
    expect(orgPath.post?.description).toContain(
      'shared 30 committed invite/resend',
    );
    expect(orgPath.post?.description).toContain('encrypted delivery outbox');
    expect(orgPath.post?.description).toContain(
      'asynchronous email delivery can remain pending or retry',
    );
    expect(orgPath.post).toMatchObject({
      'x-contract-status': 'USER_APPROVED',
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-permission': 'organization.memberships.manage',
      'x-readiness-gates': [
        'A7_NOTIFICATION_CONTRACT_PROVIDER',
        'A8_COORDINATED_CUTOVER',
      ],
    });
    expect(orgPath.post?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/C02InviteMemberRequest',
          },
        },
      },
    });
    expect(
      orgPath.post?.parameters?.map((parameter) => parameter.name),
    ).toContain('Idempotency-Key');
    expect(resend.operationId).toBe('resendOrganizationMembershipInvitation');
    expect(cancel.operationId).toBe('cancelOrganizationMembershipInvitation');
    expect(suspend.operationId).toBe('suspendOrganizationMembership');
    expect(resend).toMatchObject({
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-readiness-gates': [
        'A7_NOTIFICATION_CONTRACT_PROVIDER',
        'A8_COORDINATED_CUTOVER',
      ],
    });
    expect(cancel).toMatchObject({
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-readiness-gates': ['A8_COORDINATED_CUTOVER'],
    });
    expect(suspend).toMatchObject({
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-permission': 'organization.memberships.manage',
      'x-readiness-gates': [],
    });
    expect(resend.parameters?.map((parameter) => parameter.name)).toContain(
      'Idempotency-Key',
    );
    expect(cancel.parameters?.map((parameter) => parameter.name)).toContain(
      'Idempotency-Key',
    );
    expect(
      contract.components.schemas.C02AcceptInvitationRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: ['expectedMembershipVersion', 'expectedInvitationVersion'],
      properties: {
        expectedMembershipVersion: { type: 'integer', minimum: 0 },
        expectedInvitationVersion: { type: 'integer', minimum: 1 },
      },
    });
    expect(
      contract.components.schemas.C02ResendInvitationRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: [
        'expectedMembershipVersion',
        'expectedInvitationVersion',
        'reasonCode',
      ],
      properties: {
        expectedMembershipVersion: { type: 'integer', minimum: 0 },
      },
    });
    expect(
      contract.components.schemas.C02CancelInvitationRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: [
        'expectedMembershipVersion',
        'expectedInvitationVersion',
        'reasonCode',
      ],
      properties: {
        expectedMembershipVersion: { type: 'integer', minimum: 0 },
      },
    });
    expect(
      JSON.stringify(contract.components.schemas.C02AcceptInvitationRequest),
    ).toContain('0 is the documented sentinel');
    expect(contract.components.schemas.C02MembershipMutationAck).toHaveProperty(
      'oneOf',
    );
    expect(
      contract.components.schemas.C02MembershipMutationAck.oneOf,
    ).toHaveLength(2);
    expect(suspend.parameters?.map((parameter) => parameter.name)).toContain(
      'Idempotency-Key',
    );
    expect(suspend.parameters?.map((parameter) => parameter.name)).toContain(
      '__Host-csrf',
    );
    expect(
      accept.parameters?.find(
        (parameter) => parameter.name === 'Idempotency-Key',
      )?.schema,
    ).toMatchObject({
      type: 'string',
      minLength: 16,
      maxLength: 128,
    });
    expect(
      contract.components.schemas.C02RecipientInvitation.properties,
    ).not.toHaveProperty('email');
    expect(
      contract.components.schemas.C02RecipientInvitation.properties,
    ).not.toHaveProperty('roleCode');
    expect(
      contract.components.schemas.C02RecipientInvitation.properties,
    ).not.toHaveProperty('targetUserId');
    expect(
      contract.paths[
        '/api/v1/iam/organizations/{organizationId}/invitations/{invitationId}'
      ]?.delete,
    ).toBeUndefined();
    expect(contract.components.schemas.C02InviteMemberRequest).toMatchObject({
      additionalProperties: false,
      required: ['email', 'reasonCode'],
    });
    expect(contract.components.schemas.C02MembershipMutationAck).toMatchObject({
      oneOf: [
        {
          additionalProperties: false,
          required: ['operationId', 'membership'],
        },
        {
          additionalProperties: false,
          required: ['operationId', 'invitation'],
        },
      ],
    });
    expect(
      contract.components.schemas.C02MembershipMutationState.properties,
    ).toMatchObject({
      status: {
        enum: ['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'],
      },
    });
  });

  it('documents the approved Organization role assignment contract exactly', () => {
    const membershipSummary = contract.components.schemas.C02MembershipSummary;
    expect(membershipSummary).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['roleCode', 'roleVersion']),
      properties: {
        roleCode: {
          oneOf: [
            { type: 'string', enum: ['ADMIN', 'MEMBER'] },
            { type: 'null' },
          ],
        },
        roleVersion: { type: 'integer', minimum: 0 },
      },
    });
    const operation =
      contract.paths[
        '/api/v1/iam/organizations/{organizationId}/memberships/{membershipId}/role'
      ]?.post;
    expect(operation?.operationId).toBe('setOrganizationMembershipRole');
    expect(operation).toMatchObject({
      'x-contract-status': 'USER_APPROVED',
      'x-runtime-status': 'IMPLEMENTED_BACKEND',
      'x-permission': 'organization.memberships.manage',
      'x-readiness-gates': [],
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    });
    expect(operation?.description).toContain(
      'Project role assignments remain independent',
    );
    expect(operation?.description).toContain(
      "requests targeting the caller's own Membership are denied with 403 (ROLE_SELF_CHANGE_FORBIDDEN)",
    );
    expect(operation?.description).toContain('last active ADMIN');
    expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining([
        'organizationId',
        'membershipId',
        'X-CSRF-Token',
        '__Host-csrf',
        'Idempotency-Key',
        'X-Request-Id',
      ]),
    );
    expect(operation?.requestBody).toMatchObject({
      required: true,
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/C02SetOrganizationRoleRequest',
          },
        },
      },
    });
    expect(operation?.responses['200']).toMatchObject({
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/C02OrganizationRoleMutationAck',
          },
        },
      },
    });
    for (const status of ['401', '403', '404', '409', '422', '500', '503']) {
      expect(operation?.responses[status]).toBeDefined();
    }
    expect(operation?.responses['409']?.description).toContain(
      'LAST_ELIGIBLE_ADMIN',
    );
    expect(
      contract.components.schemas.C02SetOrganizationRoleRequest,
    ).toMatchObject({
      additionalProperties: false,
      required: [
        'expectedMembershipVersion',
        'expectedRoleVersion',
        'roleCode',
        'reason',
      ],
      properties: {
        expectedMembershipVersion: { type: 'integer', minimum: 1 },
        expectedRoleVersion: { type: 'integer', minimum: 0 },
        roleCode: { enum: ['ADMIN', 'MEMBER'] },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          pattern: '\\S',
        },
      },
    });
    expect(
      contract.components.schemas.C02OrganizationRoleMutationAck,
    ).toMatchObject({
      additionalProperties: false,
      required: ['operationId', 'membership', 'role'],
    });
    expect(contract.components.schemas.C02OrganizationRoleState).toMatchObject({
      additionalProperties: false,
      required: ['roleCode', 'version'],
      properties: {
        roleCode: { enum: ['ADMIN', 'MEMBER'] },
        version: { type: 'integer', minimum: 1 },
      },
    });
  });

  it('documents a separate Platform login without Organization claims', () => {
    const login = contract.paths['/api/v1/auth/platform/login'].post!;
    expect(login.operationId).toBe('loginPlatform');
    expect(login.security).toEqual([]);
    expect(login.description).toContain('current approved PLATFORM assignment');
    expect(login.description).toContain('no Organization or role claims');
    expect(login.description).toContain(
      'rechecks current assignments on rotation',
    );
    expect(login.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PlatformLoginRequest' },
        },
      },
    });
    expect(login.responses['200']).toMatchObject({
      headers: { 'Set-Cookie': { schema: { type: 'string' } } },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/PlatformLoginResponse' },
        },
      },
    });
    expect(contract.components.schemas.PlatformLoginResponse).toMatchObject({
      required: ['context', 'user'],
      properties: {
        context: { const: 'PLATFORM' },
        user: { $ref: '#/components/schemas/PlatformLoginSubject' },
      },
    });
    expect(contract.components.schemas.PlatformLoginSubject).toMatchObject({
      required: ['id', 'email', 'name'],
    });
  });

  it('defines the closed A-02 refresh HTTP contract without JSON token fields', () => {
    const refresh = contract.paths['/api/v1/auth/refresh'].post!;
    expect(refresh['x-contract-status']).toBe('implemented-backend-a-02');
    expect(refresh.requestBody).toBeUndefined();
    expect(refresh.security).toEqual([{ refreshCookie: [] }]);
    expect(contract.components.securitySchemes).toMatchObject({
      refreshCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: '__Secure-refresh',
      },
    });
    expect(refresh.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-CSRF-Token',
          in: 'header',
          required: true,
        }),
      ]),
    );
    expect(refresh.responses['401']).toBeDefined();
    expect(refresh.responses['200']).toMatchObject({
      headers: {
        'Set-Cookie': { schema: { type: 'string' } },
        'Cache-Control': { schema: { const: 'no-store' } },
      },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/RefreshResponse' },
        },
      },
    });
    expect(refresh.responses['401']).toEqual({
      $ref: '#/components/responses/RefreshInvalid',
    });
    expect(refresh.responses['403']).toEqual({
      $ref: '#/components/responses/RefreshCsrfInvalid',
    });
    expect(refresh.responses['500']).toEqual({
      $ref: '#/components/responses/RefreshFailed',
    });
    expect(contract.components.schemas.RefreshResponse).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['status'],
      properties: { status: { type: 'string', const: 'refreshed' } },
    });
    const refreshResponse = JSON.stringify(refresh.responses['200']);
    expect(refreshResponse).toContain('continuum_access');
    expect(refreshResponse).toContain('__Secure-refresh');
    expect(refreshResponse).toContain('Path=/api/v1/auth');
    expect(refreshResponse).toContain('comma-joined');
    expect(refreshResponse).not.toContain('accessToken');
    expect(refreshResponse).not.toContain('refreshToken');
    expect(contract.components.schemas).not.toHaveProperty('AuthSession');
    expect(contract.components.schemas).not.toHaveProperty('TokenPair');
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

  it('documents the bounded request trace API as an audit-backed safe projection', () => {
    const operation =
      contract.paths['/api/v1/iam/platform/diagnostics/traces/{requestId}'].get;
    expect(operation?.operationId).toBe('findPlatformRequestTrace');
    expect(operation?.['x-platform-permission']).toBe(
      'platform.diagnostics.trace.read',
    );
    expect(operation?.responses['200']).toBeDefined();
    expect(operation?.responses['404']).toBeDefined();
    expect(operation?.responses['503']).toBeDefined();
    expect(operation?.description).toMatch(/at most 50/i);
    expect(operation?.description).toMatch(/raw application logs/i);
    expect(contract.components.schemas.PlatformRequestTrace).toMatchObject({
      additionalProperties: false,
      required: ['requestId', 'events', 'truncated'],
    });
  });

  it('documents incident workflows, optimistic concurrency, redaction, and audit filters', () => {
    const operationsToCheck = [
      {
        path: '/api/v1/iam/platform/incidents',
        method: 'get',
        permission: 'platform.incidents.incident.read',
        status: '200',
      },
      {
        path: '/api/v1/iam/platform/incidents',
        method: 'post',
        permission: 'platform.incidents.incident.manage',
        status: '201',
      },
      {
        path: '/api/v1/iam/platform/incidents/{incidentId}',
        method: 'get',
        permission: 'platform.incidents.incident.read',
        status: '200',
      },
      {
        path: '/api/v1/iam/platform/incidents/{incidentId}/history',
        method: 'get',
        permission: 'platform.incidents.incident.read',
        status: '200',
      },
      {
        path: '/api/v1/iam/platform/incidents/{incidentId}/acknowledge',
        method: 'post',
        permission: 'platform.incidents.incident.manage',
        status: '200',
      },
      {
        path: '/api/v1/iam/platform/incidents/{incidentId}/resolve',
        method: 'post',
        permission: 'platform.incidents.incident.manage',
        status: '200',
      },
      {
        path: '/api/v1/iam/platform/incidents/{incidentId}/notes',
        method: 'post',
        permission: 'platform.incidents.incident.manage',
        status: '200',
      },
    ] as const;

    for (const { path, method, permission, status } of operationsToCheck) {
      const operation = contract.paths[path][method];
      expect(operation?.['x-platform-permission']).toBe(permission);
      expect(operation?.responses[status]).toBeDefined();
      expect(operation?.responses['401']).toBeDefined();
      expect(operation?.responses['403']).toBeDefined();
      expect(operation?.responses['503']).toBeDefined();
    }

    const createRequest =
      contract.components.schemas.PlatformIncidentCreateRequest;
    expect(createRequest).toMatchObject({
      additionalProperties: false,
      required: ['title', 'severity', 'affectedServiceId'],
    });
    const actionRequest =
      contract.components.schemas.PlatformIncidentActionRequest;
    expect(actionRequest).toMatchObject({
      additionalProperties: false,
      required: ['expectedVersion', 'note'],
    });
    expect(
      JSON.stringify(
        contract.paths['/api/v1/iam/platform/incidents/{incidentId}/notes']
          ?.post,
      ),
    ).toMatch(/redact/i);
    expect(contract.components.schemas.PlatformAuditAction.enum).toEqual(
      expect.arrayContaining([
        'platform.incident.created',
        'platform.incident.acknowledged',
        'platform.incident.resolved',
        'platform.incident.note.added',
      ]),
    );
    expect(
      contract.components.schemas.PlatformAuditResourceType.enum,
    ).toContain('INCIDENT');
  });

  it('resolves every local reference', () => {
    const references = JSON.stringify(contract).match(/#\/components\/[^"]+/g);

    for (const reference of new Set(references ?? [])) {
      expect(resolveLocalReference(contract, reference)).toBeDefined();
    }
  });

  it('documents Platform profile edit and archive with CAS, permission, and retained lifecycle semantics', () => {
    const userPath = contract.paths['/api/v1/iam/platform/users/{userId}'];
    const profileEdit = userPath.patch;
    const archive =
      contract.paths['/api/v1/iam/platform/users/{userId}/archive'].post;
    const profileRequest =
      contract.components.schemas.PlatformUserProfileChangeRequest;
    const archiveRequest =
      contract.components.schemas.PlatformUserArchiveRequest;
    const userSummary = contract.components.schemas.PlatformUserSummary;
    const auditEvent = contract.components.schemas.PlatformAuditAction;
    const usersStatusFilter = contract.paths[
      '/api/v1/iam/platform/users'
    ].get?.parameters?.find((parameter) => parameter.name === 'status');

    expect(profileEdit).toMatchObject({
      operationId: 'updatePlatformUserProfile',
      'x-platform-permission': 'platform.users.account.manage',
    });
    expect(profileEdit?.description).toMatch(/PLATFORM scope/i);
    expect(profileEdit?.responses['200']).toBeDefined();
    expect(profileEdit?.responses['409']).toBeDefined();
    expect(profileRequest).toMatchObject({
      additionalProperties: false,
      required: ['expectedUpdatedAt'],
    });
    expect(Object.keys(profileRequest.properties as JsonObject).sort()).toEqual(
      ['avatarUrl', 'expectedUpdatedAt', 'fullName'].sort(),
    );
    expect(archive).toMatchObject({
      operationId: 'archivePlatformUser',
      'x-platform-permission': 'platform.users.account.manage',
    });
    expect(archive?.description).toContain('does not delete');
    expect(archive?.description).toContain('retains Organization memberships');
    expect(archiveRequest).toMatchObject({
      additionalProperties: false,
      required: ['expectedUpdatedAt', 'reasonCode'],
    });
    expect(userSummary.required).toEqual(
      expect.arrayContaining(['avatarUrl', 'archivedAt']),
    );
    expect(usersStatusFilter?.schema).toMatchObject({
      $ref: '#/components/schemas/PlatformUserListStatus',
    });
    expect(contract.components.schemas.PlatformUserListStatus.enum).toContain(
      'ARCHIVED',
    );
    expect(auditEvent.enum).toEqual(
      expect.arrayContaining([
        'platform.user.profile.updated',
        'platform.user.archived',
      ]),
    );
  });

  it('documents every runtime PlatformController route and method', () => {
    const prefix = String(
      Reflect.getMetadata(PATH_METADATA, PlatformController),
    );
    const methodNames = new Map<number, keyof OpenApiPathItem>([
      [RequestMethod.GET, 'get'],
      [RequestMethod.POST, 'post'],
      [RequestMethod.PATCH, 'patch'],
      [RequestMethod.PUT, 'put'],
      [RequestMethod.DELETE, 'delete'],
    ]);
    const prototype = PlatformController.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (
        typeof handler !== 'function' ||
        !Reflect.hasMetadata(PATH_METADATA, handler)
      )
        continue;
      const routePaths = Reflect.getMetadata(PATH_METADATA, handler);
      const paths = typeof routePaths === 'string' ? [routePaths] : routePaths;
      const method = methodNames.get(
        Reflect.getMetadata(METHOD_METADATA, handler) as number,
      );
      expect(method).toBeDefined();
      for (const routePath of paths as string[]) {
        const openApiPath = `/api/v1/${prefix}/${routePath.replace(/:([A-Za-z0-9]+)/g, '{$1}')}`;
        if (!contract.paths[openApiPath]?.[method!])
          throw new Error(
            `Missing OpenAPI operation: ${method} ${openApiPath}`,
          );
      }
    }
  });

  it('does not leave Platform OpenAPI operations without a runtime controller route', () => {
    const methodNames = new Map<string, RequestMethod>([
      ['get', RequestMethod.GET],
      ['post', RequestMethod.POST],
      ['patch', RequestMethod.PATCH],
      ['put', RequestMethod.PUT],
      ['delete', RequestMethod.DELETE],
    ]);
    const runtimeRoutes = new Set<string>();
    const prefix = String(
      Reflect.getMetadata(PATH_METADATA, PlatformController),
    );
    const prototype = PlatformController.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const handler = prototype[name];
      if (
        typeof handler !== 'function' ||
        !Reflect.hasMetadata(PATH_METADATA, handler)
      )
        continue;
      const routePaths = Reflect.getMetadata(PATH_METADATA, handler);
      const paths = typeof routePaths === 'string' ? [routePaths] : routePaths;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      for (const routePath of paths as string[]) {
        runtimeRoutes.add(
          `${method}:${`/api/v1/${prefix}/${routePath.replace(/:([A-Za-z0-9]+)/g, '{$1}')}`}`,
        );
      }
    }
    for (const [path, pathItem] of Object.entries(contract.paths)) {
      if (!path.startsWith('/api/v1/iam/platform/')) continue;
      for (const [method, requestMethod] of methodNames) {
        if (!pathItem[method as keyof OpenApiPathItem]) continue;
        expect(runtimeRoutes).toContain(`${requestMethod}:${path}`);
      }
    }
  });

  it('contains no environment URI or credential example', () => {
    expect(contract).not.toHaveProperty('servers');

    const loginRequest = contract.components.schemas.LoginRequest;
    const loginProperties = loginRequest.properties as JsonObject;
    expect(loginProperties.password).not.toHaveProperty('example');
    expect(loginProperties.password).not.toHaveProperty('default');

    expect(JSON.stringify(contract)).not.toContain('refreshToken');
  });
});
