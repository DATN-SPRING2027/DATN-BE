import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo, Server } from 'node:net';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { GatewayIamController } from '../src/gateway/gateway-iam.controller';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import { ORGANIZATION_MEMBERSHIP_READ_REPOSITORY } from '../src/services/iam/application/organizations/organization-membership-read.repository';
import { OrganizationMembershipReadService } from '../src/services/iam/application/organizations/organization-membership-read.service';
import { OrganizationMembershipReadController } from '../src/services/iam/controllers/organization-membership-read.controller';

describe('Gateway to IAM membership reads over HTTP', () => {
  const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
  const membershipId = '651a2b3c4d5e6f7a8b9c0d20';
  const path = `/api/v1/iam/organizations/${organizationId}/memberships`;
  const actor = { id: '651a2b3c4d5e6f7a8b9c0d1e', organizationId };
  const auth = { getCurrentIdentity: jest.fn() };
  const repository = {
    hasReadAccess: jest.fn(),
    list: jest.fn(),
    find: jest.fn(),
  };
  let gateway: INestApplication;
  let iam: INestApplication;

  beforeAll(async () => {
    const iamModule = await Test.createTestingModule({
      controllers: [OrganizationMembershipReadController],
      providers: [
        OrganizationMembershipReadService,
        { provide: AuthenticationApplicationService, useValue: auth },
        {
          provide: ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
          useValue: repository,
        },
      ],
    }).compile();
    iam = iamModule.createNestApplication();
    configureApplication(iam);
    iam.setGlobalPrefix('internal');
    await iam.listen(0, '127.0.0.1');
    const address = (iam.getHttpServer() as Server).address() as AddressInfo;
    const module = await Test.createTestingModule({
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
    gateway = module.createNestApplication();
    configureApplication(gateway);
    await gateway.init();
  });
  afterAll(async () => {
    await gateway?.close();
    await iam?.close();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    auth.getCurrentIdentity.mockImplementation((authorization, cookie) => {
      if (!authorization && !cookie)
        throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED' });
      return actor;
    });
    repository.hasReadAccess.mockResolvedValue(true);
    repository.list.mockResolvedValue({ data: [], totalItems: 0 });
    repository.find.mockResolvedValue(null);
  });

  it('forwards the list query, credentials and no-store response', async () => {
    const response = await request(gateway.getHttpServer() as App)
      .get(`${path}?page=2&pageSize=5&status=REMOVED`)
      .set('Authorization', 'Bearer fixture')
      .set('Cookie', 'continuum_access=fixture')
      .expect(200);
    expect(auth.getCurrentIdentity).toHaveBeenCalledWith(
      'Bearer fixture',
      'continuum_access=fixture',
    );
    expect(repository.list).toHaveBeenCalledWith(organizationId, {
      page: 2,
      pageSize: 5,
      status: 'REMOVED',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      data: [],
      pagination: { page: 2, pageSize: 5, totalItems: 0, totalPages: 0 },
    });
  });

  it('forwards scoped detail and preserves the IAM missing-member error', async () => {
    const response = await request(gateway.getHttpServer() as App)
      .get(`${path}/${membershipId}`)
      .set('Cookie', 'continuum_access=fixture')
      .expect(404);
    expect(repository.find).toHaveBeenCalledWith(organizationId, membershipId);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND',
    });
  });

  it('preserves permission denial without invoking the list query', async () => {
    repository.hasReadAccess.mockResolvedValue(false);
    await request(gateway.getHttpServer() as App)
      .get(path)
      .set('Authorization', 'Bearer fixture')
      .expect(403);
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('reaches IAM authentication instead of hiding the route behind a 404', async () => {
    await request(gateway.getHttpServer() as App)
      .get(path)
      .expect(401);
    expect(repository.hasReadAccess).not.toHaveBeenCalled();
  });

  it('does not expose account self-service Organization provisioning', async () => {
    await request(gateway.getHttpServer() as App)
      .post('/api/v1/iam/organizations')
      .send({
        name: 'Unapproved Organization',
        slug: 'unapproved-organization',
      })
      .expect(404);
  });
});
