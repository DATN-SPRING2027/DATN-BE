import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo, Server } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { GatewayIamController } from '../src/gateway/gateway-iam.controller';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { OrganizationMembershipCommandService } from '../src/services/iam/application/organizations/organization-membership-command.service';
import { OrganizationMembershipCommandController } from '../src/services/iam/controllers/organization-membership-command.controller';

describe('Gateway to IAM Organization role assignment over HTTP', () => {
  const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
  const membershipId = '651a2b3c4d5e6f7a8b9c0d20';
  const actor = {
    id: '651a2b3c4d5e6f7a8b9c0d1e',
    email: 'admin@example.test',
    name: 'Admin',
    organizationId,
    roles: ['ADMIN'],
  };
  const auth = { getCurrentIdentity: jest.fn() };
  const commands = { execute: jest.fn() };
  let gateway: INestApplication;
  let iam: INestApplication;

  beforeAll(async () => {
    const iamModule = await Test.createTestingModule({
      controllers: [OrganizationMembershipCommandController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: auth },
        {
          provide: OrganizationMembershipCommandService,
          useValue: commands,
        },
      ],
    }).compile();
    iam = iamModule.createNestApplication();
    configureApplication(iam);
    iam.setGlobalPrefix('internal');
    await iam.listen(0, '127.0.0.1');
    const address = (iam.getHttpServer() as Server).address() as AddressInfo;

    const gatewayModule = await Test.createTestingModule({
      controllers: [GatewayIamController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: (name: string) =>
              name === 'IAM_SERVICE_URL'
                ? `http://127.0.0.1:${address.port}`
                : name === 'IAM_GATEWAY_SECRET'
                  ? 'gateway-test-secret-at-least-thirty-two-characters'
                  : 5000,
          },
        },
      ],
    }).compile();
    gateway = gatewayModule.createNestApplication();
    configureApplication(gateway);
    await gateway.init();
  });

  afterAll(async () => {
    await gateway?.close();
    await iam?.close();
  });

  beforeEach(() => {
    jest.resetAllMocks();
    auth.getCurrentIdentity.mockResolvedValue(actor);
    commands.execute.mockResolvedValue({
      httpStatus: 200,
      replayed: false,
      body: {
        operationId: '751a2b3c4d5e6f7a8b9c0d1f',
        membership: {
          id: membershipId,
          organizationId,
          userId: '851a2b3c4d5e6f7a8b9c0d1f',
          status: 'ACTIVE',
          version: 3,
        },
        role: { roleCode: 'ADMIN', version: 1 },
      },
    });
  });

  it('forwards the public role route and authenticated mutation to the IAM command controller', async () => {
    const idempotencyKey = 'org-role-operation-00000001';
    const correlationId = 'role-request-0001';
    const body = {
      expectedMembershipVersion: 3,
      expectedRoleVersion: 0,
      roleCode: 'ADMIN',
      reason: 'Approved access review',
    };

    const response = await request(gateway.getHttpServer() as App)
      .post(
        `/api/v1/iam/organizations/${organizationId}/memberships/${membershipId}/role`,
      )
      .set('Authorization', 'Bearer account-token')
      .set('Cookie', '__Host-csrf=csrf-token; continuum_access=access-token')
      .set('X-CSRF-Token', 'csrf-token')
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Request-Id', correlationId)
      .send(body)
      .expect(200);

    expect(auth.getCurrentIdentity).toHaveBeenCalledWith(
      'Bearer account-token',
      '__Host-csrf=csrf-token; continuum_access=access-token',
    );
    expect(commands.execute).toHaveBeenCalledWith(
      actor,
      organizationId,
      idempotencyKey,
      {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId,
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'ADMIN',
        reason: 'Approved access review',
      },
      correlationId,
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      membership: { id: membershipId, organizationId, status: 'ACTIVE' },
      role: { roleCode: 'ADMIN', version: 1 },
    });
  });
});
