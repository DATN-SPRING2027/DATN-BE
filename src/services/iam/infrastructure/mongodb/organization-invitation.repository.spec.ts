import { model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { IAM_PERSISTENCE } from '../persistence';
import { OrganizationInvitationPayloadCipher } from '../email/organization-invitation-payload.cipher';
import { membershipInvitationSchema } from './membership-lifecycle.schemas';
import { outboxSchema } from './mongodb.schemas';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';

const InvitationValidator = model(
  'DatnInvitationV3SchemaValidatorSpec',
  membershipInvitationSchema,
);
const OutboxValidator = model('DatnOutboxV3SchemaValidatorSpec', outboxSchema);

const userId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d1f');
const organizationId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1f');
const invitationId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d1f');
const now = new Date('2026-10-14T00:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    _id: invitationId,
    organizationId,
    status: 'PENDING',
    version: 1,
    expiresAt: new Date('2026-10-21T00:00:00.000Z'),
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    email: 'invitee@example.test',
    organizationName: 'Continuum',
    ...overrides,
  };
}

function repositoryWithAggregate(result: unknown[]) {
  const pipelines: unknown[] = [];
  const aggregate = jest.fn((pipeline: unknown) => {
    pipelines.push(pipeline);
    return { exec: jest.fn().mockResolvedValue(result) };
  });
  const invitations = { aggregate };
  const connection = {
    models: {
      [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]: invitations,
    },
  };
  return {
    repository: new MongoOrganizationInvitationRepository(connection as never),
    aggregate,
    pipelines,
  };
}

