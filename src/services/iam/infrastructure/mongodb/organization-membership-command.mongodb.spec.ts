import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CollectionInfo } from 'mongodb';
import mongoose, { Types, type ClientSession, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  OrganizationMembershipCommand,
  PlatformInvitationCommand,
} from '../../application/organizations/organization-membership-command.repository';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema, outboxSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';
import { OrganizationInvitationPayloadCipher } from '../email/organization-invitation-payload.cipher';
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
  'platform_authority_assignments',
  'platform_authority_change_locks',
];
type AuditCollectionOptions = {
  validator?: Record<string, unknown>;
  validationLevel?: 'off' | 'strict' | 'moderate';
  validationAction?: 'error' | 'warn';
};
function readAuditCollectionOptions(value: unknown): AuditCollectionOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const options = value as Record<string, unknown>;
  const validator = options.validator;
  const validationLevel = options.validationLevel;
  const validationAction = options.validationAction;
  return {
    ...(validator && typeof validator === 'object' && !Array.isArray(validator)
      ? { validator: validator as Record<string, unknown> }
      : {}),
    ...(validationLevel === 'off' ||
    validationLevel === 'strict' ||
    validationLevel === 'moderate'
      ? { validationLevel }
      : {}),
    ...(validationAction === 'error' || validationAction === 'warn'
      ? { validationAction }
      : {}),
  };
}

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
  const foreignMembershipId = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const memberRoleId = new Types.ObjectId();
  const secret = randomBytes(32).toString('hex');
  let connection: Connection | undefined;
  let repository: MongoOrganizationMembershipCommandRepository;
  let invitationRepository: MongoOrganizationInvitationRepository;
  const auditCollection = () =>
    connection!
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  async function invoke(
    actorUserId: Types.ObjectId,
    command: OrganizationMembershipCommand,
    idempotencyKey = `command-${randomUUID()}`,
    scope = organizationId,
    correlationId?: string,
    invitationReadinessReady = true,
  ) {
    return repository.execute({
      actorUserId: actorUserId.toHexString(),
      organizationId: scope.toHexString(),
      idempotencyKey,
      command,
      now: new Date('2026-10-14T03:00:00.000Z'),
      invitationReadinessReady,
      ...(correlationId ? { correlationId } : {}),
    });
  }

  async function invokePlatformInvitation(
    command: PlatformInvitationCommand,
    idempotencyKey = `platform-invite-${randomUUID()}`,
    invitationReadinessReady = true,
  ) {
    return repository.executePlatformInvitationCommand({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey,
      command,
      now: new Date('2026-10-14T03:00:00.000Z'),
      invitationReadinessReady,
    });
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
    repository = new MongoOrganizationMembershipCommandRepository(
      connection,
      new OrganizationInvitationPayloadCipher(
        new ConfigService({ JWT_SECRET: secret }),
      ),
    );
    invitationRepository = new MongoOrganizationInvitationRepository(
      connection,
    );
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
    const userTimestamp = new Date('2026-10-14T02:00:00.000Z');
    await connection!.collection('users').insertMany([
      {
        _id: actorId,
        email: 'admin@example.test',
        fullName: 'Admin One',
        passwordHash: secret,
        status: 'ACTIVE',
        createdAt: userTimestamp,
        updatedAt: userTimestamp,
      },
      {
        _id: secondAdminId,
        email: 'admin-two@example.test',
        fullName: 'Admin Two',
        passwordHash: secret,
        status: 'ACTIVE',
        createdAt: userTimestamp,
        updatedAt: userTimestamp,
      },
      {
        _id: recipientId,
        email: 'invitee@example.test',
        fullName: 'Invitee',
        passwordHash: secret,
        status: 'ACTIVE',
        createdAt: userTimestamp,
        updatedAt: userTimestamp,
      },
      {
        _id: memberId,
        email: 'member@example.test',
        fullName: 'Member',
        passwordHash: secret,
        status: 'ACTIVE',
        createdAt: userTimestamp,
        updatedAt: userTimestamp,
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
    await connection!.collection('roles').insertOne({
      _id: memberRoleId,
      code: 'MEMBER',
      name: 'Member',
      isSystem: true,
      permissions: [],
    });
    await connection!.collection('role_assignments').insertMany([
      {
        organizationId,
        userId: actorId,
        roleId,
        roleCode: 'ADMIN',
        assignedBy: actorId,
        mutationFence: 0,
      },
      {
        organizationId,
        userId: secondAdminId,
        roleId,
        roleCode: 'ADMIN',
        assignedBy: actorId,
        mutationFence: 0,
      },
    ]);
    await connection!.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
    });
    await connection!.collection('organization_memberships').insertOne({
      _id: foreignMembershipId,
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

  it('creates an email-bound invitation and encrypted outbox event without creating a membership', async () => {
    const result = await invoke(actorId, {
      command: 'INVITE',
      email: 'new.person@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    expect(result.httpStatus).toBe(201);
    if (!('invitation' in result.body) || !result.body.invitation)
      throw new Error('Expected invitation ack');
    const invitation = await connection!
      .collection<{
        contractVersion: number;
        email: string;
        status: string;
        tokenHash: string;
      }>('organization_invitations')
      .findOne({
        _id: new Types.ObjectId(result.body.invitation.id),
      });
    expect(invitation).toMatchObject({
      contractVersion: 3,
      email: 'new.person@example.test',
      status: 'PENDING',
    });
    expect(invitation?.tokenHash).toMatch(/^[a-f\d]{64}$/);
    expect(invitation).not.toHaveProperty('membershipId');
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
      }),
    ).toBe(3);
    const event = await connection!
      .collection<{
        _id: Types.ObjectId;
        eventName: string;
        status: string;
        payload: Record<string, unknown>;
      }>('outbox_events')
      .findOne({
        eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
      });
    expect(event).toMatchObject({ status: 'PENDING' });
    expect(event?.payload).toMatchObject({
      invitationId: result.body.invitation.id,
      organizationId: organizationId.toHexString(),
      recipientEmail: 'new.person@example.test',
      tokenHash: invitation?.tokenHash,
    });
    expect(event?.payload).toHaveProperty('encryptedToken');
    expect(JSON.stringify(event)).not.toContain('new.person@example.test#');
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_INVITATION_CREATED',
      }),
    ).toBe(1);
  });

  it('fails closed for CREATE when A7/A8 readiness is false without writing invitation state', async () => {
    await expect(
      invoke(
        actorId,
        {
          command: 'INVITE',
          email: 'blocked@example.test',
          reasonCode: 'ACCESS_REQUEST',
        },
        `blocked-create-${randomUUID()}`,
        organizationId,
        undefined,
        false,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(0);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      0,
    );
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
  });

  it('resends by superseding the prior token and queuing another delivery event', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'resend@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const oldId = created.body.invitation.id;
    const result = await invoke(actorId, {
      command: 'RESEND',
      invitationId: oldId,
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      reasonCode: 'ACCESS_REVIEW',
    });
    if (!('invitation' in result.body) || !result.body.invitation)
      throw new Error('Expected invitation ack');
    expect(result.body.invitation.id).not.toBe(oldId);
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: new Types.ObjectId(oldId),
      }),
    ).toMatchObject({ status: 'SUPERSEDED', version: 2 });
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: new Types.ObjectId(result.body.invitation.id),
      }),
    ).toMatchObject({ contractVersion: 3, status: 'PENDING', version: 1 });
    expect(
      await connection!.collection('outbox_events').countDocuments({
        eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
        status: 'FAILED',
      }),
    ).toBe(1);
    expect(
      await connection!.collection('outbox_events').countDocuments({
        eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
        status: 'PENDING',
      }),
    ).toBe(1);
  });

  it('rejects stale membership or invitation versions for RESEND without mutation', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'stale-resend@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const invitationId = created.body.invitation.id;

    await expect(
      invoke(actorId, {
        command: 'RESEND',
        invitationId,
        expectedMembershipVersion: 1,
        expectedInvitationVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEMBERSHIP_VERSION_CONFLICT' },
    });
    await expect(
      invoke(actorId, {
        command: 'RESEND',
        invitationId,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'ACCESS_REVIEW',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'INVITATION_VERSION_CONFLICT' },
    });
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: new Types.ObjectId(invitationId),
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      1,
    );
  });

  it('fails closed for RESEND and CANCEL when readiness is false', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'blocked-lifecycle@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const invitationId = created.body.invitation.id;
    const beforeOperations = await connection!
      .collection('membership_operations')
      .countDocuments();

    await expect(
      invoke(
        actorId,
        {
          command: 'RESEND',
          invitationId,
          expectedMembershipVersion: 0,
          expectedInvitationVersion: 1,
          reasonCode: 'ACCESS_REVIEW',
        },
        `blocked-resend-${randomUUID()}`,
        organizationId,
        undefined,
        false,
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      invoke(
        actorId,
        {
          command: 'CANCEL',
          invitationId,
          expectedMembershipVersion: 0,
          expectedInvitationVersion: 1,
          reasonCode: 'INVITATION_CANCELLED',
        },
        `blocked-cancel-${randomUUID()}`,
        organizationId,
        undefined,
        false,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: new Types.ObjectId(invitationId),
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      1,
    );
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(beforeOperations);
  });

  it('cancels an invitation without changing membership and revokes queued token delivery', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'cancel@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const invitationId = created.body.invitation.id;
    const result = await invoke(actorId, {
      command: 'CANCEL',
      invitationId,
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      reasonCode: 'INVITATION_CANCELLED',
    });
    expect(result.body).toMatchObject({
      invitation: { id: invitationId, status: 'CANCELLED', version: 2 },
    });
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
      }),
    ).toBe(3);
    expect(
      await connection!.collection('outbox_events').findOne({
        aggregateId: invitationId,
      }),
    ).toMatchObject({
      status: 'FAILED',
      lastError: 'INVITATION_NO_LONGER_PENDING',
    });
  });

  it('rejects CANCEL with a stale invitation version without changing its state', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'stale-cancel@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const invitationId = created.body.invitation.id;
    await expect(
      invoke(actorId, {
        command: 'CANCEL',
        invitationId,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'INVITATION_CANCELLED',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'INVITATION_VERSION_CONFLICT' },
    });
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: new Types.ObjectId(invitationId),
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      1,
    );
  });

  it('checks fresh Platform invitation authority and commits business state before delivery', async () => {
    await connection!.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: 'platform.memberships.invitation.manage',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      grantedBy: secondAdminId,
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      provenanceOperationId: `test-${randomUUID()}`,
    });

    const command: PlatformInvitationCommand = {
      command: 'INVITE',
      email: 'platform-invite@example.test',
      reasonCode: 'ACCESS_REQUEST',
    };
    const idempotencyKey = `platform-invite-${randomUUID()}`;
    await expect(
      invokePlatformInvitation(command, idempotencyKey, false),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(0);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      0,
    );
    const result = await invokePlatformInvitation(command, idempotencyKey);
    expect(result.httpStatus).toBe(201);
    expect('invitation' in result.body).toBe(true);
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
      }),
    ).toBe(3);
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(1);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(1);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      1,
    );
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
      }),
    ).toBe(1);
    expect(
      await connection!.collection('platform_authority_change_locks').findOne({
        permission: 'PLATFORM_OPERATOR_LIFECYCLE',
        scope: 'PLATFORM',
      }),
    ).toMatchObject({ version: 2 });

    const replay = await invokePlatformInvitation(
      command,
      idempotencyKey,
      false,
    );
    expect(replay).toMatchObject({ replayed: true, body: result.body });
    expect(
      await connection!.collection('organization_invitations').countDocuments(),
    ).toBe(1);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(1);
    expect(await connection!.collection('outbox_events').countDocuments()).toBe(
      1,
    );
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
      }),
    ).toBe(1);
    expect(
      await connection!.collection('platform_authority_change_locks').findOne({
        permission: 'PLATFORM_OPERATOR_LIFECYCLE',
        scope: 'PLATFORM',
      }),
    ).toMatchObject({ version: 3 });
  });

  it('accepts an email-bound V3 invitation atomically with explicitly ready gates and replays idempotently', async () => {
    const acceptedInvitationId = new Types.ObjectId();
    const tokenHash = createHash('sha256')
      .update(randomBytes(32).toString('base64url'))
      .digest('hex');
    const now = new Date('2026-10-14T03:00:00.000Z');
    await connection!.collection('organization_invitations').insertOne({
      _id: acceptedInvitationId,
      organizationId,
      email: 'invitee@example.test',
      contractVersion: 3,
      tokenHash,
      status: 'PENDING',
      version: 1,
      invitedBy: actorId,
      expiresAt: new Date('2026-10-21T03:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    const input = {
      invitationId: acceptedInvitationId.toHexString(),
      actorUserId: recipientId.toHexString(),
      authenticatedEmail: 'invitee@example.test',
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      readinessReady: true,
      idempotencyKey: `accept-${randomUUID()}`,
      now,
    };

    const first = await invitationRepository.acceptForRecipient(input);
    expect(first.replayed).toBe(false);
    expect(first.acknowledgement).toMatchObject({
      membership: {
        organizationId: organizationId.toHexString(),
        userId: recipientId.toHexString(),
        status: 'ACTIVE',
        version: 1,
      },
      invitation: {
        id: acceptedInvitationId.toHexString(),
        status: 'ACCEPTED',
        version: 2,
      },
    });
    expect(
      await connection!.collection('organization_memberships').findOne({
        organizationId,
        userId: recipientId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 1 });
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: acceptedInvitationId,
      }),
    ).toMatchObject({ status: 'ACCEPTED', version: 2 });
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_INVITATION_ACCEPTED',
        invitationIds: acceptedInvitationId.toHexString(),
      }),
    ).toBe(1);

    await expect(
      invitationRepository.acceptForRecipient(input),
    ).resolves.toMatchObject({
      replayed: true,
      acknowledgement: first.acknowledgement,
    });
  });

  it('rejects stale ACCEPT membership or invitation versions without mutation', async () => {
    const invitationId = new Types.ObjectId();
    const now = new Date('2026-10-14T03:00:00.000Z');
    await connection!.collection('organization_invitations').insertOne({
      _id: invitationId,
      organizationId,
      email: 'invitee@example.test',
      contractVersion: 3,
      tokenHash: createHash('sha256')
        .update(randomBytes(32).toString('base64url'))
        .digest('hex'),
      status: 'PENDING',
      version: 1,
      invitedBy: actorId,
      expiresAt: new Date('2026-10-21T03:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    const input = {
      invitationId: invitationId.toHexString(),
      actorUserId: recipientId.toHexString(),
      authenticatedEmail: 'invitee@example.test',
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      readinessReady: true,
      now,
    };

    await expect(
      invitationRepository.acceptForRecipient({
        ...input,
        expectedMembershipVersion: 1,
        idempotencyKey: `stale-membership-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEMBERSHIP_VERSION_CONFLICT' },
    });
    await expect(
      invitationRepository.acceptForRecipient({
        ...input,
        expectedInvitationVersion: 2,
        idempotencyKey: `stale-invitation-${randomUUID()}`,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: invitationId,
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
    expect(
      await connection!.collection('organization_memberships').findOne({
        organizationId,
        userId: recipientId,
      }),
    ).toBeNull();
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
      }),
    ).toBe(0);
  });

  it('serializes concurrent CANCEL and ACCEPT against both expected versions', async () => {
    const created = await invoke(actorId, {
      command: 'INVITE',
      email: 'invitee@example.test',
      reasonCode: 'ACCESS_REQUEST',
    });
    if (!('invitation' in created.body) || !created.body.invitation)
      throw new Error('Expected invitation ack');
    const invitationId = created.body.invitation.id;
    const now = new Date('2026-10-14T03:00:00.000Z');
    const outcomes = await Promise.allSettled([
      invoke(actorId, {
        command: 'CANCEL',
        invitationId,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'INVITATION_CANCELLED',
      }),
      invitationRepository.acceptForRecipient({
        invitationId,
        actorUserId: recipientId.toHexString(),
        authenticatedEmail: 'invitee@example.test',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        readinessReady: true,
        idempotencyKey: `race-accept-${randomUUID()}`,
        now,
      }),
    ]);
    const succeeded = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const invitation = await connection!
      .collection('organization_invitations')
      .findOne({ _id: new Types.ObjectId(invitationId) });
    const membership = await connection!
      .collection('organization_memberships')
      .findOne({ organizationId, userId: recipientId });
    if (invitation?.status === 'CANCELLED') {
      expect(invitation.version).toBe(2);
      expect(membership).toBeNull();
    } else {
      expect(invitation).toMatchObject({ status: 'ACCEPTED', version: 2 });
      expect(membership).toMatchObject({ status: 'ACTIVE', version: 1 });
    }
  });

  it('fails closed for ACCEPT when A7/A8 readiness is false without activating membership', async () => {
    const invitationId = new Types.ObjectId();
    const now = new Date('2026-10-14T03:00:00.000Z');
    await connection!.collection('organization_invitations').insertOne({
      _id: invitationId,
      organizationId,
      email: 'invitee@example.test',
      contractVersion: 3,
      tokenHash: createHash('sha256')
        .update(randomBytes(32).toString('base64url'))
        .digest('hex'),
      status: 'PENDING',
      version: 1,
      invitedBy: actorId,
      expiresAt: new Date('2026-10-21T03:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      invitationRepository.acceptForRecipient({
        invitationId: invitationId.toHexString(),
        actorUserId: recipientId.toHexString(),
        authenticatedEmail: 'invitee@example.test',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        readinessReady: false,
        idempotencyKey: `blocked-accept-${randomUUID()}`,
        now,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
        userId: recipientId,
      }),
    ).toBe(0);
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: invitationId,
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
  });

  it('rejects a recipient whose authenticated email differs without creating membership', async () => {
    const wrongEmailInvitationId = new Types.ObjectId();
    const now = new Date('2026-10-14T03:00:00.000Z');
    await connection!.collection('organization_invitations').insertOne({
      _id: wrongEmailInvitationId,
      organizationId,
      email: 'alice@example.test',
      contractVersion: 3,
      tokenHash: createHash('sha256')
        .update(randomBytes(32).toString('base64url'))
        .digest('hex'),
      status: 'PENDING',
      version: 1,
      invitedBy: actorId,
      expiresAt: new Date('2026-10-21T03:00:00.000Z'),
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      invitationRepository.acceptForRecipient({
        invitationId: wrongEmailInvitationId.toHexString(),
        actorUserId: recipientId.toHexString(),
        authenticatedEmail: 'invitee@example.test',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        readinessReady: true,
        idempotencyKey: `wrong-email-${randomUUID()}`,
        now,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await connection!.collection('organization_memberships').countDocuments({
        organizationId,
        userId: recipientId,
      }),
    ).toBe(0);
    expect(
      await connection!.collection('organization_invitations').findOne({
        _id: wrongEmailInvitationId,
      }),
    ).toMatchObject({ status: 'PENDING', version: 1 });
  });

  it('rejects Platform invitation commands without fresh invitation authority and writes nothing', async () => {
    const error = await invokePlatformInvitation({
      command: 'INVITE',
      email: 'invitee@example.test',
      reasonCode: 'ACCESS_REQUEST',
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getStatus()).toBe(403);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'FORBIDDEN',
    });
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
    expect(
      await connection!.collection('platform_authority_change_locks').findOne({
        permission: 'PLATFORM_OPERATOR_LIFECYCLE',
        scope: 'PLATFORM',
      }),
    ).toMatchObject({ version: 0 });
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

  it('assigns an Organization role with version checks, exact replay, and scoped audit without changing Project roles', async () => {
    const projectId = new Types.ObjectId();
    const key = `organization-role-${randomUUID()}`;
    const command: OrganizationMembershipCommand = {
      command: 'SET_ORGANIZATION_ROLE',
      membershipId: targetMembershipId.toHexString(),
      expectedMembershipVersion: 3,
      expectedRoleVersion: 0,
      roleCode: 'ADMIN',
      reason: 'Access review completed',
    };
    await connection!.collection('role_assignments').insertOne({
      organizationId,
      projectId,
      userId: memberId,
      roleId: memberRoleId,
      roleCode: 'MEMBER',
      assignedBy: actorId,
      mutationFence: 0,
    });

    const committed = await invoke(
      actorId,
      command,
      key,
      organizationId,
      'role-change-request-123',
    );
    const replay = await invoke(
      actorId,
      command,
      key,
      organizationId,
      'role-change-request-123',
    );

    expect(committed).toMatchObject({
      httpStatus: 200,
      replayed: false,
      body: {
        membership: {
          id: targetMembershipId.toHexString(),
          organizationId: organizationId.toHexString(),
          userId: memberId.toHexString(),
          status: 'ACTIVE',
          version: 3,
        },
        role: { roleCode: 'ADMIN', version: 1 },
      },
    });
    expect(replay).toEqual({ ...committed, replayed: true });
    expect(
      await connection!.collection('organization_memberships').findOne({
        _id: targetMembershipId,
      }),
    ).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect(
      await connection!.collection('role_assignments').findOne({
        organizationId,
        userId: memberId,
        projectId: null,
      }),
    ).toMatchObject({
      roleCode: 'ADMIN',
      mutationFence: 1,
      assignedBy: actorId,
    });
    expect(
      await connection!.collection('role_assignments').findOne({
        organizationId,
        projectId,
        userId: memberId,
      }),
    ).toMatchObject({ roleCode: 'MEMBER', mutationFence: 0 });
    expect(
      await connection!.collection('membership_operations').countDocuments({
        actorUserId: actorId,
        organizationId,
        command: 'SET_ORGANIZATION_ROLE',
      }),
    ).toBe(1);
    const audit = await auditCollection().findOne({
      organizationId: organizationId.toHexString(),
      action: 'ORGANIZATION_MEMBER_ROLE_CHANGED',
    });
    expect(audit).toMatchObject({
      actorUserId: actorId.toHexString(),
      scope: 'ORGANIZATION',
      result: 'SUCCESS',
      reasonCode: 'ORGANIZATION_ROLE_CHANGED',
      reason: 'Access review completed',
      correlationId: 'role-change-request-123',
      membershipId: targetMembershipId.toHexString(),
      targetResource: 'ORGANIZATION_MEMBERSHIP',
      targetResourceId: targetMembershipId.toHexString(),
      before: { roleCode: 'UNASSIGNED', roleVersion: 0 },
      after: { roleCode: 'ADMIN', roleVersion: 1 },
    });
    expect(audit?.occurredAt).toBeInstanceOf(Date);
  });

  it('denies Member self-promotion and cross-Organization target lookup without writes', async () => {
    await expect(
      invoke(memberId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'ADMIN',
        reason: 'Self promotion attempt',
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN' },
    });
    await expect(
      invoke(actorId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: foreignMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        expectedRoleVersion: 0,
        roleCode: 'ADMIN',
        reason: 'Cross organization attempt',
      }),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND' },
    });
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(
      await connection!.collection('role_assignments').countDocuments({
        organizationId,
        userId: memberId,
        projectId: null,
      }),
    ).toBe(0);
  });

  it('denies an Admin changing their own role even when another active Admin remains', async () => {
    await expect(
      invoke(actorId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: actorMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: 'Self demotion attempt',
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'ROLE_SELF_CHANGE_FORBIDDEN' },
    });

    expect(
      await connection!.collection('role_assignments').findOne({
        organizationId,
        userId: actorId,
        projectId: null,
      }),
    ).toMatchObject({ roleCode: 'ADMIN', mutationFence: 0 });
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_MEMBER_ROLE_CHANGED',
      }),
    ).toBe(0);
  });

  it('rejects a role change with a stale membership or role version', async () => {
    await expect(
      invoke(actorId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 2,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: 'Stale membership attempt',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'MEMBERSHIP_VERSION_CONFLICT' },
    });
    await expect(
      invoke(actorId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 3,
        expectedRoleVersion: 1,
        roleCode: 'MEMBER',
        reason: 'Stale role attempt',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROLE_VERSION_CONFLICT' },
    });
    expect(
      await connection!.collection('role_assignments').countDocuments({
        organizationId,
        userId: memberId,
        projectId: null,
      }),
    ).toBe(0);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
  });

  it('prevents concurrent cross-member role changes from removing the last active ADMIN', async () => {
    const results = await Promise.allSettled([
      invoke(actorId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: secondAdminMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: 'Admin handoff attempt one',
      }),
      invoke(secondAdminId, {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: actorMembershipId.toHexString(),
        expectedMembershipVersion: 1,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: 'Admin handoff attempt two',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        status: 403,
        response: { code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN' },
      },
    });
    expect(
      await connection!.collection('role_assignments').countDocuments({
        organizationId,
        roleCode: 'ADMIN',
        projectId: null,
      }),
    ).toBe(1);
    expect(
      await connection!.collection('membership_operations').countDocuments({
        command: 'SET_ORGANIZATION_ROLE',
      }),
    ).toBe(1);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_MEMBER_ROLE_CHANGED',
      }),
    ).toBe(1);
  });

  it('rolls back a role assignment and operation when its required audit write fails', async () => {
    const auditDb = connection!.useDb(AUDIT_DATABASE_NAME, { useCache: true });
    const idempotencyKey = `audit-rollback-retry-${randomUUID()}`;
    const command: OrganizationMembershipCommand = {
      command: 'SET_ORGANIZATION_ROLE',
      membershipId: targetMembershipId.toHexString(),
      expectedMembershipVersion: 3,
      expectedRoleVersion: 0,
      roleCode: 'MEMBER',
      reason: 'Access review completed',
    };
    const auditCollectionInfo = await auditDb
      .db!.listCollections<CollectionInfo>(
        { name: IAM_AUDIT_COLLECTION_NAME },
        { nameOnly: false },
      )
      .next();
    if (!auditCollectionInfo)
      throw new Error('Disposable audit collection is unavailable');
    const previousOptions = readAuditCollectionOptions(
      auditCollectionInfo.options,
    );
    try {
      await auditDb.db!.command({
        collMod: IAM_AUDIT_COLLECTION_NAME,
        validator: { __rejectOrganizationAuditTestWrites: { $exists: true } },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await expect(
        invoke(actorId, command, idempotencyKey),
      ).rejects.toMatchObject({
        response: { code: 'IAM_MEMBERSHIP_MUTATION_FAILED' },
        status: 500,
      });
    } finally {
      await auditDb.db!.command({
        collMod: IAM_AUDIT_COLLECTION_NAME,
        validator: previousOptions.validator ?? {},
        validationLevel: previousOptions.validationLevel ?? 'strict',
        validationAction: previousOptions.validationAction ?? 'error',
      });
    }
    const retry = await invoke(actorId, command, idempotencyKey);
    expect(retry).toMatchObject({
      httpStatus: 200,
      replayed: false,
      body: { role: { roleCode: 'MEMBER', version: 1 } },
    });
    expect(
      await connection!.collection('role_assignments').countDocuments({
        organizationId,
        userId: memberId,
        projectId: null,
        roleCode: 'MEMBER',
        mutationFence: 1,
      }),
    ).toBe(1);
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(1);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
        action: 'ORGANIZATION_MEMBER_ROLE_CHANGED',
      }),
    ).toBe(1);
  });

  it('revalidates the actor permission after acquiring the Organization fence', async () => {
    const internals = repository as unknown as {
      acquireOrganizationAdminFence: (
        organizationId: Types.ObjectId,
        session: ClientSession,
      ) => Promise<void>;
    };
    const acquireFence =
      internals.acquireOrganizationAdminFence.bind(repository);
    const fence = jest
      .spyOn(internals, 'acquireOrganizationAdminFence')
      .mockImplementation(async (fencedOrganizationId, session) => {
        await acquireFence(fencedOrganizationId, session);
        await connection!
          .collection('roles')
          .updateOne(
            { _id: roleId },
            { $set: { permissions: [] } },
            { session },
          );
      });

    let result: unknown;
    try {
      result = await invoke(actorId, {
        command: 'SUSPEND',
        membershipId: targetMembershipId.toHexString(),
        expectedMembershipVersion: 3,
        reasonCode: 'ACCESS_REVIEW',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      fence.mockRestore();
    }

    expect(result).toBeInstanceOf(ForbiddenException);
    expect(
      await connection!
        .collection('organization_memberships')
        .findOne({ _id: targetMembershipId }),
    ).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect(
      await connection!.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(
      await auditCollection().countDocuments({
        organizationId: organizationId.toHexString(),
      }),
    ).toBe(0);
  });

  it('suspends an active member and denies inactive actors and cross-Organization commands', async () => {
    const result = await invoke(actorId, {
      command: 'SUSPEND',
      membershipId: targetMembershipId.toHexString(),
      expectedMembershipVersion: 3,
      reasonCode: 'ACCESS_REVIEW',
    });
    if (!('membership' in result.body))
      throw new Error('Expected membership ack');
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

  it('records the pending invitation as the resend audit pre-state', async () => {
    const now = new Date('2026-10-14T03:00:00.000Z');
    const invitationId = new Types.ObjectId();
    const session = await connection!.startSession();
    const internals = repository as unknown as {
      resend: (
        organizationIdText: string,
        actorUserId: Types.ObjectId,
        command: Extract<OrganizationMembershipCommand, { command: 'RESEND' }>,
        now: Date,
        session: ClientSession,
      ) => Promise<{
        audit: { before: Record<string, string | number> };
      }>;
    };
    const rollback = new Error('rollback resend audit fixture');
    let before: Record<string, string | number> | undefined;

    await connection!
      .collection('organization_memberships')
      .updateOne(
        { _id: targetMembershipId },
        { $set: { status: 'PENDING_INVITE' } },
      );
    await connection!.collection('organization_invitations').insertOne({
      _id: invitationId,
      organizationId,
      membershipId: targetMembershipId,
      targetUserId: memberId,
      email: 'member@example.test',
      contractVersion: 2,
      version: 1,
      status: 'PENDING',
      invitedBy: actorId,
      expiresAt: new Date('2026-10-21T03:00:00.000Z'),
      createdAt: now,
    });

    let transactionError: unknown;
    try {
      await session
        .withTransaction(async () => {
          const result = await internals.resend(
            organizationId.toHexString(),
            actorId,
            {
              command: 'RESEND',
              invitationId: invitationId.toHexString(),
              expectedMembershipVersion: 3,
              expectedInvitationVersion: 1,
              reasonCode: 'ACCESS_REVIEW',
            },
            now,
            session,
          );
          before = result.audit.before;
          throw rollback;
        })
        .catch((error: unknown) => {
          transactionError = error;
        });
    } finally {
      await session.endSession();
    }

    expect(transactionError).toBe(rollback);
    expect(before).toMatchObject({ invitationStatus: 'PENDING' });
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

  it('rejects a user-status write when the actor membership is no longer ACTIVE', async () => {
    await connection!
      .collection('organization_memberships')
      .updateOne(
        { _id: secondAdminMembershipId },
        { $set: { status: 'SUSPENDED' } },
      );
    const users = new MongoUserDirectoryRepository(connection);

    await expect(
      users.update(
        organizationId.toHexString(),
        memberId.toHexString(),
        { status: 'SUSPENDED' },
        secondAdminId.toHexString(),
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'USER_MANAGEMENT_FORBIDDEN' },
    });

    expect(
      await connection!.collection('users').findOne({ _id: memberId }),
    ).toMatchObject({ status: 'ACTIVE' });
    expect(
      await connection!.collection('organizations').findOne({
        _id: organizationId,
      }),
    ).toMatchObject({ membershipAdminRevision: 0 });
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
      users.update(
        organizationId.toHexString(),
        actorId.toHexString(),
        { status: 'SUSPENDED' },
        secondAdminId.toHexString(),
      ),
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
