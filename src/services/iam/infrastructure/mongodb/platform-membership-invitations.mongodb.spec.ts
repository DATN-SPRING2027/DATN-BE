import { randomBytes, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type { PlatformInvitationCommandInput } from '../../application/organizations/organization-membership-command.repository';
import { OrganizationInvitationPayloadCipher } from '../email/organization-invitation-payload.cipher';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema, outboxSchema } from './mongodb.schemas';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';

describe('Platform membership invitations on MongoDB 7', () => {
  jest.setTimeout(120_000);
  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let commands: MongoOrganizationMembershipCommandRepository;
  const organizationId = new Types.ObjectId();
  const foreignOrganizationId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const inviteeId = new Types.ObjectId();
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
  const audit = () =>
    connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);
  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: `platform_invitations_${randomUUID().replaceAll('-', '')}`,
      autoIndex: false,
    });
    await connection.asPromise();
    for (const name of collections) {
      await connection.createCollection(name);
      const definition = IAM_PERSISTENCE.collections.find(
        (row) => row.name === name,
      );
      if (!definition)
        throw new Error(`Missing collection definition: ${name}`);
      await connection
        .model(
          `${IAM_PERSISTENCE.databaseName}_${name}`,
          createCollectionSchema(definition),
        )
        .createIndexes();
    }
    await connection.createCollection('outbox_events');
    connection.model(
      `${IAM_PERSISTENCE.databaseName}_outbox_events`,
      outboxSchema,
    );
    await connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .createCollection(IAM_AUDIT_COLLECTION_NAME);
    commands = new MongoOrganizationMembershipCommandRepository(
      connection,
      new OrganizationInvitationPayloadCipher(
        new ConfigService({ JWT_SECRET: randomBytes(32).toString('hex') }),
      ),
    );
  });
  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });
  beforeEach(async () => {
    for (const name of [...collections, 'outbox_events'])
      await connection.collection(name).deleteMany({});
    await audit().deleteMany({});
    await connection.collection('users').insertOne({
      _id: actorId,
      email: 'operator@example.test',
      status: 'ACTIVE',
    });
    await connection.collection('organizations').insertMany([
      {
        _id: organizationId,
        name: 'Organization',
        slug: 'organization',
        membershipAdminRevision: 0,
      },
      {
        _id: foreignOrganizationId,
        name: 'Foreign',
        slug: 'foreign',
        membershipAdminRevision: 0,
      },
    ]);
    await connection.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
    });
  });
  async function prepareInvitations() {
    await connection.collection('users').insertOne({
      _id: inviteeId,
      email: 'invitee@example.test',
      fullName: 'Invitee',
      status: 'ACTIVE',
      passwordHash: 'invitee-secret',
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: 'platform.memberships.invitation.manage',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedBy: adminId,
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      provenanceOperationId: 'test-platform-invitation-manager',
    });
  }

  function inviteInput(
    overrides: Partial<PlatformInvitationCommandInput> = {},
  ): PlatformInvitationCommandInput {
    return {
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey: `platform-invite-${randomUUID()}`,
      command: {
        command: 'INVITE',
        email: 'invitee@example.test',
        reasonCode: 'ACCESS_REQUEST',
      },
      now: new Date('2026-10-16T00:00:00.000Z'),
      invitationReadinessReady: true,
      correlationId: 'platform-invitation-test',
      ...overrides,
    };
  }

  async function createInvitation() {
    const result =
      await commands.executePlatformInvitationCommand(inviteInput());
    if (!('invitation' in result.body) || !result.body.invitation)
      throw new Error('Expected V3 invitation acknowledgement');
    return result.body.invitation;
  }

  it('invites, resends and cancels with Platform authority without creating a membership or leaking token material', async () => {
    await prepareInvitations();
    const input = inviteInput();
    const first = await commands.executePlatformInvitationCommand(input);
    expect(first).toMatchObject({ httpStatus: 201, replayed: false });
    expect(
      await commands.executePlatformInvitationCommand({
        ...input,
        invitationReadinessReady: false,
      }),
    ).toEqual({ ...first, replayed: true });
    const initial = await commands.listInvitations(
      organizationId.toHexString(),
      1,
      20,
      input.now,
    );
    expect(initial.data).toHaveLength(1);
    expect(initial.data[0]).toMatchObject({
      invitedEmail: 'invitee@example.test',
      version: 1,
    });
    const oldId = initial.data[0].id;
    const resendInput = inviteInput({
      command: {
        command: 'RESEND',
        invitationId: oldId,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      },
    });
    const resent = await commands.executePlatformInvitationCommand(resendInput);
    expect(resent).toMatchObject({ httpStatus: 200, replayed: false });
    expect(
      await commands.executePlatformInvitationCommand(resendInput),
    ).toEqual({ ...resent, replayed: true });
    const pending = await commands.listInvitations(
      organizationId.toHexString(),
      1,
      20,
      input.now,
    );
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0].id).not.toBe(oldId);
    expect(
      await connection
        .collection('organization_invitations')
        .findOne({ _id: new Types.ObjectId(oldId) }),
    ).toMatchObject({ status: 'SUPERSEDED', version: 2 });
    const cancelInput = inviteInput({
      command: {
        command: 'CANCEL',
        invitationId: pending.data[0].id,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'INVITATION_CANCELLED',
      },
    });
    const cancelled =
      await commands.executePlatformInvitationCommand(cancelInput);
    expect(cancelled).toMatchObject({
      body: { invitation: { status: 'CANCELLED', version: 2 } },
    });
    expect(
      await commands.executePlatformInvitationCommand(cancelInput),
    ).toEqual({ ...cancelled, replayed: true });
    expect(
      (
        await commands.listInvitations(
          organizationId.toHexString(),
          1,
          20,
          input.now,
        )
      ).data,
    ).toEqual([]);
    expect(
      await connection
        .collection('organization_memberships')
        .countDocuments({ userId: inviteeId }),
    ).toBe(0);
    expect(
      await connection
        .collection('outbox_events')
        .countDocuments({ status: 'PENDING' }),
    ).toBe(0);
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(3);
    const logs = await audit().find({}).toArray();
    expect(logs).toHaveLength(3);
    for (const log of logs)
      expect(log).toMatchObject({
        scope: 'PLATFORM',
        result: 'SUCCESS',
        actorUserId: actorId.toHexString(),
        correlationId: 'platform-invitation-test',
      });
    for (const result of [first, initial, resent, pending, cancelled, logs]) {
      expect(JSON.stringify(result)).not.toMatch(
        /tokenHash|encryptedToken|passwordHash|invitee-secret/,
      );
    }
  });

  it('reuses an expired invitation idempotency key before Mongo TTL cleanup', async () => {
    await prepareInvitations();
    const input = inviteInput({
      command: {
        command: 'INVITE',
        email: 'invitee@example.test',
        reasonCode: 'ACCESS_REQUEST',
      },
    });
    const first = await commands.executePlatformInvitationCommand(input);
    // Leave the receipt physically present but logically expired. TTL deletion is asynchronous.
    await connection
      .collection('membership_operations')
      .updateOne(
        {},
        { $set: { expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } },
      );
    await connection
      .collection('organization_invitations')
      .updateOne({}, { $set: { status: 'CANCELLED' } });
    const next = await commands.executePlatformInvitationCommand({
      ...input,
      now: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });
    expect(next.replayed).toBe(false);
    expect(next.body.operationId).not.toBe(first.body.operationId);
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(1);
    expect(await audit().countDocuments()).toBe(2);
  });

  it('rejects stale invitation versions, cross-Organization actions and reused keys without extra effects', async () => {
    await prepareInvitations();
    const invitation = await createInvitation();
    const input = inviteInput({
      command: {
        command: 'CANCEL',
        invitationId: invitation.id,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'INVITATION_CANCELLED',
      },
    });
    await expect(
      commands.executePlatformInvitationCommand(input),
    ).rejects.toMatchObject({
      response: { code: 'INVITATION_VERSION_CONFLICT' },
    });
    await expect(
      commands.executePlatformInvitationCommand({
        ...input,
        organizationId: foreignOrganizationId.toHexString(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const valid = {
      ...input,
      command: { ...input.command, expectedInvitationVersion: 1 },
    } as PlatformInvitationCommandInput;
    await commands.executePlatformInvitationCommand(valid);
    await expect(
      commands.executePlatformInvitationCommand({
        ...valid,
        command: { ...valid.command, expectedInvitationVersion: 2 },
      } as PlatformInvitationCommandInput),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(2);
    expect(await audit().countDocuments()).toBe(2);
  });

  it.each([
    'missing',
    'revoked',
    'expired',
    'self-granted',
    'wrong-scope',
    'inactive-user',
  ] as const)(
    'denies %s Platform invitation authority even for replay',
    async (state) => {
      await prepareInvitations();
      const input = inviteInput();
      await commands.executePlatformInvitationCommand(input);
      const assignments = connection.collection(
        'platform_authority_assignments',
      );
      const filter = {
        subjectUserId: actorId,
        permission: 'platform.memberships.invitation.manage',
      };
      if (state === 'missing') await assignments.deleteMany(filter);
      if (state === 'revoked')
        await assignments.updateOne(filter, {
          $set: { status: 'REVOKED', revokedAt: input.now },
        });
      if (state === 'expired')
        await assignments.updateOne(filter, { $set: { expiresAt: input.now } });
      if (state === 'self-granted')
        await assignments.updateOne(filter, { $set: { grantedBy: actorId } });
      if (state === 'inactive-user')
        await connection
          .collection('users')
          .updateOne({ _id: actorId }, { $set: { status: 'SUSPENDED' } });
      if (state === 'wrong-scope')
        await assignments.updateOne(filter, {
          $set: { scope: 'ORGANIZATION' },
        });
      await expect(
        commands.executePlatformInvitationCommand(input),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await connection.collection('membership_operations').countDocuments(),
      ).toBe(1);
      expect(await audit().countDocuments()).toBe(1);
    },
  );

  it('fails closed before writes when invitation readiness is unavailable', async () => {
    await prepareInvitations();
    await expect(
      commands.executePlatformInvitationCommand(
        inviteInput({ invitationReadinessReady: false }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      response: { code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE' },
    });
    for (const name of [
      'organization_invitations',
      'membership_operations',
      'outbox_events',
    ])
      expect(await connection.collection(name).countDocuments()).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('returns the same eligibility error for unknown and suspended invitees', async () => {
    await prepareInvitations();
    const input = inviteInput();
    await expect(
      commands.executePlatformInvitationCommand({
        ...input,
        command: {
          command: 'INVITE',
          email: 'unknown@example.test',
          reasonCode: 'ACCESS_REQUEST',
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'INVITATION_TARGET_NOT_ELIGIBLE' },
    });
    await connection
      .collection('users')
      .updateOne({ _id: inviteeId }, { $set: { status: 'SUSPENDED' } });
    await expect(
      commands.executePlatformInvitationCommand(input),
    ).rejects.toMatchObject({
      status: 422,
      response: { code: 'INVITATION_TARGET_NOT_ELIGIBLE' },
    });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back invitation, ledger and delivery when required audit fails', async () => {
    await prepareInvitations();
    const writer = jest
      .spyOn(
        commands as unknown as {
          writeAudit: (...args: unknown[]) => Promise<void>;
        },
        'writeAudit',
      )
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await expect(
        commands.executePlatformInvitationCommand(inviteInput()),
      ).rejects.toMatchObject({ status: 500 });
    } finally {
      writer.mockRestore();
    }
    for (const name of [
      'organization_invitations',
      'membership_operations',
      'outbox_events',
    ])
      expect(await connection.collection(name).countDocuments()).toBe(0);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('serializes concurrent resend and cancel so only one versioned action commits', async () => {
    await prepareInvitations();
    const invitation = await createInvitation();
    const common = {
      invitationId: invitation.id,
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
    };
    const results = await Promise.allSettled([
      commands.executePlatformInvitationCommand(
        inviteInput({
          command: {
            command: 'RESEND',
            ...common,
            reasonCode: 'ACCESS_REVIEW',
          },
        }),
      ),
      commands.executePlatformInvitationCommand(
        inviteInput({
          command: {
            command: 'CANCEL',
            ...common,
            reasonCode: 'INVITATION_CANCELLED',
          },
        }),
      ),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((row) => row.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { status: 409 } });
    expect(
      await connection.collection('membership_operations').countDocuments(),
    ).toBe(2);
    expect(await audit().countDocuments()).toBe(2);
  });
});
