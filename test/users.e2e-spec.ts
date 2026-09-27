import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { configureApplication } from '../src/bootstrap';
import { AuthenticationApplicationService } from '../src/services/iam/application/authentication/authentication.application.service';
import {
  USER_DIRECTORY_REPOSITORY,
  type UserDirectoryRepository,
  type UserRecord,
} from '../src/services/iam/application/users/user-directory.repository';
import { UserDirectoryService } from '../src/services/iam/application/users/user-directory.service';
import { UserDirectoryController } from '../src/services/iam/controllers/user-directory.controller';

const adminId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const memberId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const otherId = 'cccccccccccccccccccccccc';
const organizationId = 'dddddddddddddddddddddddd';

function user(id: string, roleCodes: string[]): UserRecord {
  return {
    id,
    email: `${id[0]}@example.test`,
    fullName: `${id[0]} User`,
    avatarUrl: null,
    status: 'ACTIVE',
    roleCodes,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('User directory (e2e)', () => {
  let app: INestApplication;
  let users: UserRecord[];
  const repository: UserDirectoryRepository = {
    isAdmin: (_org, actorId) => Promise.resolve(actorId === adminId),
    list: (_org, query) => {
      const filtered = users.filter(
        (item) =>
          (!query.status || item.status === query.status) &&
          (!query.roleCode || item.roleCodes.includes(query.roleCode)),
      );
      return Promise.resolve({
        data: filtered.slice(
          (query.page - 1) * query.pageSize,
          query.page * query.pageSize,
        ),
        totalItems: filtered.length,
      });
    },
    find: (_org, userId) =>
      Promise.resolve(users.find((item) => item.id === userId) ?? null),
    update: (_org, userId, changes) => {
      const index = users.findIndex((item) => item.id === userId);
      if (index < 0) return Promise.resolve(null);
      users[index] = { ...users[index], ...changes };
      return Promise.resolve(users[index]);
    },
    countActiveAdmins: () =>
      Promise.resolve(
        users.filter(
          (item) =>
            item.status === 'ACTIVE' && item.roleCodes.includes('ADMIN'),
        ).length,
      ),
  };
  const auth = {
    getCurrentIdentity: jest.fn(
      (_authorization: string | undefined, cookie: string | undefined) => {
        const actorId = cookie?.includes('continuum_access=admin')
          ? adminId
          : cookie?.includes('continuum_access=member')
            ? memberId
            : null;
        if (!actorId) throw new UnauthorizedException();
        return Promise.resolve({
          id: actorId,
          email: `${actorId[0]}@example.test`,
          name: `${actorId[0]} User`,
          organizationId,
          roles: actorId === adminId ? ['ADMIN'] : ['MEMBER'],
        });
      },
    ),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UserDirectoryController],
      providers: [
        UserDirectoryService,
        { provide: USER_DIRECTORY_REPOSITORY, useValue: repository },
        { provide: AuthenticationApplicationService, useValue: auth },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    users = [user(adminId, ['ADMIN']), user(memberId, ['MEMBER'])];
    auth.getCurrentIdentity.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists, reads and updates an organization user through HTTP', async () => {
    const server = app.getHttpServer() as App;
    const list = await request(server)
      .get('/api/v1/iam/users?page=1&pageSize=20&roleCode=MEMBER')
      .set('Cookie', 'continuum_access=admin')
      .expect(200);
    const listBody = list.body as {
      data: UserRecord[];
      pagination: { totalItems: number };
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].id).toBe(memberId);
    expect(listBody.pagination.totalItems).toBe(1);

    const detail = await request(server)
      .get(`/api/v1/iam/users/${memberId}`)
      .set('Cookie', 'continuum_access=admin')
      .expect(200);
    expect((detail.body as UserRecord).fullName).toBe('b User');

    const updated = await request(server)
      .patch(`/api/v1/iam/users/${memberId}`)
      .set('Cookie', 'continuum_access=admin')
      .send({ fullName: 'Updated Member', status: 'SUSPENDED' })
      .expect(200);
    expect(updated.body).toMatchObject({
      id: memberId,
      fullName: 'Updated Member',
      status: 'SUSPENDED',
    });
  });

  it('enforces authentication, admin scope, validation and last-admin protection', async () => {
    const server = app.getHttpServer() as App;
    await request(server).get('/api/v1/iam/users').expect(401);
    await request(server)
      .get('/api/v1/iam/users')
      .set('Cookie', 'continuum_access=member')
      .expect(403);
    await request(server)
      .get('/api/v1/iam/users?pageSize=101')
      .set('Cookie', 'continuum_access=admin')
      .expect(422);
    await request(server)
      .patch(`/api/v1/iam/users/${adminId}`)
      .set('Cookie', 'continuum_access=admin')
      .send({ status: 'SUSPENDED' })
      .expect(403);

    users = [user(otherId, ['ADMIN'])];
    await request(server)
      .patch(`/api/v1/iam/users/${otherId}`)
      .set('Cookie', 'continuum_access=admin')
      .send({ status: 'SUSPENDED' })
      .expect(409);
    users.unshift(user(adminId, ['ADMIN']));
    await request(server)
      .patch(`/api/v1/iam/users/${otherId}`)
      .set('Cookie', 'continuum_access=admin')
      .send({ status: 'SUSPENDED' })
      .expect(200);
  });
});
