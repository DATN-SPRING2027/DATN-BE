import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import mongoose, { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../../bootstrap';
import { AUTHENTICATION_REPOSITORY } from '../../application/authentication/authentication.repository';
import { AuthenticationApplicationService } from '../../application/authentication/authentication.application.service';
import { AccessTokenService } from '../../application/authentication/access-token.service';
import { AUTH_SECURITY_STORE } from '../../application/authentication/auth-security.store';
import { LOGIN_ELIGIBILITY_POLICY } from '../../application/authentication/login-eligibility.policy';
import { ORGANIZATION_CONTEXT_RESOLVER } from '../../application/authentication/organization-context.resolver';
import { MembershipOrganizationContextResolver } from '../../application/authentication/membership-organization-context.resolver';
import { PasswordCredentialService } from '../../application/credentials/password-credential.service';
import { AUTHORIZATION_EVIDENCE_PROVIDER } from '../../application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { PlatformAuthorizationGuard } from '../../application/authorization/platform-authorization.guard';
import { IamApplicationService } from '../../application/iam.service';
import { ORGANIZATION_PROVISIONING_REPOSITORY } from '../../application/organizations/organization-provisioning.repository';
import type { ProvisionedOrganization } from '../../application/organizations/organization-provisioning.repository';
import { OrganizationProvisioningService } from '../../application/organizations/organization-provisioning.service';
import { PlatformAuditService } from '../../application/platform/platform-audit.service';
import { PlatformAdministrationService } from '../../application/platform/platform-administration.service';
import { PlatformController } from '../../controllers/platform.controller';
import { IAM_PERSISTENCE } from '../persistence';
import { AuthenticationRepository } from './authentication.repository';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoOrganizationProvisioningRepository } from './organization-provisioning.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const collections = [
  'users',
  'organizations',
  'organization_memberships',
  'roles',
  'role_assignments',
  'platform_authority_assignments',
  'projects',
  'project_memberships',
];