describe('MongoOrganizationInvitationRepository', () => {
  it('lists only pending, live V3 invitations bound to the normalized email', async () => {
    const { repository, aggregate, pipelines } = repositoryWithAggregate([
      { data: [row()], total: [{ count: 1 }] },
    ]);

    const result = await repository.listForRecipient(
      userId.toHexString(),
      'invitee@example.test',
      now,
      2,
      10,
    );

    expect(aggregate).toHaveBeenCalledTimes(1);
    const pipeline = pipelines[0] as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: {
        contractVersion: 3,
        email: 'invitee@example.test',
      },
    });
    expect(pipeline).toContainEqual({
      $match: {
        status: 'PENDING',
        expiresAt: { $gt: now },
      },
    });
    expect(pipeline.at(-1)).toEqual({
      $facet: {
        data: [{ $skip: 10 }, { $limit: 10 }],
        total: [{ $count: 'count' }],
      },
    });
    expect(result).toEqual({
      data: [
        {
          id: invitationId.toHexString(),
          organizationId: organizationId.toHexString(),
          status: 'PENDING',
          version: 1,
          expiresAt: '2026-10-21T00:00:00.000Z',
          createdAt: '2026-10-14T00:00:00.000Z',
          invitedEmail: 'invitee@example.test',
          organizationName: 'Continuum',
        },
      ],
      pagination: { page: 2, pageSize: 10, totalItems: 1, totalPages: 1 },
    });
  });

  it('returns a minimal recipient detail and materializes effective expiry', async () => {
    const { repository, pipelines } = repositoryWithAggregate([
      row({ expiresAt: new Date('2026-10-13T23:59:00.000Z') }),
    ]);

    const result = await repository.getForRecipient(
      invitationId.toHexString(),
      userId.toHexString(),
      'invitee@example.test',
      now,
    );

    const pipeline = pipelines[0] as Array<Record<string, unknown>>;
    expect(pipeline[0]).toEqual({
      $match: {
        contractVersion: 3,
        email: 'invitee@example.test',
      },
    });
    expect(pipeline).toContainEqual({ $match: { _id: invitationId } });
    expect(result).toEqual({
      invitation: {
        id: invitationId.toHexString(),
        organizationId: organizationId.toHexString(),
        status: 'EXPIRED',
        version: 1,
        expiresAt: '2026-10-13T23:59:00.000Z',
        createdAt: '2026-10-14T00:00:00.000Z',
        invitedEmail: 'invitee@example.test',
        organizationName: 'Continuum',
      },
    });
    expect(result).not.toHaveProperty('invitation.targetUserId');
    expect(result).not.toHaveProperty('invitation.email');
    expect(result).not.toHaveProperty('invitation.roleCode');
  });

  it('atomically creates ACTIVE organization membership and default MEMBER role assignment on acceptForRecipient (F-07)', async () => {
    const memberRoleId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
    const session = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const queryChain = <T>(val: T) => ({
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(val),
    });
    const operations = {
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      create: jest.fn().mockResolvedValue([]),
      deleteOne: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const invitations = {
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: invitationId,
          organizationId,
          email: 'invitee@example.test',
          contractVersion: 3,
          version: 1,
          status: 'PENDING',
          expiresAt: new Date('2026-10-21T00:00:00.000Z'),
        }),
      ),
      findOneAndUpdate: jest.fn().mockReturnValue(
        queryChain({
          _id: invitationId,
          organizationId,
          email: 'invitee@example.test',
          contractVersion: 3,
          version: 2,
          status: 'ACCEPTED',
          expiresAt: new Date('2026-10-21T00:00:00.000Z'),
        }),
      ),
    };
    const users = {
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: userId,
          email: 'invitee@example.test',
          status: 'ACTIVE',
        }),
      ),
    };
    const memberships = {
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      create: jest.fn().mockResolvedValue([]),
    };
    const roles = {
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: memberRoleId,
          code: 'MEMBER',
          isSystem: true,
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(queryChain([])),
      create: jest.fn().mockResolvedValue([]),
    };
    const organizations = {
      findById: jest.fn().mockReturnValue(
        queryChain({
          _id: organizationId,
          status: 'ACTIVE',
        }),
      ),
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: organizationId,
          status: 'ACTIVE',
        }),
      ),
    };
    const outbox = {
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const auditInsertOne = jest.fn().mockResolvedValue({});
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({ insertOne: auditInsertOne }),
      }),
      models: {
        [`${IAM_PERSISTENCE.databaseName}_membership_operations`]: operations,
        [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]:
          invitations,
        [`${IAM_PERSISTENCE.databaseName}_users`]: users,
        [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]:
          memberships,
        [`${IAM_PERSISTENCE.databaseName}_roles`]: roles,
        [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: assignments,
        [`${IAM_PERSISTENCE.databaseName}_organizations`]: organizations,
        [`${IAM_PERSISTENCE.databaseName}_outbox_events`]: outbox,
      },
    };

    const repository = new MongoOrganizationInvitationRepository(
      connection as never,
    );
    const result = await repository.acceptForRecipient({
      actorUserId: userId.toHexString(),
      authenticatedEmail: 'invitee@example.test',
      invitationId: invitationId.toHexString(),
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      readinessReady: true,
      idempotencyKey: 'accept-idempotency-key-1234',
      now,
    });

    expect(result.acknowledgement.membership.status).toBe('ACTIVE');
    expect(memberships.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          userId,
          status: 'ACTIVE',
          version: 1,
        }),
      ],
      { session },
    );
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          userId,
          projectId: null,
          roleId: memberRoleId,
          roleCode: 'MEMBER',
          mutationFence: 1,
        }),
      ],
      { session },
    );
  });

  it('grants ADMIN organization role assignment when accepting an ADMIN V3 invitation validated against membershipInvitationSchema', async () => {
    const actorId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d11');
    const adminRoleId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');
    const session = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const queryChain = <T>(val: T) => ({
      session: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(val),
    });

    const createdInvitations: Array<Record<string, unknown>> = [];
    const createdOutboxEvents: Array<Record<string, unknown>> = [];

    const operations = {
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      countDocuments: jest.fn().mockReturnValue(queryChain(0)),
      create: jest.fn().mockResolvedValue([]),
      deleteOne: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const invitations = {
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (filter.status === 'PENDING' && filter.email) {
            return queryChain(null);
          }
          const match = createdInvitations.find(
            (doc) => String(doc._id) === String(filter._id),
          );
          return queryChain(match ?? null);
        }),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          for (const doc of docs) {
            const validationError = new InvitationValidator(doc).validateSync();
            expect(validationError).toBeUndefined();
            expect(doc.roleCode).toBeUndefined();
            createdInvitations.push(doc);
          }
          return Promise.resolve(docs);
        }),
      findOneAndUpdate: jest
        .fn()
        .mockImplementation(
          (
            filter: Record<string, unknown>,
            update: { $set?: Record<string, unknown> },
          ) => {
            const match = createdInvitations.find(
              (doc) => String(doc._id) === String(filter._id),
            );
            const updated = match
              ? {
                  ...match,
                  ...(update.$set ?? {}),
                  version: Number(match.version ?? 1) + 1,
                }
              : null;
            return queryChain(updated);
          },
        ),
    };
    const outbox = {
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          const match = createdOutboxEvents.find(
            (doc) => doc.aggregateId === filter.aggregateId,
          );
          return queryChain(match ?? null);
        }),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          for (const doc of docs) {
            const validationError = new OutboxValidator(doc).validateSync();
            expect(validationError).toBeUndefined();
            createdOutboxEvents.push(doc);
          }
          return Promise.resolve(docs);
        }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const users = {
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (
            filter.email === 'invitee@example.test' ||
            String(filter._id) === userId.toHexString()
          ) {
            return queryChain({
              _id: userId,
              email: 'invitee@example.test',
              status: 'ACTIVE',
            });
          }
          return queryChain({
            _id: actorId,
            email: 'manager@example.test',
            status: 'ACTIVE',
          });
        }),
    };
    const memberships = {
      exists: jest
        .fn()
        .mockReturnValue(queryChain({ _id: new Types.ObjectId() })),
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      create: jest.fn().mockResolvedValue([]),
    };
    const roles = {
      find: jest.fn().mockReturnValue(
        queryChain([
          {
            _id: adminRoleId,
            code: 'ADMIN',
            permissions: ['organization.memberships.manage'],
          },
        ]),
      ),
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: adminRoleId,
          code: 'ADMIN',
          isSystem: true,
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
        if (filter.roleCode === 'ADMIN') {
          return queryChain([{ userId: actorId, roleId: adminRoleId }]);
        }
        return queryChain([]);
      }),
      create: jest.fn().mockResolvedValue([]),
    };
    const organizations = {
      findById: jest.fn().mockReturnValue(
        queryChain({
          _id: organizationId,
          status: 'ACTIVE',
        }),
      ),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
    };
    const auditInsertOne = jest.fn().mockResolvedValue({});
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({ insertOne: auditInsertOne }),
      }),
      models: {
        [`${IAM_PERSISTENCE.databaseName}_membership_operations`]: operations,
        [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]:
          invitations,
        [`${IAM_PERSISTENCE.databaseName}_users`]: users,
        [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]:
          memberships,
        [`${IAM_PERSISTENCE.databaseName}_roles`]: roles,
        [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: assignments,
        [`${IAM_PERSISTENCE.databaseName}_organizations`]: organizations,
        [`${IAM_PERSISTENCE.databaseName}_outbox_events`]: outbox,
      },
    };

    const cipher = new OrganizationInvitationPayloadCipher(
      new ConfigService({
        JWT_SECRET:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    );
    const commandRepo = new MongoOrganizationMembershipCommandRepository(
      connection as never,
      cipher,
    );
    const inviteResult = await commandRepo.execute({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey: 'invite-admin-v3-key-1234',
      command: {
        command: 'INVITE',
        email: 'invitee@example.test',
        roleCode: 'ADMIN',
        reasonCode: 'ACCESS_REQUEST',
      },
      invitationReadinessReady: true,
      now,
    });
    expect(inviteResult.httpStatus).toBe(201);
    const firstInvitationId = (
      inviteResult.body as { invitation: { id: string } }
    ).invitation.id;

    const resendResult = await commandRepo.execute({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey: 'resend-admin-v3-key-1234',
      command: {
        command: 'RESEND',
        invitationId: firstInvitationId,
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
      },
      invitationReadinessReady: true,
      now,
    });
    expect(resendResult.httpStatus).toBe(200);
    const resentInvitationId = (
      resendResult.body as { invitation: { id: string } }
    ).invitation.id;

    const repository = new MongoOrganizationInvitationRepository(
      connection as never,
    );
    await repository.acceptForRecipient({
      actorUserId: userId.toHexString(),
      authenticatedEmail: 'invitee@example.test',
      invitationId: resentInvitationId,
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      readinessReady: true,
      idempotencyKey: 'accept-admin-idempotency-key-1234',
      now,
    });

    expect(roles.findOne).toHaveBeenCalledWith({
      code: 'ADMIN',
      isSystem: true,
    });
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          userId,
          projectId: null,
          roleId: adminRoleId,
          roleCode: 'ADMIN',
          mutationFence: 1,
        }),
      ],
      { session },
    );
  });

  it('resolves top-level organization.plan === ENTERPRISE in overview and settings, and restores missing MEMBER role assignment on resume', async () => {
    const actorId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d11');
    const membershipId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d22');
    const memberRoleId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
    const adminRoleId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');
    const session = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const queryChain = <T>(val: T) => ({
      session: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(val),
    });

    const organizations = {
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: organizationId,
          name: 'Enterprise Org',
          slug: 'enterprise-org',
          plan: 'ENTERPRISE',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        }),
      ),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
    };
    const memberships = {
      countDocuments: jest.fn().mockReturnValue(queryChain(1)),
      exists: jest
        .fn()
        .mockReturnValue(queryChain({ _id: new Types.ObjectId() })),
      find: jest.fn().mockReturnValue(queryChain([])),
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: membershipId,
          organizationId,
          userId,
          status: 'SUSPENDED',
          version: 2,
        }),
      ),
      findOneAndUpdate: jest.fn().mockReturnValue(
        queryChain({
          _id: membershipId,
          organizationId,
          userId,
          status: 'ACTIVE',
          version: 3,
        }),
      ),
    };
    const invitations = {
      countDocuments: jest.fn().mockReturnValue(queryChain(0)),
    };
    const users = {
      find: jest.fn().mockReturnValue(queryChain([])),
      findOne: jest
        .fn()
        .mockReturnValue(queryChain({ _id: userId, status: 'ACTIVE' })),
    };
    const roles = {
      find: jest
        .fn()
        .mockReturnValue(queryChain([{ _id: adminRoleId, code: 'ADMIN' }])),
      findOne: jest.fn().mockReturnValue(
        queryChain({
          _id: memberRoleId,
          code: 'MEMBER',
          isSystem: true,
          permissions: ['organization.memberships.manage'],
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
        if (filter.roleCode === 'ADMIN') {
          return queryChain([{ userId: actorId, roleId: adminRoleId }]);
        }
        return queryChain([]);
      }),
      create: jest.fn().mockResolvedValue([]),
    };
    const operations = {
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      create: jest.fn().mockResolvedValue([]),
    };
    const auditInsertOne = jest.fn().mockResolvedValue({});
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({ insertOne: auditInsertOne }),
      }),
      models: {
        [`${IAM_PERSISTENCE.databaseName}_organizations`]: organizations,
        [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]:
          memberships,
        [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]:
          invitations,
        [`${IAM_PERSISTENCE.databaseName}_users`]: users,
        [`${IAM_PERSISTENCE.databaseName}_roles`]: roles,
        [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: assignments,
        [`${IAM_PERSISTENCE.databaseName}_membership_operations`]: operations,
      },
    };

    const commandRepo = new MongoOrganizationMembershipCommandRepository(
      connection as never,
    );
    const overview = await commandRepo.getOrganizationOverview(
      organizationId.toHexString(),
      now,
    );
    const settings = await commandRepo.getOrganizationSettings(
      organizationId.toHexString(),
    );
    expect(overview.organization.plan).toBe('ENTERPRISE');
    expect(settings.organization.plan).toBe('ENTERPRISE');

    const resumeResult = await commandRepo.execute({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey: 'resume-missing-role-key-1234',
      command: {
        command: 'RESUME',
        membershipId: membershipId.toHexString(),
        expectedMembershipVersion: 2,
        reasonCode: 'ACCESS_REQUEST',
      },
      now,
    });
    expect(resumeResult.httpStatus).toBe(200);
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          projectId: null,
          userId,
          roleId: memberRoleId,
          roleCode: 'MEMBER',
          assignedBy: actorId,
          mutationFence: 1,
        }),
      ],
      { session },
    );
  });

  it('applies requireApproval, projectIds, and projectRoleCode on accept and blocks suspending an active project leader', async () => {
    const actorId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d11');
    const membershipId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d22');
    const projectId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d33');
    const memberRoleId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
    const leaderRoleId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d1f');
    const adminRoleId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');
    const session = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const queryChain = <T>(val: T) => ({
      session: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(val),
    });

    const createdInvitations: Array<Record<string, unknown>> = [];
    const createdOutboxEvents: Array<Record<string, unknown>> = [];
    const createdMemberships: Array<Record<string, unknown>> = [];
    const createdProjectMemberships: Array<Record<string, unknown>> = [];

    const operations = {
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      countDocuments: jest.fn().mockReturnValue(queryChain(0)),
      create: jest.fn().mockResolvedValue([]),
      deleteOne: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const invitations = {
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (filter.status === 'PENDING' && filter.email) {
            return queryChain(null);
          }
          const match = createdInvitations.find(
            (doc) => String(doc._id) === String(filter._id),
          );
          return queryChain(match ?? null);
        }),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          createdInvitations.push(...docs);
          return Promise.resolve(docs);
        }),
      findOneAndUpdate: jest
        .fn()
        .mockImplementation(
          (
            filter: Record<string, unknown>,
            update: { $set?: Record<string, unknown> },
          ) => {
            const match = createdInvitations.find(
              (doc) => String(doc._id) === String(filter._id),
            );
            const updated = match
              ? {
                  ...match,
                  ...(update.$set ?? {}),
                  version: Number(match.version ?? 1) + 1,
                }
              : null;
            return queryChain(updated);
          },
        ),
    };
    const outbox = {
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          const match = createdOutboxEvents.find(
            (doc) => doc.aggregateId === filter.aggregateId,
          );
          return queryChain(match ?? null);
        }),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          createdOutboxEvents.push(...docs);
          return Promise.resolve(docs);
        }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn() }),
    };
    const users = {
      find: jest.fn().mockReturnValue(
        queryChain([
          { _id: actorId, status: 'ACTIVE' },
          { _id: userId, status: 'ACTIVE' },
        ]),
      ),
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (
            filter.email === 'leader@example.test' ||
            String(filter._id) === userId.toHexString()
          ) {
            return queryChain({
              _id: userId,
              email: 'leader@example.test',
              status: 'ACTIVE',
            });
          }
          return queryChain({
            _id: actorId,
            email: 'admin@example.test',
            status: 'ACTIVE',
          });
        }),
    };
    const memberships = {
      exists: jest
        .fn()
        .mockReturnValue(queryChain({ _id: new Types.ObjectId() })),
      find: jest
        .fn()
        .mockReturnValue(queryChain([{ _id: membershipId, userId: actorId }])),
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (String(filter._id) === membershipId.toHexString()) {
            return queryChain({
              _id: membershipId,
              organizationId,
              userId,
              status: 'ACTIVE',
              version: 1,
            });
          }
          return queryChain(null);
        }),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          createdMemberships.push(...docs);
          return Promise.resolve(docs);
        }),
      findOneAndUpdate: jest.fn(),
    };
    const roles = {
      find: jest.fn().mockReturnValue(
        queryChain([
          {
            _id: adminRoleId,
            code: 'ADMIN',
            permissions: ['organization.memberships.manage'],
          },
        ]),
      ),
      findOne: jest
        .fn()
        .mockImplementation((filter: Record<string, unknown>) => {
          if (filter.code === 'TEAM_LEADER') {
            return queryChain({
              _id: leaderRoleId,
              code: 'TEAM_LEADER',
              isSystem: true,
            });
          }
          if (filter.code === 'ADMIN') {
            return queryChain({
              _id: adminRoleId,
              code: 'ADMIN',
              isSystem: true,
            });
          }
          return queryChain({
            _id: memberRoleId,
            code: 'MEMBER',
            isSystem: true,
          });
        }),
    };
    const assignments = {
      find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
        if (filter.roleCode === 'ADMIN') {
          return queryChain([{ userId: actorId, roleId: adminRoleId }]);
        }
        if (filter.roleCode === 'TEAM_LEADER') {
          return queryChain([
            {
              userId,
              roleId: leaderRoleId,
              roleCode: 'TEAM_LEADER',
              projectId,
            },
          ]);
        }
        return queryChain([]);
      }),
      create: jest.fn().mockResolvedValue([]),
    };
    const projects = {
      find: jest.fn().mockReturnValue(
        queryChain([
          {
            _id: projectId,
            organizationId,
            code: 'PRJ-1',
            name: 'Core Platform',
            status: 'ACTIVE',
          },
        ]),
      ),
    };
    const projectMemberships = {
      find: jest
        .fn()
        .mockReturnValue(queryChain([{ projectId, userId, status: 'ACTIVE' }])),
      findOne: jest.fn().mockReturnValue(queryChain(null)),
      create: jest
        .fn()
        .mockImplementation((docs: Array<Record<string, unknown>>) => {
          createdProjectMemberships.push(...docs);
          return Promise.resolve(docs);
        }),
    };
    const organizations = {
      findById: jest
        .fn()
        .mockReturnValue(queryChain({ _id: organizationId, status: 'ACTIVE' })),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
    };
    const auditInsertOne = jest.fn().mockResolvedValue({});
    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({ insertOne: auditInsertOne }),
      }),
      models: {
        [`${IAM_PERSISTENCE.databaseName}_membership_operations`]: operations,
        [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]:
          invitations,
        [`${IAM_PERSISTENCE.databaseName}_users`]: users,
        [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]:
          memberships,
        [`${IAM_PERSISTENCE.databaseName}_roles`]: roles,
        [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: assignments,
        [`${IAM_PERSISTENCE.databaseName}_organizations`]: organizations,
        [`${IAM_PERSISTENCE.databaseName}_outbox_events`]: outbox,
        [`${IAM_PERSISTENCE.databaseName}_projects`]: projects,
        [`${IAM_PERSISTENCE.databaseName}_project_memberships`]:
          projectMemberships,
      },
    };

    const cipher = new OrganizationInvitationPayloadCipher(
      new ConfigService({
        JWT_SECRET:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      }),
    );
    const commandRepo = new MongoOrganizationMembershipCommandRepository(
      connection as never,
      cipher,
    );

    const inviteResult = await commandRepo.execute({
      actorUserId: actorId.toHexString(),
      organizationId: organizationId.toHexString(),
      idempotencyKey: 'invite-leader-v3-key-1234',
      command: {
        command: 'INVITE',
        email: 'leader@example.test',
        roleCode: 'MEMBER',
        projectRoleCode: 'TEAM_LEADER',
        accessScope: 'SPECIFIC_PROJECTS',
        projectIds: [projectId.toHexString()],
        requireApproval: true,
        reasonCode: 'ACCESS_REQUEST',
      },
      invitationReadinessReady: true,
      now,
    });
    expect(inviteResult.httpStatus).toBe(201);
    const createdInvitationId = (
      inviteResult.body as { invitation: { id: string } }
    ).invitation.id;

    const invitationRepo = new MongoOrganizationInvitationRepository(
      connection as never,
    );
    const acceptResult = await invitationRepo.acceptForRecipient({
      actorUserId: userId.toHexString(),
      authenticatedEmail: 'leader@example.test',
      invitationId: createdInvitationId,
      expectedMembershipVersion: 0,
      expectedInvitationVersion: 1,
      readinessReady: true,
      idempotencyKey: 'accept-leader-v3-key-1234',
      now,
    });
    expect(acceptResult.acknowledgement.membership.status).toBe('SUSPENDED');
    expect(createdMemberships[0]?.status).toBe('SUSPENDED');
    expect(createdProjectMemberships).toHaveLength(1);
    expect(createdProjectMemberships[0]).toMatchObject({
      organizationId,
      projectId,
      userId,
      status: 'ACTIVE',
    });
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          projectId,
          userId,
          roleId: leaderRoleId,
          roleCode: 'TEAM_LEADER',
        }),
      ],
      { session },
    );

    await expect(
      commandRepo.execute({
        actorUserId: actorId.toHexString(),
        organizationId: organizationId.toHexString(),
        idempotencyKey: 'suspend-leader-v3-key-1234',
        command: {
          command: 'SUSPEND',
          membershipId: membershipId.toHexString(),
          expectedMembershipVersion: 1,
          reasonCode: 'ACCESS_REVIEW',
        },
        now,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'MEMBER_HAS_ACTIVE_PROJECT_LEADERSHIP',
      },
    });
  });
});
