import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import mongoose, { Types, type Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../../bootstrap';
import { AccessTokenService } from '../../application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from '../../application/authentication/auth-security.store';
import { AuthenticationApplicationService } from '../../application/authentication/authentication.application.service';
import { AUTHENTICATION_REPOSITORY } from '../../application/authentication/authentication.repository';
import { LOGIN_ELIGIBILITY_POLICY } from '../../application/authentication/login-eligibility.policy';
import { MembershipOrganizationContextResolver } from '../../application/authentication/membership-organization-context.resolver';
import { ORGANIZATION_CONTEXT_RESOLVER } from '../../application/authentication/organization-context.resolver';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from '../../application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { PasswordCredentialService } from '../../application/credentials/password-credential.service';
import {
  ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipSummary,
} from '../../application/organizations/organization-membership-read.repository';
import { OrganizationMembershipReadService } from '../../application/organizations/organization-membership-read.service';
import { OrganizationMembershipReadController } from '../../controllers/organization-membership-read.controller';
import { IAM_PERSISTENCE } from '../persistence';
import { AuthenticationRepository } from './authentication.repository';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipReadRepository } from './organization-membership-read.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const collections = [
  'users',
  'refresh_sessions',
  'organization_memberships',
  'roles',
  'role_assignments',
];
const marker = 'datn-87-membership-reads-mongo7-disposable';
function page(response: { body: unknown }) {
  return response.body as {
    data: OrganizationMembershipSummary[];
    pagination: {
      page: number;
      pageSize: number;
      totalItems: number;
      totalPages: number;
    };
  };
}

