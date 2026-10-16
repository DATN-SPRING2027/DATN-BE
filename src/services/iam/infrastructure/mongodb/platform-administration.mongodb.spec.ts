import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type { PlatformMembershipSuspendInput } from '../../application/organizations/organization-membership-command.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { MongoPlatformAdministrationRepository } from './platform-administration.repository';

describe('Platform administration Mongo projections and membership lifecycle', () => {
  jest.setTimeout(120_000);

  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let administration: MongoPlatformAdministrationRepository;
  let commands: MongoOrganizationMembershipCommandRepository;

  const databaseName = `platform_admin_${randomUUID().replaceAll('-', '')}`;
  const organizationId = new Types.ObjectId();
  const foreignOrganizationId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const membershipId = new Types.ObjectId();
  const adminMembershipId = new Types.ObjectId();
  const projectId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
  const platformPermission = 'platform.memberships.lifecycle.manage';
  const audit = () =>
    connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  function suspendInput(
    overrides: Partial<PlatformMembershipSuspendInput> = {},
  ): PlatformMembershipSuspendInput {
    return {
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      membershipId: membershipId.toHexString(),
      idempotencyKey: `platform-suspend-${randomUUID()}`,
      expectedMembershipVersion: 4,
      reasonCode: 'ACCESS_REVIEW',
      now: new Date('2026-10-16T00:00:00.000Z'),
      ...overrides,
    };
  }

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-platform-administration',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'membership_operations',
      'roles',
      'role_assignments',
      'platform_authority_assignments',
      'platform_authority_change_locks',
    ]) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (collection) => collection.name === name,
      );
      if (!definition)
        throw new Error(`Missing IAM collection definition: ${name}`);
      await connection
        .model(modelName(name), createCollectionSchema(definition))
        .createIndexes();
    }
    const auditDatabase = connection.useDb(AUDIT_DATABASE_NAME, {
      useCache: true,
    });
    await auditDatabase.createCollection(IAM_AUDIT_COLLECTION_NAME);
    administration = new MongoPlatformAdministrationRepository(connection);
    commands = new MongoOrganizationMembershipCommandRepository(connection);
  });

  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });

  beforeEach(async () => {
    for (const name of [
      'users',
      'organizations',
      'organization_memberships',
      'membership_operations',
      'roles',
      'role_assignments',
      'platform_authority_assignments',
      'platform_authority_change_locks',
    ])
      await connection.collection(name).deleteMany({});
    await audit().deleteMany({});
    await connection.collection('organizations').insertMany([
      {
        _id: organizationId,
        name: 'Platform Organization',
        slug: 'platform-organization',
        plan: 'FREE',
        settings: { privateSecret: 'never-return-this' },
        membershipAdminRevision: 0,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
      {
        _id: foreignOrganizationId,
        name: 'Foreign Organization',
        slug: 'foreign-organization',
        plan: 'ENTERPRISE',
        settings: { privateSecret: 'foreign-secret' },
        membershipAdminRevision: 0,
        createdAt: new Date('2026-10-02T00:00:00.000Z'),
        updatedAt: new Date('2026-10-02T00:00:00.000Z'),
      },
    ]);
    await connection.collection('users').insertMany([
      {
        _id: actorId,
        email: 'operator@example.test',
        fullName: 'Platform Operator',
        passwordHash: 'password-secret',
        twoFactorSecretEncrypted: 'mfa-secret',
        status: 'ACTIVE',
      },
      {
        _id: adminId,
        email: 'admin@example.test',
        fullName: 'Organization Admin',
        passwordHash: 'admin-password-secret',
        status: 'ACTIVE',
      },
      {
        _id: memberId,
        email: 'member@example.test',
        fullName: 'Organization Member',
        passwordHash: 'member-password-secret',
        status: 'ACTIVE',
      },
    ]);
    await connection.collection('organization_memberships').insertMany([
      {
        _id: membershipId,
        organizationId,
        userId: memberId,
        status: 'ACTIVE',
        version: 4,
        mutationFence: 0,
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
      {
        _id: adminMembershipId,
        organizationId,
        userId: adminId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-03T00:00:00.000Z'),
      },
      {
        _id: new Types.ObjectId(),
        organizationId: foreignOrganizationId,
        userId: memberId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
        createdAt: new Date('2026-10-04T00:00:00.000Z'),
        updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      },
    ]);
    await connection.collection('roles').insertOne({
      _id: roleId,
      code: 'ADMIN',
      name: 'Admin',
      isSystem: true,
      permissions: ['organization.memberships.manage'],
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId: null,
      userId: adminId,
      roleId,
      roleCode: 'ADMIN',
      assignedBy: actorId,
    });
    await connection.collection('role_assignments').insertOne({
      organizationId,
      projectId,
      userId: memberId,
      roleId,
      roleCode: 'MEMBER',
      assignedBy: adminId,
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: platformPermission,
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: adminId,
      expiresAt: null,
      revokedAt: null,
      provenanceOperationId: 'test-platform-authority-operation',
    });
    await connection.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
    });
  });

  it('returns bounded Organization, exact User, and Organization-scoped Membership projections', async () => {
    const organizations = await administration.listOrganizations(1, 20);
    expect(organizations.data.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: foreignOrganizationId.toHexString(), name: 'Foreign Organization' },
      { id: organizationId.toHexString(), name: 'Platform Organization' },
    ]);
    expect(JSON.stringify(organizations)).not.toContain('privateSecret');

    const user = await administration.findActiveUserByExactEmail(
      'member@example.test',
    );
    expect(user).toEqual({
      id: memberId.toHexString(),
      email: 'member@example.test',
      fullName: 'Organization Member',
      status: 'ACTIVE',
    });
    expect(JSON.stringify(user)).not.toContain('passwordHash');
    const memberships = await administration.listOrganizationMemberships({
      organizationId: organizationId.toHexString(),
      page: 1,
      pageSize: 20,
    });
    expect(memberships.data).toHaveLength(2);
    expect(
      memberships.data
        .map((row) => row.organizationId)
        .every((id) => id === organizationId.toHexString()),
    ).toBe(true);
    const member = memberships.data.find(
      (row) => row.id === membershipId.toHexString(),
    );
    expect(member).toMatchObject({
      user: {
        email: 'member@example.test',
        fullName: 'Organization Member',
      },
      organizationRoles: [],
    });
    expect(JSON.stringify(memberships)).not.toContain('password-secret');
    expect(JSON.stringify(memberships)).not.toContain('permissions');
  });

  it('atomically suspends a scoped membership, records bounded audit, and replays idempotently', async () => {
    const input = suspendInput({
      idempotencyKey: 'platform-suspend-test-0001',
    });
    const first = await commands.executePlatformSuspend(input);
    expect(first).toMatchObject({
      httpStatus: 200,
      replayed: false,
      body: {
        membership: {
          id: membershipId.toHexString(),
          organizationId: organizationId.toHexString(),
          userId: memberId.toHexString(),
          status: 'SUSPENDED',
          version: 5,
        },
      },
    });
    const replay = await commands.executePlatformSuspend(input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(1);
    const logs = await audit().find({}).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
      targetResource: 'ORGANIZATION_MEMBERSHIP',
      targetResourceId: membershipId.toHexString(),
      organizationId: organizationId.toHexString(),
      actorUserId: actorId.toHexString(),
      reasonCode: 'ACCESS_REVIEW',
    });
    expect(JSON.stringify(logs)).not.toContain('member@example.test');
    expect(JSON.stringify(logs)).not.toContain('password-secret');
  });

  it('denies stale, unassigned, cross-Organization, and last-admin requests without mutation', async () => {
    await expect(
      commands.executePlatformSuspend(
        suspendInput({ expectedMembershipVersion: 3 }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: actorId, permission: platformPermission },
        { $set: { status: 'REVOKED', revokedAt: new Date() } },
      );
    await expect(
      commands.executePlatformSuspend(suspendInput()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await connection
      .collection('platform_authority_assignments')
      .updateOne(
        { subjectUserId: actorId, permission: platformPermission },
        { $set: { status: 'ACTIVE', revokedAt: null } },
      );

    await expect(
      commands.executePlatformSuspend(
        suspendInput({ organizationId: foreignOrganizationId.toHexString() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      commands.executePlatformSuspend(
        suspendInput({
          membershipId: adminMembershipId.toHexString(),
          expectedMembershipVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: 'LAST_ELIGIBLE_ADMIN' } });
    expect(
      await connection.collection('organization_memberships').findOne({
        _id: membershipId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back membership and idempotency ledger when the required audit write fails', async () => {
    const writer = jest
      .spyOn(
        commands as unknown as {
          writeAudit: (...args: unknown[]) => Promise<void>;
        },
        'writeAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      commands.executePlatformSuspend(
        suspendInput({ idempotencyKey: 'platform-suspend-audit-failure' }),
      ),
    ).rejects.toMatchObject({
      status: 500,
      response: { code: 'IAM_MEMBERSHIP_MUTATION_FAILED' },
    });
    writer.mockRestore();
    expect(
      await connection.collection('organization_memberships').findOne({
        _id: membershipId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 4 });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });
});
