import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../bootstrap';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { OrganizationMembershipReadService } from '../application/organizations/organization-membership-read.service';
import { ORGANIZATION_MEMBERSHIP_READ_REPOSITORY } from '../application/organizations/organization-membership-read.repository';
import { OrganizationMembershipReadController } from './organization-membership-read.controller';

describe('C-02 membership read HTTP contract', () => {
  const actor = {
    id: '651a2b3c4d5e6f7a8b9c0d1e',
    organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
    email: 'admin@example.test',
    name: 'Admin',
    roles: ['ADMIN'],
  };
  const member = {
    id: '651a2b3c4d5e6f7a8b9c0d20',
    organizationId: actor.organizationId,
    userId: actor.id,
    status: 'REMOVED',
    version: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    user: null,
  };
  const auth = { getCurrentIdentity: jest.fn() };
  const repository = {
    hasReadAccess: jest.fn(),
    list: jest.fn(),
    find: jest.fn(),
  };
  const url = `/api/v1/iam/organizations/${actor.organizationId}/memberships`;
  let app: INestApplication;
  function get(path = url) {
    return request(app.getHttpServer() as App)
      .get(path)
      .set('Authorization', 'Bearer fixture');
  }
  beforeAll(async () => {
    const module = await Test.createTestingModule({
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
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    auth.getCurrentIdentity.mockImplementation((authorization, cookie) => {
      if (!authorization && !cookie)
        throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED' });
      return actor;
    });
    repository.hasReadAccess.mockResolvedValue(true);
    repository.list.mockResolvedValue({ data: [member], totalItems: 1 });
    repository.find.mockResolvedValue(member);
  });
  it('returns membership states, null references, pagination and no-store', async () => {
    const response = await get().expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      data: [member],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });
    expect(repository.list).toHaveBeenCalledWith(actor.organizationId, {
      page: 1,
      pageSize: 20,
    });
  });
  it.each(['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'])(
    'accepts the single %s membership filter',
    async (status) => {
      await get(`${url}?page=2&pageSize=100&status=${status}`).expect(200);
      expect(repository.list).toHaveBeenCalledWith(actor.organizationId, {
        page: 2,
        pageSize: 100,
        status,
      });
    },
  );
  it('returns a zero-count empty page', async () => {
    repository.list.mockResolvedValue({ data: [], totalItems: 0 });
    const response = await get().expect(200);
    expect(response.body).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });
  });
  it.each([
    'page=0',
    'page=-1',
    'page=1.1',
    'page=9007199254740992',
    'page=9007199254740991&pageSize=100',
    'pageSize=101',
    'status=INACTIVE',
    'status=ACTIVE&status=REMOVED',
    'roleCode=ADMIN',
    'sort=createdAt',
    'userId=ignored',
  ])('rejects invalid or unknown query %s', async (query) => {
    const response = await get(`${url}?${query}`).expect(422);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('authenticates before validation and database reads', async () => {
    await request(app.getHttpServer() as App)
      .get(`${url}?page=invalid`)
      .expect(401);
    expect(repository.hasReadAccess).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('does not authorize from ADMIN JWT claims or manage alone', async () => {
    repository.hasReadAccess.mockResolvedValue(false);
    const response = await get(`${url}?page=invalid`).expect(403);
    expect((response.body as { code: string }).code).toBe(
      'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
    );
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('uses current evidence even when JWT roles are stale', async () => {
    auth.getCurrentIdentity.mockReturnValue({ ...actor, roles: ['MEMBER'] });
    await get().expect(200);
    expect(repository.hasReadAccess).toHaveBeenCalledWith(
      actor.organizationId,
      actor.id,
    );
  });
  it('denies another selected Organization without querying its records', async () => {
    await get(url.replace(actor.organizationId, member.id)).expect(403);
    expect(repository.hasReadAccess).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });
  it('normalizes uppercase ObjectIds', async () => {
    await get(
      `${url.toUpperCase().replace('/API/V1/IAM/ORGANIZATIONS/', '/api/v1/iam/organizations/').replace('/MEMBERSHIPS', '/memberships')}/${member.id.toUpperCase()}`,
    ).expect(200);
    expect(repository.find).toHaveBeenCalledWith(
      actor.organizationId,
      member.id,
    );
  });
  it('returns the scoped detail with no-store', async () => {
    const response = await get(`${url}/${member.id}`).expect(200);
    expect(response.body).toEqual(member);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('maps absent or foreign detail to the same 404', async () => {
    repository.find.mockResolvedValue(null);
    const response = await get(`${url}/${member.id}`).expect(404);
    expect((response.body as { code: string }).code).toBe(
      'ORGANIZATION_MEMBERSHIP_NOT_FOUND',
    );
  });
  it.each([
    `${url}/bad`,
    `${url}/${member.id}?page=1`,
    `${url.replace(actor.organizationId, 'bad')}`,
  ])(
    'rejects invalid detail/Organization IDs or detail query %s',
    async (path) => {
      await get(path).expect(422);
      expect(repository.find).not.toHaveBeenCalled();
      expect(repository.list).not.toHaveBeenCalled();
    },
  );
});
