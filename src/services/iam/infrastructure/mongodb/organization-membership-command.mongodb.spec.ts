import { randomBytes, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type { OrganizationMembershipCommand } from '../../application/organizations/organization-membership-command.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema, outboxSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { MongoUserDirectoryRepository } from './user-directory.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const marker = 'datn-291-membership-command-mongo7-disposable';
const collections = [
  'users',
  'organizations',
  'organization_memberships',
  'organization_invitations',
  'membership_operations',
  'roles',
  'role_assignments',
];

integration('C-02 membership commands on disposable MongoDB 7', () => {
  const databaseName = `datn291commands_${randomUUID().replaceAll('-', '')}`;
  const organizationId = new Types.ObjectId();
  const foreignOrganizationId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const secondAdminId = new Types.ObjectId();
  const recipientId = new Types.ObjectId();
  const memberId = new Types.ObjectId();
  const actorMembershipId = new Types.ObjectId();
  const secondAdminMembershipId = new Types.ObjectId();
  const targetMembershipId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const secret = randomBytes(32).toString('hex');
  let connection: Connection | undefined;
  let repository: MongoOrganizationMembershipCommandRepository;
  const auditCollection = () =>
    connection!
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  async function invoke(
    actorUserId: Types.ObjectId,
    command: OrganizationMembershipCommand,
    idempotencyKey = `command-${randomUUID()}`,
    scope = organizationId,
  ) {
    return repository.execute({
      actorUserId: actorUserId.toHexString(),
      organizationId: scope.toHexString(),
      idempotencyKey,
      command,
      now: new Date('2026-10-14T03:00:00.000Z'),
    });
  }

  async function expectReadinessBlocked(
    command: OrganizationMembershipCommand,
  ) {
    const error = await invoke(actorId, command).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
    });
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
      }),
    ).toBe(3);
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(0);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      0,
    );
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
      }),
    ).toBe(0);
  }

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI;
    if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri))
      throw new Error(
        'DATN-291 integration requires an explicit loopback fixture URI',
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
        'DATN-291 integration requires a marked disposable MongoDB 7 replica set',
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
    await connection.createCollection('outbox_events');
    connection.model('continuum_iam_outbox_events', outboxSchema);
    const auditDb = connection.useDb(AUDIT_DATABASE_NAME, { useCache: true });
    const auditCollections = await auditDb
      .db!.listCollections({ name: IAM_AUDIT_COLLECTION_NAME })
      .toArray();
    if (auditCollections.length === 0)
      await auditDb.createCollection(IAM_AUDIT_COLLECTION_NAME);
    repository = new MongoOrganizationMembershipCommandRepository(connection);
  }, 30_000);

  afterAll(async () => {
    if (connection?.readyState === mongoose.ConnectionStates.connected) {
      if (
        connection.name !== databaseName ||
        !/^datn291commands_[a-f\d]{32}$/.test(databaseName)
      )
        throw new Error('Disposable database identity changed');
      await connection.dropDatabase();
      await connection
        .useDb(AUDIT_DATABASE_NAME)
        .collection(IAM_AUDIT_COLLECTION_NAME)
        .deleteMany({ organizationId: organizationId.toHexString() });
    }
    await connection?.close();
  });

  beforeEach(async () => {
    for (const name of collections)
      await connection!.collection(name).deleteMany({});
    await connection!.collection('outbox_events').deleteMany({});
    await connection!.collection('organizations').insertOne({
      _id: organizationId,
      name: 'Test Organization',
      slug: `test-${randomUUID().slice(0, 8)}`,
      plan: 'FREE',
      membershipAdminRevision: 0,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await connection!.collection('users').insertMany([
      {
        _id: actorId,
        email: 'admin@example.test',
        fullName: 'Admin One',
        passwordHash: secret,
        status: 'ACTIVE',
      },
      {
        _id: secondAdminId,
        email: 'admin-two@example.test',
        fullName: 'Admin Two',
        passwordHash: secret,
        status: 'ACTIVE',
      },
      {
        _id: recipientId,
        email: 'invitee@example.test',
        fullName: 'Invitee',
        passwordHash: secret,
        status: 'ACTIVE',
      },
      {
        _id: memberId,
        email: 'member@example.test',
        fullName: 'Member',
        passwordHash: secret,
        status: 'ACTIVE',
      },
    ]);
    await connection!.collection('organization_memberships').insertMany([
      {
        _id: actorMembershipId,
        organizationId,
        userId: actorId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
      },
      {
        _id: secondAdminMembershipId,
        organizationId,
        userId: secondAdminId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
      },
      {
        _id: targetMembershipId,
        organizationId,
        userId: memberId,
        status: 'ACTIVE',
        version: 3,
        mutationFence: 0,
      },
    ]);
    await connection!.collection('roles').insertOne({
      _id: roleId,
      code: 'ADMIN',
      name: 'Admin',
      isSystem: true,
      permissions: ['organization.memberships.manage'],
    });
    await connection!.collection('role_assignments').insertMany([
      { organizationId, userId: actorId, roleId, roleCode: 'ADMIN' },
      { organizationId, userId: secondAdminId, roleId, roleCode: 'ADMIN' },
    ]);
    await connection!.collection('organization_memberships').insertOne({
      _id: new Types.ObjectId(),
      organizationId: foreignOrganizationId,
      userId: actorId,
      status: 'ACTIVE',
      version: 1,
      mutationFence: 0,
    });
    await auditCollection().deleteMany({
      organizationId: organizationId.toHexString(),
    });
  });

  it('fails closed for invitation creation until notification and cutover readiness are verified', async () => {
    await expectReadinessBlocked({
      command: 'INVITE',
      email: 'invitee@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
  });

  it('fails closed for resend until notification and cutover readiness are verified', async () => {
    await expectReadinessBlocked({
      command: 'RESEND',
      invitationId: new Types.ObjectId().toHexString(),
      expectedMembershipVersion: 1,
      expectedInvitationVersion: 1,
      reasonCode: 'ACCESS_REVIEW',
    });
  });

  it('fails closed for cancel until the coordinated legacy cutover is verified', async () => {
    await expectReadinessBlocked({
      command: 'CANCEL',
      invitationId: new Types.ObjectId().toHexString(),
      expectedMembershipVersion: 1,
      expectedInvitationVersion: 1,
      reasonCode: 'INVITATION_CANCELLED',
    });
  });

  it('replays a committed suspension before checking new-attempt preconditions', async () => {
    const key = `suspend-${randomUUID()}`;
    const command: OrganizationMembershipCommand = {
      command: 'SUSPEND',
      membershipId: targetMembershipId.toHexString(),
      expectedMembershipVersion: 3,
      reasonCode: 'ACCESS_REVIEW',
    };
    const committed = await invoke(actorId, command, key);
    const replay = await invoke(actorId, command, key);
    expect(committed.replayed).toBe(false);
    expect(replay).toEqual({ ...committed, replayed: true });
    expect(
      await connection!
        .collection('organization_memberships')
        .findOne({ _id: targetMembershipId }),
    ).toMatchObject({ status: 'SUSPENDED', version: 4 });
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(1);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
      }),
    ).toBe(1);
  });

  it('suspends an active member and denies inactive actors and cross-Organization commands', async () => {
    const result = await invoke(actorId, {
      command: 'SUSPEND',
      membershipId: targetMembershipId.toHexString(),
      expectedMembershipVersion: 3,
      reasonCode: 'ACCESS_REVIEW',
    });
    expect(result.body.membership).toMatchObject({
      status: 'SUSPENDED',
      version: 4,
    });
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
      }),
    ).toBe(1);

    await connection!
      .collection('organization_memberships')
      .updateOne({ _id: actorMembershipId }, { $set: { status: 'SUSPENDED' } });
    await expect(
      invoke(actorId, {
        command: 'SUSPEND',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 4,
        reasonCode: 'ACCESS_REVIEW',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      invoke(
        actorId,
        {
          command: 'SUSPEND',
          membershipId: targetMembershipId.toHexString(),
          expectedMembershipVersion: 4,
          reasonCode: 'ACCESS_REVIEW',
        },
        `cross-org-${randomUUID()}`,
        foreignOrganizationId,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rolls back membership and operation writes when required audit persistence fails', async () => {
    const auditWriter = jest
      .spyOn(
        repository as unknown as {
          writeAudit: (...args: unknown[]) => Promise<void>;
        },
        'writeAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      invoke(actorId, {
        command: 'SUSPEND',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 3,
        reasonCode: 'ACCESS_REVIEW',
      }),
    ).rejects.toMatchObject({
      response: { code: 'IAM_MEMBERSHIP_MUTATION_FAILED' },
      status: 500,
    });
    auditWriter.mockRestore();
    expect(
      await connection!
        .collection('organization_memberships')
        .findOne({ _id: targetMembershipId }),
    ).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(0);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      0,
    );
  });

  it('serializes competing suspensions through the shared ADMIN fence', async () => {
    const results = await Promise.allSettled([
      invoke(actorId, {
        command: 'SUSPEND',
        membershipId: secondAdminMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      }),
      invoke(secondAdminId, {
        command: 'SUSPEND',
        membershipId: actorMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
        status: 'ACTIVE',
      }),
    ).toBe(2);
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
        status: 'SUSPENDED',
      }),
    ).toBe(1);
  });

  it('shares the ADMIN fence with legacy account-status writes', async () => {
    const users = new MongoUserDirectoryRepository(connection);
    const results = await Promise.allSettled([
      invoke(actorId, {
        command: 'SUSPEND',
        membershipId: secondAdminMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      }),
      users.update(organizationId.toHexString(), actorId.toHexString(), {
        status: 'SUSPENDED',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const eligibleAdmins = await Promise.all([
      users.isAdmin(organizationId.toHexString(), actorId.toHexString()),
      users.isAdmin(organizationId.toHexString(), secondAdminId.toHexString()),
    ]);
    expect(eligibleAdmins.filter(Boolean)).toHaveLength(1);
  });
});
