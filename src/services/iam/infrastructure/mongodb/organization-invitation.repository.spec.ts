import { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';

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

  it('grants ADMIN organization role assignment when accepting an ADMIN invitation', async () => {
    const adminRoleId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');
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
          roleCode: 'ADMIN',
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
          roleCode: 'ADMIN',
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
          _id: adminRoleId,
          code: 'ADMIN',
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
      },
    };

    const repository = new MongoOrganizationInvitationRepository(
      connection as never,
    );
    await repository.acceptForRecipient({
      actorUserId: userId.toHexString(),
      authenticatedEmail: 'invitee@example.test',
      invitationId: invitationId.toHexString(),
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
});