integration('C-02 membership reads on disposable MongoDB 7', () => {
  const databaseName = `datn87reads_${randomUUID().replaceAll('-', '')}`;
  const actorId = new Types.ObjectId();
  const organizationId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const actorMembershipId = new Types.ObjectId();
  const memberIds = ORGANIZATION_MEMBERSHIP_STATUSES.map(
    () => new Types.ObjectId(),
  );
  const memberUserIds = memberIds.map(() => new Types.ObjectId());
  const foreignMembershipId = new Types.ObjectId();
  const foreignOrganizationId = new Types.ObjectId();
  const secret = randomBytes(32).toString('hex');
  const actorSessionId = randomUUID();
  const url = `/api/v1/iam/organizations/${String(organizationId)}/memberships`;
  let connection: Connection | undefined;
  let app: INestApplication | undefined;
  let token: string;
  function get(path = url, credential = token) {
    return request(app!.getHttpServer() as App)
      .get(path)
      .set('Authorization', `Bearer ${credential}`);
  }
  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri))
      throw new Error(
        'C-02 read integration requires an explicit loopback fixture URI',
      );
    connection = mongoose.createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    await connection.asPromise();
    const hello = await connection.db!.admin().command({ hello: 1 });
    const build = await connection.db!.admin().command({ buildInfo: 1 });
    const fixture = await connection
      .useDb('admin')
      .collection<{ _id: string }>('datn_migration_test_fixture')
      .findOne({ _id: marker });
    if (!hello.setName || !String(build.version).startsWith('7.') || !fixture)
      throw new Error(
        'C-02 read integration requires a marked disposable MongoDB 7 replica set',
      );
    for (const name of collections) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (row) => row.name === name,
      )!;
      await connection
        .model(`continuum_iam_${name}`, createCollectionSchema(definition))
        .createIndexes();
    }
    const authentication = new AuthenticationRepository(connection);
    const module = await Test.createTestingModule({
      controllers: [OrganizationMembershipReadController],
      providers: [
        OrganizationMembershipReadService,
        AuthenticationApplicationService,
        AccessTokenService,
        AuthorizationPolicy,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: AUTHENTICATION_REPOSITORY, useValue: authentication },
        {
          provide: ORGANIZATION_CONTEXT_RESOLVER,
          useValue: new MembershipOrganizationContextResolver(authentication),
        },
        {
          provide: AUTHORIZATION_EVIDENCE_PROVIDER,
          useValue: new MongoAuthorizationEvidenceProvider(connection),
        },
        {
          provide: ORGANIZATION_MEMBERSHIP_READ_REPOSITORY,
          useValue: new MongoOrganizationMembershipReadRepository(connection),
        },
        { provide: LOGIN_ELIGIBILITY_POLICY, useValue: {} },
        { provide: PasswordCredentialService, useValue: {} },
        {
          provide: AUTH_SECURITY_STORE,
          useValue: { isTokenRevoked: () => Promise.resolve(false) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
    token = app.get(AccessTokenService).signAccessToken({
      sub: actorId.toHexString(),
      email: 'admin@example.test',
      orgId: organizationId.toHexString(),
      roles: ['ADMIN'],
      sid: actorSessionId,
    });
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    if (connection?.readyState === mongoose.ConnectionStates.connected) {
      if (
        connection.name !== databaseName ||
        !/^datn87reads_[a-f\d]{32}$/.test(databaseName)
      )
        throw new Error('Disposable database identity changed');
      await connection.dropDatabase();
    }
    await connection?.close();
  });
  beforeEach(async () => {
    for (const name of collections)
      await connection!.collection(name).deleteMany({});
    const time = new Date('2026-10-01T00:00:00Z');
    await connection!.collection('users').insertMany([
      {
        _id: actorId,
        email: 'admin@example.test',
        fullName: 'Admin',
        status: 'ACTIVE',
        passwordHash: 'private-password',
        twoFactorSecretEncrypted: 'private-mfa',
      },
      ...memberUserIds.slice(0, 3).map((_id, index) => ({
        _id,
        email: `member${index}@example.test`,
        fullName: `Member ${index}`,
        status: index === 2 ? 'SUSPENDED' : 'ACTIVE',
        passwordHash: 'private-password',
        twoFactorSecretEncrypted: 'private-mfa',
        lastLoginAt: time,
        googleSubject: `private-google-subject-${index}`,
      })),
    ]);
    await connection!.collection('refresh_sessions').insertOne({
      userId: actorId,
      sessionId: actorSessionId,
      userFence: 0,
      context: 'ORGANIZATION',
      tokenHash: 'c-02-membership-read-session-hash',
      isRevoked: false,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await connection!.collection('organization_memberships').insertMany([
      {
        _id: actorMembershipId,
        organizationId,
        userId: actorId,
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: time,
      },
      ...memberIds.map((_id, index) => ({
        _id,
        organizationId,
        userId: memberUserIds[index],
        status: ORGANIZATION_MEMBERSHIP_STATUSES[index],
        version: index + 1,
        createdAt: time,
        updatedAt: time,
      })),
      {
        _id: foreignMembershipId,
        organizationId: foreignOrganizationId,
        userId: new Types.ObjectId(),
        status: 'ACTIVE',
        version: 1,
        createdAt: time,
        updatedAt: time,
      },
    ]);
    await connection!.collection('roles').insertOne({
      _id: roleId,
      code: 'ADMIN',
      name: 'Admin',
      isSystem: true,
      permissions: ['organization.memberships.read'],
    });
    await connection!.collection('role_assignments').insertOne({
      organizationId,
      userId: actorId,
      roleId,
      roleCode: 'ADMIN',
    });
  });
  it('lists all four states, counts orphan users and strips unrelated PII', async () => {
    const response = await get().expect(200);
    expect(page(response).pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 5,
      totalPages: 1,
    });
    const data = page(response).data;
    expect(new Set(data.map((row) => row.status))).toEqual(
      new Set(ORGANIZATION_MEMBERSHIP_STATUSES),
    );
    expect(
      data.find((row) => row.id === String(memberIds[3]))?.user,
    ).toBeNull();
    const text = JSON.stringify(response.body);
    for (const privateField of [
      'passwordHash',
      'twoFactorSecretEncrypted',
      'googleSubject',
      'lastLoginAt',
      'private-password',
      'roles',
    ])
      expect(text).not.toContain(privateField);
    expect(
      data.find((row) => row.id === String(memberIds[2]))?.user,
    ).toMatchObject({ accountStatus: 'SUSPENDED' });
  });
  it('uses stable createdAt/id order and exact page count before User lookup', async () => {
    const first = await get(`${url}?pageSize=2`).expect(200);
    const second = await get(`${url}?page=2&pageSize=2`).expect(200);
    expect(page(first).data.map((row) => row.id)).toEqual([
      String(memberIds[3]),
      String(memberIds[2]),
    ]);
    expect(page(second).data.map((row) => row.id)).toEqual([
      String(memberIds[1]),
      String(memberIds[0]),
    ]);
    expect(page(first).pagination.totalItems).toBe(5);
    const empty = await get(`${url}?page=20`).expect(200);
    expect(page(empty).data).toEqual([]);
    expect(page(empty).pagination.totalItems).toBe(5);
  });
  it.each(ORGANIZATION_MEMBERSHIP_STATUSES)(
    'filters membership state %s, independent of account status',
    async (status) => {
      const response = await get(`${url}?status=${status}`).expect(200);
      expect(
        page(response).data.every(
          (row: { status: string }) => row.status === status,
        ),
      ).toBe(true);
      expect(page(response).pagination.totalItems).toBe(
        status === 'ACTIVE' ? 2 : 1,
      );
    },
  );
  it('returns orphan detail and denies missing, foreign and User IDs equally', async () => {
    const orphan = await get(`${url}/${String(memberIds[3])}`).expect(200);
    expect((orphan.body as OrganizationMembershipSummary).user).toBeNull();
    for (const id of [
      foreignMembershipId,
      new Types.ObjectId(),
      memberUserIds[0],
    ]) {
      const response = await get(`${url}/${String(id)}`).expect(404);
      expect((response.body as { code: string }).code).toBe(
        'ORGANIZATION_MEMBERSHIP_NOT_FOUND',
      );
    }
  });
  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'denies inactive actor membership %s even with an ADMIN JWT',
    async (status) => {
      await connection!
        .collection('organization_memberships')
        .updateOne({ _id: actorMembershipId }, { $set: { status } });
      await get().expect(401);
    },
  );
  it('requires an ACTIVE User independently of ACTIVE Membership', async () => {
    await connection!
      .collection('users')
      .updateOne({ _id: actorId }, { $set: { status: 'SUSPENDED' } });
    await get().expect(401);
  });
  it('denies cross-Organization request scope', async () => {
    await get(
      url.replace(String(organizationId), String(foreignOrganizationId)),
    ).expect(403);
  });
  it('does not authorize from RoleAssignment alone', async () => {
    await connection!
      .collection('organization_memberships')
      .deleteOne({ _id: actorMembershipId });
    await get().expect(401);
  });
  it.each([
    [
      'manage without read',
      { permissions: ['organization.memberships.manage'] },
    ],
    [
      'unknown permission shape',
      { permissions: ['organization.memberships.read', 7] },
    ],
    ['scalar permission', { permissions: 'organization.memberships.read' }],
    ['misresolved ADMIN code', { code: 'MEMBER' }],
  ])('denies %s from current Role evidence', async (_label, fields) => {
    await connection!
      .collection('roles')
      .updateOne({ _id: roleId }, { $set: fields });
    await get().expect(403);
  });
  it.each([
    ['Project-scoped ADMIN', { projectId: new Types.ObjectId() }],
    ['mismatched roleCode', { roleCode: 'MEMBER' }],
    ['dangling roleId', { roleId: new Types.ObjectId() }],
    ['array-valued roleId', { roleId: [roleId] }],
  ])('denies %s assignments', async (_label, fields) => {
    await connection!
      .collection('role_assignments')
      .updateOne({ userId: actorId }, { $set: fields });
    await get().expect(403);
  });
  it('allows explicit null Organization scope and ignores stale JWT role codes', async () => {
    await connection!
      .collection('role_assignments')
      .updateOne({ userId: actorId }, { $set: { projectId: null } });
    const stale = app!.get(AccessTokenService).signAccessToken({
      sub: String(actorId),
      email: 'admin@example.test',
      orgId: String(organizationId),
      roles: ['MEMBER'],
      sid: actorSessionId,
    });
    await get(url, stale).expect(200);
  });
  it.each(['ACCOUNT', 'PLATFORM'] as const)(
    'rejects %s credentials for Organization reads',
    async (context) => {
      const credential = app!.get(AccessTokenService).signAccessToken({
        sub: String(actorId),
        email: 'admin@example.test',
        context,
        sid: actorSessionId,
      });
      await get(url, credential).expect(401);
    },
  );
  it('reloads live permission on each request with the same JWT', async () => {
    await get().expect(200);
    await connection!
      .collection('roles')
      .updateOne({ _id: roleId }, { $set: { permissions: [] } });
    await get().expect(403);
  });
  it('fails closed if migration metadata is missing instead of inventing a version', async () => {
    await connection!
      .collection('organization_memberships')
      .updateOne({ _id: memberIds[3] }, { $unset: { version: '' } });
    const response = await get().expect(503);
    expect((response.body as { code: string }).code).toBe(
      'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
    );
    expect((response.body as { details: unknown }).details).toEqual({});
  });
  it.each(['not-an-email', ''])(
    'rejects stored invalid email %j on list and detail',
    async (email) => {
      await connection!
        .collection('users')
        .updateOne({ _id: memberUserIds[0] }, { $set: { email } });
      for (const path of [url, `${url}/${String(memberIds[0])}`]) {
        const response = await get(path).expect(503);
        expect(response.body).toMatchObject({
          code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
          details: {},
        });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(response.body)).not.toContain('not-an-email');
      }
    },
  );
  it('preserves a valid tagged stored email on list and detail', async () => {
    const email = 'Mixed.Case+tag@sub.example.test';
    await connection!
      .collection('users')
      .updateOne({ _id: memberUserIds[0] }, { $set: { email } });
    for (const path of [url, `${url}/${String(memberIds[0])}`]) {
      const response = await get(path).expect(200);
      expect(JSON.stringify(response.body)).toContain(email);
    }
  });
  it('uses existing scoped sort indexes with no blocking sort or global scan', async () => {
    for (const status of [undefined, 'REMOVED']) {
      const plan = await connection!
        .collection('organization_memberships')
        .find({ organizationId, ...(status ? { status } : {}) })
        .sort({ createdAt: -1, _id: -1 })
        .explain('executionStats');
      const winning = JSON.stringify(
        (plan as { queryPlanner: { winningPlan: unknown } }).queryPlanner
          .winningPlan,
      );
      expect(winning).toContain(
        status ? 'membership_status_list' : 'membership_list',
      );
      expect(winning).not.toContain('COLLSCAN');
      expect(winning).not.toContain('"stage":"SORT"');
    }
  });
});