integration('A-05 Organization provisioning on disposable MongoDB 7', () => {
  const databaseName = `datn80_${randomUUID().replaceAll('-', '')}`;
  const auditDatabaseName = `${databaseName}_audit`;
  const operatorId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const secret = randomBytes(32).toString('hex');
  let connection: Connection;
  let app: INestApplication | undefined;
  let token: string;
  let resolver: MembershipOrganizationContextResolver;
  let evidence: MongoAuthorizationEvidenceProvider;
  const policy = new AuthorizationPolicy();
  const input = {
    name: 'A-05 Organization',
    slug: 'a-05-organization',
    plan: 'FREE',
    firstAdminUserId: String(adminId),
  };

  async function bootstrapCounts() {
    return Promise.all([
      ...['organizations', 'organization_memberships', 'role_assignments'].map(
        (name) => connection.collection(name).countDocuments(),
      ),
      connection
        .useDb(auditDatabaseName)
        .collection('audit_logs_iam')
        .countDocuments(),
    ]);
  }

  function create(body: object = input, authorization = `Bearer ${token}`) {
    return request(app!.getHttpServer() as App)
      .post('/api/v1/iam/platform/organizations')
      .set('Authorization', authorization)
      .send(body);
  }

  beforeAll(async () => {
    // Never load repository .env or allow a shared/Atlas target for these tests.
    const uri = process.env.MONGODB_URI;
    if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri))
      throw new Error(
        'A-05 integration requires an explicit loopback MongoDB URI',
      );
    connection = mongoose.createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    await connection.asPromise();
    const hello = await connection.db!.admin().command({ hello: 1 });
    const build = await connection.db!.admin().command({ buildInfo: 1 });
    if (!hello.setName || !String(build.version).startsWith('7.'))
      throw new Error('A-05 integration requires a MongoDB 7 replica set');
    for (const name of collections) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (row) => row.name === name,
      )!;
      await connection
        .model(`continuum_iam_${name}`, createCollectionSchema(definition))
        .createIndexes();
    }
    await connection
      .useDb(auditDatabaseName)
      .createCollection('audit_logs_iam');
    const authentication = new AuthenticationRepository(connection);
    resolver = new MembershipOrganizationContextResolver(authentication);
    evidence = new MongoAuthorizationEvidenceProvider(connection);
    const module = await Test.createTestingModule({
      controllers: [PlatformController],
      providers: [
        AuthenticationApplicationService,
        AccessTokenService,
        AuthorizationPolicy,
        PlatformAuthorizationGuard,
        OrganizationProvisioningService,
        IamApplicationService,
        { provide: ConfigService, useValue: { get: () => secret } },
        { provide: AUTHENTICATION_REPOSITORY, useValue: authentication },
        { provide: ORGANIZATION_CONTEXT_RESOLVER, useValue: resolver },
        { provide: AUTHORIZATION_EVIDENCE_PROVIDER, useValue: evidence },
        {
          provide: ORGANIZATION_PROVISIONING_REPOSITORY,
          useValue: new MongoOrganizationProvisioningRepository(
            connection,
            auditDatabaseName,
          ),
        },
        // Login/password verification and Redis revocation are covered by their own suites.
        { provide: LOGIN_ELIGIBILITY_POLICY, useValue: {} },
        { provide: PasswordCredentialService, useValue: {} },
        {
          provide: AUTH_SECURITY_STORE,
          useValue: { isTokenRevoked: () => Promise.resolve(false) },
        },
        {
          provide: PlatformAuditService,
          useValue: { listOperationalMetadata: () => Promise.resolve([]) },
        },
        {
          provide: PlatformAdministrationService,
          useValue: {
            listOrganizations: () =>
              Promise.resolve({
                data: [],
                pagination: {
                  page: 1,
                  pageSize: 20,
                  totalItems: 0,
                  totalPages: 0,
                },
              }),
            findOrganization: jest.fn(),
            lookupActiveUser: jest.fn(),
            listOrganizationMemberships: () =>
              Promise.resolve({
                data: [],
                pagination: {
                  page: 1,
                  pageSize: 20,
                  totalItems: 0,
                  totalPages: 0,
                },
              }),
            suspendMembership: jest.fn(),
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
    token = app.get(AccessTokenService).signAccessToken({
      sub: String(operatorId),
      email: 'operator@example.test',
      context: 'PLATFORM',
    });
  }, 30_000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    for (const name of collections)
      await connection.collection(name).deleteMany({});
    await connection
      .useDb(auditDatabaseName)
      .collection('audit_logs_iam')
      .deleteMany({});
    await connection.collection('users').insertMany([
      {
        _id: operatorId,
        email: 'operator@example.test',
        fullName: 'Operator',
        status: 'ACTIVE',
      },
      {
        _id: adminId,
        email: 'admin@example.test',
        fullName: 'First Admin',
        status: 'ACTIVE',
      },
    ]);
    await connection.collection('roles').insertOne({
      _id: roleId,
      code: 'ADMIN',
      name: 'Organization Admin',
      permissions: ['project.visibility.manage', 'project.leader.manage'],
      isSystem: true,
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: operatorId,
      permission: 'organization.create',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date(Date.now() - 60_000),
      grantedBy: new Types.ObjectId(),
      expiresAt: null,
      revokedAt: null,
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    try {
      await app?.close();
      if (connection?.readyState === mongoose.ConnectionStates.connected) {
        if (connection.db?.databaseName !== databaseName)
          throw new Error('Refusing cleanup of a non-test database');
        await connection.db.dropDatabase();
        await connection.useDb(auditDatabaseName).dropDatabase();
      }
    } finally {
      await connection?.close();
    }
  });

  it('commits exactly one Organization, ACTIVE membership, scoped ADMIN assignment and safe audit', async () => {
    const response = await create({
      ...input,
      name: ' A-05 Organization ',
      slug: ' A-05-ORGANIZATION ',
    }).expect(201);
    const organization = response.body as ProvisionedOrganization;
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      id: expect.stringMatching(/^[a-f\d]{24}$/) as string,
      name: input.name,
      slug: input.slug,
      plan: input.plan,
      createdAt: expect.any(String) as string,
      updatedAt: expect.any(String) as string,
    });
    expect(Number.isFinite(Date.parse(organization.createdAt))).toBe(true);
    expect(await bootstrapCounts()).toEqual([1, 1, 1, 1]);
    const organizationId = new Types.ObjectId(organization.id);
    const membership = await connection
      .collection('organization_memberships')
      .findOne({ organizationId });
    const assignment = await connection
      .collection('role_assignments')
      .findOne({ organizationId });
    expect(membership).toMatchObject({ userId: adminId, status: 'ACTIVE' });
    expect(assignment).toMatchObject({
      userId: adminId,
      roleId,
      roleCode: 'ADMIN',
      assignedBy: operatorId,
    });
    expect(assignment?.projectId).toBeUndefined();
    const audit = await connection
      .useDb(auditDatabaseName)
      .collection('audit_logs_iam')
      .findOne({});
    expect(audit).toMatchObject({
      actorUserId: String(operatorId),
      action: 'organization.create',
      targetResource: 'ORGANIZATION',
      targetResourceId: organization.id,
      metadata: {
        bootstrap: {
          firstAdminUserId: String(adminId),
          membershipId: String(membership!._id),
          roleAssignmentId: String(assignment!._id),
          roleCode: 'ADMIN',
        },
      },
      occurredAt: expect.any(Date) as Date,
    });
    expect(Object.keys(audit!.metadata as object)).toEqual(['bootstrap']);
    expect(await connection.collection('users').countDocuments()).toBe(2);
    expect(await connection.collection('roles').countDocuments()).toBe(1);
    expect(
      await connection.collection('project_memberships').countDocuments(),
    ).toBe(0);
    expect(await resolver.resolveForUser(String(adminId))).toEqual({
      outcome: 'RESOLVED',
      context: { orgId: organization.id, roles: ['ADMIN'] },
    });
    expect(await resolver.resolveForUser(String(operatorId))).toEqual({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
  });

  it.each(['SUSPENDED', 'PENDING_INVITE', 'MISSING'])(
    'rejects an unavailable first ADMIN (%s) without writes',
    async (status) => {
      if (status === 'MISSING')
        await connection.collection('users').deleteOne({ _id: adminId });
      else
        await connection
          .collection('users')
          .updateOne({ _id: adminId }, { $set: { status } });
      const response = await create().expect(409);
      expect(response.body).toMatchObject({
        code: 'ORGANIZATION_ADMIN_UNAVAILABLE',
      });
      expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('fails closed when the configured ADMIN Role is missing', async () => {
    await connection.collection('roles').deleteOne({ _id: roleId });
    const response = await create().expect(500);
    expect(response.body).toMatchObject({
      code: 'HTTP_500',
      message: 'Internal server error',
      details: {},
    });
    expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
  });

  it('rejects normalized duplicate slug and preserves the committed bootstrap', async () => {
    await create().expect(201);
    const response = await create({
      ...input,
      slug: ' A-05-ORGANIZATION ',
    }).expect(409);
    expect(response.body).toMatchObject({ code: 'ORGANIZATION_SLUG_CONFLICT' });
    expect(await bootstrapCounts()).toEqual([1, 1, 1, 1]);
  });

  it('allows only one concurrent creation of the same slug', async () => {
    const responses = await Promise.all([create(), create()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      responses.find((response) => response.status === 409)?.body,
    ).toMatchObject({ code: 'ORGANIZATION_SLUG_CONFLICT' });
    expect(await bootstrapCounts()).toEqual([1, 1, 1, 1]);
  });

  it.each(['organization_memberships', 'role_assignments'])(
    'rolls back earlier writes when %s persistence fails',
    async (collection) => {
      jest
        .spyOn(connection.models[`continuum_iam_${collection}`], 'create')
        .mockRejectedValueOnce(new Error('Injected bootstrap write failure'));
      await create().expect(500);
      expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('rolls back all IAM records when the audit database rejects its write', async () => {
    const auditDb = connection.useDb(auditDatabaseName).db!;
    await auditDb.command({
      collMod: 'audit_logs_iam',
      validator: { action: { $ne: 'organization.create' } },
      validationLevel: 'strict',
    });
    try {
      const response = await create().expect(500);
      expect(response.text).not.toContain(token);
      expect(response.text).not.toContain(input.name);
      expect(response.text).not.toContain(input.slug);
      expect(response.text).not.toContain(input.firstAdminUserId);
      expect(response.text).not.toMatch(
        /MongoServerError|Document failed validation|audit_logs_iam/i,
      );
      expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
    } finally {
      await auditDb.command({ collMod: 'audit_logs_iam', validator: {} });
    }
  });

  it('rejects invalid input and operator self-bootstrap without persisted state', async () => {
    await create({ ...input, roleCode: 'ADMIN' }).expect(422);
    await create({
      ...input,
      firstAdminUserId: String(operatorId).toUpperCase(),
    }).expect(409);
    expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
  });

  it.each(['SUSPENDED', 'PENDING_INVITE', 'MISSING'])(
    'rejects an unavailable operator account (%s) before writes',
    async (status) => {
      if (status === 'MISSING')
        await connection.collection('users').deleteOne({ _id: operatorId });
      else
        await connection
          .collection('users')
          .updateOne({ _id: operatorId }, { $set: { status } });
      await create().expect(401);
      expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('retries a transient transaction error without duplicate bootstrap or audit', async () => {
    const transient = new mongoose.mongo.MongoServerError({
      message: 'Injected transient transaction failure',
      errorLabels: ['TransientTransactionError'],
    });
    const write = jest
      .spyOn(connection.models.continuum_iam_role_assignments, 'create')
      .mockRejectedValueOnce(transient);
    await create().expect(201);
    expect(write).toHaveBeenCalledTimes(2);
    expect(await bootstrapCounts()).toEqual([1, 1, 1, 1]);
  });

  it('denies an Organization ADMIN token and revoked platform authority without writes', async () => {
    const adminToken = app!.get(AccessTokenService).signAccessToken({
      sub: String(adminId),
      email: 'admin@example.test',
      orgId: String(new Types.ObjectId()),
      roles: ['ADMIN'],
    });
    await create(input, `Bearer ${adminToken}`).expect(403);
    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: operatorId },
        { $set: { status: 'REVOKED', revokedAt: new Date() } },
      );
    await create().expect(403);
    await create(input, 'Bearer invalid').expect(401);
    expect(await bootstrapCounts()).toEqual([0, 0, 0, 0]);
  });

  it('requires ACTIVE membership, matching scope and current documented Role.permissions for first-admin access', async () => {
    const response = await create().expect(201);
    const organizationId = (response.body as ProvisionedOrganization).id;
    const projectId = new Types.ObjectId();
    await connection.collection('projects').insertOne({
      _id: projectId,
      organizationId: new Types.ObjectId(organizationId),
      status: 'ACTIVE',
      visibility: 'PRIVATE',
    });
    async function allowed() {
      const facts = await evidence.loadProjectAccess(
        String(adminId),
        organizationId,
        String(projectId),
      );
      return policy.evaluateProjectAccess({
        ...facts!,
        permission: 'project.visibility.manage',
        subject: { userId: String(adminId), organizationId, status: 'ACTIVE' },
        requestedOrganizationId: organizationId,
        requestedProjectId: String(projectId),
      }).allowed;
    }
    expect(await allowed()).toBe(true);
    for (const status of ['PENDING_INVITE', 'SUSPENDED', 'REMOVED']) {
      await connection
        .collection('organization_memberships')
        .updateOne({ userId: adminId }, { $set: { status } });
      expect(await resolver.resolveForUser(String(adminId))).toEqual({
        outcome: 'NO_ELIGIBLE_ORGANIZATION',
      });
      expect(await allowed()).toBe(false);
    }
    await connection
      .collection('organization_memberships')
      .updateOne({ userId: adminId }, { $set: { status: 'ACTIVE' } });
    await connection
      .collection('roles')
      .updateOne({ _id: roleId }, { $set: { permissions: [] } });
    expect(await allowed()).toBe(false);
    await connection
      .collection('roles')
      .updateOne(
        { _id: roleId },
        { $set: { permissions: ['project.visibility.manage'] } },
      );
    expect(await allowed()).toBe(true);
    await connection
      .collection('role_assignments')
      .updateOne(
        { userId: adminId },
        { $set: { organizationId: new Types.ObjectId() } },
      );
    expect(await allowed()).toBe(false);
    await connection.collection('role_assignments').updateOne(
      { userId: adminId },
      {
        $set: {
          organizationId: new Types.ObjectId(organizationId),
          roleId: new Types.ObjectId(),
        },
      },
    );
    expect(await allowed()).toBe(false);
    await connection
      .collection('role_assignments')
      .deleteMany({ userId: adminId });
    expect(await allowed()).toBe(false);
    await connection
      .collection('organization_memberships')
      .deleteMany({ userId: adminId });
    expect(await resolver.resolveForUser(String(adminId))).toEqual({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
    expect(await allowed()).toBe(false);
  });
});
