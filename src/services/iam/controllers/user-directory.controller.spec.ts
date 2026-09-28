import {
  ForbiddenException,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { UserDirectoryService } from '../application/users/user-directory.service';
import { UserDirectoryController } from './user-directory.controller';

describe('UserDirectoryController', () => {
  let app: INestApplication;
  const actor = {
    id: '651a2b3c4d5e6f7a8b9c0d1e',
    organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
    roles: ['ADMIN'],
  };
  const user = {
    id: '651a2b3c4d5e6f7a8b9c0d20',
    email: 'member@example.com',
    fullName: 'Member',
    status: 'ACTIVE',
    roleCodes: ['MEMBER'],
  };
  const auth = { getCurrentIdentity: jest.fn() };
  const directory = { list: jest.fn(), get: jest.fn(), update: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UserDirectoryController],
      providers: [
        { provide: AuthenticationApplicationService, useValue: auth },
        { provide: UserDirectoryService, useValue: directory },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    auth.getCurrentIdentity.mockImplementation((authorization, cookie) => {
      if (!authorization && !cookie) throw new UnauthorizedException();
      return actor;
    });
    directory.list.mockResolvedValue({
      data: [user],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });
    directory.get.mockResolvedValue(user);
    directory.update.mockResolvedValue({ ...user, fullName: 'Renamed' });
  });

  it('lists with pagination and filters using the cookie identity', async () => {
    const response = await request(app.getHttpServer() as App)
      .get('/api/v1/iam/users?page=1&pageSize=20&status=ACTIVE&roleCode=MEMBER')
      .set('Cookie', 'continuum_access=session')
      .expect(200);
    expect((response.body as { data: unknown }).data).toEqual([user]);
    expect(auth.getCurrentIdentity).toHaveBeenCalledWith(
      undefined,
      'continuum_access=session',
    );
    expect(directory.list).toHaveBeenCalledWith(actor, {
      page: 1,
      pageSize: 20,
      status: 'ACTIVE',
      roleCode: 'MEMBER',
    });
  });

  it('reads and updates a user through the documented route', async () => {
    const server = app.getHttpServer() as App;
    await request(server)
      .get(`/api/v1/iam/users/${user.id}`)
      .set('Cookie', 'continuum_access=session')
      .expect(200);
    await request(server)
      .patch(`/api/v1/iam/users/${user.id}`)
      .set('Cookie', 'continuum_access=session')
      .send({ fullName: 'Renamed' })
      .expect(200);
    expect(directory.get).toHaveBeenCalledWith(actor, user.id);
    expect(directory.update).toHaveBeenCalledWith(actor, user.id, {
      fullName: 'Renamed',
    });
  });

  it('rejects malformed pagination, IDs and patch bodies with 422', async () => {
    const server = app.getHttpServer() as App;
    await request(server)
      .get('/api/v1/iam/users?page=0')
      .set('Cookie', 'continuum_access=session')
      .expect(422);
    await request(server)
      .get('/api/v1/iam/users/not-an-id')
      .set('Cookie', 'continuum_access=session')
      .expect(422);
    await request(server)
      .patch(`/api/v1/iam/users/${user.id}`)
      .set('Cookie', 'continuum_access=session')
      .send({ email: 'injected@example.com' })
      .expect(422);
    expect(directory.update).not.toHaveBeenCalled();
  });

  it('preserves authorization failures from the application boundary', async () => {
    directory.list.mockRejectedValue(new ForbiddenException());
    await request(app.getHttpServer() as App)
      .get('/api/v1/iam/users')
      .set('Cookie', 'continuum_access=session')
      .expect(403);
  });

  it('requires an authenticated session', async () => {
    await request(app.getHttpServer() as App)
      .get('/api/v1/iam/users')
      .expect(401);
    expect(directory.list).not.toHaveBeenCalled();
  });
});
