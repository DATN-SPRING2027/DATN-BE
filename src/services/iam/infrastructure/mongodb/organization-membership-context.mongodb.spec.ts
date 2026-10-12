import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import mongoose, { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../../bootstrap';
import { AuthenticationApplicationService } from '../../application/authentication/authentication.application.service';
import { AccessTokenService } from '../../application/authentication/access-token.service';
import { AUTHENTICATION_REPOSITORY } from '../../application/authentication/authentication.repository';
import { AUTH_SECURITY_STORE } from '../../application/authentication/auth-security.store';
import { LOGIN_ELIGIBILITY_POLICY } from '../../application/authentication/login-eligibility.policy';
import { ORGANIZATION_CONTEXT_RESOLVER } from '../../application/authentication/organization-context.resolver';
import { MembershipOrganizationContextResolver } from '../../application/authentication/membership-organization-context.resolver';
import { GoogleOAuthService } from '../../application/authentication/google-oauth.service';
import { PasswordCredentialService } from '../../application/credentials/password-credential.service';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from '../../application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { OrganizationInvitationService } from '../../application/organizations/organization-invitation.service';
import { ORGANIZATION_INVITATION_REPOSITORY } from '../../application/organizations/organization-invitation.repository';
import { AuthenticationController } from '../../controllers/authentication.controller';
import { OrganizationInvitationController } from '../../controllers/organization-invitation.controller';
import { IAM_PERSISTENCE } from '../persistence';
import { AuthenticationRepository } from './authentication.repository';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';
import { createCollectionSchema } from './mongodb.schemas';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const collections = [
  'users',
  'organizations',
  'organization_memberships',
  'role_assignments',
  'refresh_sessions',
  'organization_invitations',
];

// Fixture status updates below are not membership administration commands.
// This suite verifies the accepted context gate, not an unapproved write API.
integration('DATN-87 persisted Organization Membership context', () => {
  const databaseName = `datn87_${randomUUID().replaceAll('-', '')}`;
  const userId = new Types.ObjectId();
  const otherUserId = new Types.ObjectId();
  const organizationId = new Types.ObjectId();
  const otherOrganizationId = new Types.ObjectId();
  const secret = randomBytes(32).toString('hex');
  let connection: Connection;
  let app: INestApplication | undefined;
  let resolver: MembershipOrganizationContextResolver;
  let tokens: AccessTokenService;

  function organizationToken(orgId = organizationId, roles: string[] = []) {
    return tokens.signAccessToken({
      sub: String(userId),
      email: 'member@example.test',
      orgId: String(orgId),
      roles,
    });
  }

  function me(token = organizationToken()) {
    return request(app!.getHttpServer() as App)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
  }

  async function setMembershipStatus(status: string) {
    await connection
      .collection('organization_memberships')
      .updateOne({ userId, organizationId }, { $set: { status } });
  }

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri))
      throw new Error('DATN-87 integration requires an explicit loopback URI');
    connection = mongoose.createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    await connection.asPromise();
    const hello = await connection.db!.admin().command({ hello: 1 });
    const build = await connection.db!.admin().command({ buildInfo: 1 });
    if (!hello.setName || !String(build.version).startsWith('7.'))
      throw new Error('DATN-87 integration requires a MongoDB 7 replica set');
    for (const name of collections) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (row) => row.name === name,
      )!;
      await connection
        .model(`continuum_iam_${name}`, createCollectionSchema(definition))
        .createIndexes();
    }
    const repository = new AuthenticationRepository(connection);
    resolver = new MembershipOrganizationContextResolver(repository);
    const module = await Test.createTestingModule({
      controllers: [AuthenticationController, OrganizationInvitationController],
      providers: [
        AuthenticationApplicationService,
        AccessTokenService,
        AuthorizationPolicy,
        OrganizationInvitationService,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: AUTHENTICATION_REPOSITORY, useValue: repository },
        { provide: ORGANIZATION_CONTEXT_RESOLVER, useValue: resolver },
        {
          provide: ORGANIZATION_INVITATION_REPOSITORY,
          useValue: new MongoOrganizationInvitationRepository(connection),
        },
        // These tests use signed sessions; provider/password login and Redis
        // revocation are covered separately. No external infrastructure loads.
        { provide: LOGIN_ELIGIBILITY_POLICY, useValue: {} },
        { provide: PasswordCredentialService, useValue: {} },
        { provide: GoogleOAuthService, useValue: {} },
        { provide: AUTHORIZATION_EVIDENCE_PROVIDER, useValue: {} },
        {
          provide: AUTH_SECURITY_STORE,
          useValue: { isTokenRevoked: () => Promise.resolve(false) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
    tokens = app.get(AccessTokenService);
  }, 30_000);

  beforeEach(async () => {
    for (const name of collections)
      await connection.collection(name).deleteMany({});
    await connection.collection('users').insertOne({
      _id: userId,
      email: 'member@example.test',
      fullName: 'Member',
      status: 'ACTIVE',
    });
    await connection.collection('organizations').insertMany([
      { _id: organizationId, name: 'Own Organization', slug: 'own' },
      { _id: otherOrganizationId, name: 'Other Organization', slug: 'other' },
    ]);
    await connection.collection('organization_memberships').insertOne({
      userId,
      organizationId,
      status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (connection?.readyState === mongoose.ConnectionStates.connected)
        await connection.dropDatabase();
    } finally {
      await connection?.close();
    }
  });

  it('resolves ACTIVE membership without roles and serves the current identity', async () => {
    expect(await resolver.resolveForUser(String(userId))).toEqual({
      outcome: 'RESOLVED',
      context: { orgId: String(organizationId), roles: [] },
    });
    const response = await me().expect(200);
    expect(response.body).toMatchObject({
      id: String(userId),
      organizationId: String(organizationId),
      roles: [],
    });
  });

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'denies a previously issued ADMIN token on the next check after persisted %s',
    async (status) => {
      const token = organizationToken(organizationId, ['ADMIN']);
      await me(token).expect(200);
      await setMembershipStatus(status);
      expect(await resolver.resolveForUser(String(userId))).toEqual({
        outcome: 'NO_ELIGIBLE_ORGANIZATION',
      });
      const response = await me(token).expect(401);
      expect(response.body).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
      await request(app!.getHttpServer() as App)
        .get(`/api/v1/iam/organizations/${String(organizationId)}/invitations`)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    },
  );

  it('refuses role-only evidence even with an ADMIN token claim', async () => {
    await connection.collection('organization_memberships').deleteMany({});
    await connection.collection('role_assignments').insertOne({
      userId,
      organizationId,
      roleCode: 'ADMIN',
      roleId: new Types.ObjectId(),
    });
    expect(await resolver.resolveForUser(String(userId))).toEqual({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
    await me(organizationToken(organizationId, ['ADMIN'])).expect(401);
  });

  it('does not use another User membership as actor evidence', async () => {
    await connection
      .collection('organization_memberships')
      .updateOne({ userId, organizationId }, { $set: { userId: otherUserId } });
    await me(organizationToken(organizationId, ['ADMIN'])).expect(401);
  });

  it('rejects a token scoped to an Organization without actor membership', async () => {
    await me(organizationToken(otherOrganizationId, ['ADMIN'])).expect(401);
    expect(
      await resolver.resolveForUser(
        String(userId),
        String(otherOrganizationId),
      ),
    ).toEqual({ outcome: 'INVALID_ORGANIZATION_SELECTION' });
  });

  it('requires selection among current ACTIVE memberships and excludes inactive options', async () => {
    await connection.collection('organization_memberships').insertOne({
      userId,
      organizationId: otherOrganizationId,
      status: 'PENDING_INVITE',
    });
    expect(await resolver.resolveForUser(String(userId))).toMatchObject({
      outcome: 'RESOLVED',
    });
    await connection
      .collection('organization_memberships')
      .updateOne(
        { userId, organizationId: otherOrganizationId },
        { $set: { status: 'ACTIVE' } },
      );
    const result = await resolver.resolveForUser(String(userId));
    expect(result.outcome).toBe('ORGANIZATION_SELECTION_REQUIRED');
    if (result.outcome !== 'ORGANIZATION_SELECTION_REQUIRED')
      throw new Error('Expected explicit Organization selection');
    expect(result.organizations.map((entry) => entry.id).sort()).toEqual(
      [String(organizationId), String(otherOrganizationId)].sort(),
    );
    expect(
      await resolver.resolveForUser(
        String(userId),
        String(otherOrganizationId),
      ),
    ).toMatchObject({
      outcome: 'RESOLVED',
      context: { orgId: String(otherOrganizationId), roles: [] },
    });
  });

  it('denies administration to an ACTIVE member despite a forged ADMIN claim', async () => {
    const response = await request(app!.getHttpServer() as App)
      .get(`/api/v1/iam/organizations/${String(organizationId)}/invitations`)
      .set(
        'Authorization',
        `Bearer ${organizationToken(organizationId, ['ADMIN'])}`,
      )
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_ADMIN_REQUIRED',
    });
  });

  it('rejects a client path scope mismatch even when the actor is ADMIN in both Organizations', async () => {
    await connection.collection('organization_memberships').insertOne({
      userId,
      organizationId: otherOrganizationId,
      status: 'ACTIVE',
    });
    await connection.collection('role_assignments').insertMany(
      [organizationId, otherOrganizationId].map((orgId) => ({
        userId,
        organizationId: orgId,
        roleCode: 'ADMIN',
        roleId: new Types.ObjectId(),
      })),
    );
    const response = await request(app!.getHttpServer() as App)
      .get(
        `/api/v1/iam/organizations/${String(otherOrganizationId)}/invitations`,
      )
      .set(
        'Authorization',
        `Bearer ${organizationToken(organizationId, ['ADMIN'])}`,
      )
      .expect(403);
    expect(response.body).toMatchObject({
      code: 'ORGANIZATION_CONTEXT_REQUIRED',
    });
  });

  it('denies an inactive User even when membership remains ACTIVE', async () => {
    await connection
      .collection('users')
      .updateOne({ _id: userId }, { $set: { status: 'SUSPENDED' } });
    await me().expect(401);
  });

  it.each(['PENDING_INVITE', 'SUSPENDED', 'REMOVED'])(
    'does not rotate an Organization refresh session after persisted %s',
    async (status) => {
      const credential = randomBytes(32).toString('base64url');
      const session = {
        userId,
        organizationId,
        context: 'ORGANIZATION',
        tokenHash: createHash('sha256').update(credential).digest('hex'),
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
      };
      await connection.collection('refresh_sessions').insertOne(session);
      await setMembershipStatus(status);
      const response = await request(app!.getHttpServer() as App)
        .post('/api/v1/auth/refresh')
        .set('Cookie', `__Secure-refresh=${credential}; __Host-csrf=test-csrf`)
        .set('x-csrf-token', 'test-csrf')
        .send({})
        .expect(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(
        await connection.collection('refresh_sessions').countDocuments(),
      ).toBe(1);
      expect(
        await connection.collection('refresh_sessions').findOne({
          tokenHash: session.tokenHash,
        }),
      ).toMatchObject({ isRevoked: false });
    },
  );
});
