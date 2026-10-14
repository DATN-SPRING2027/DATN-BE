import { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';

const userId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d1f');
const organizationId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1f');
const membershipId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d1e');
const invitationId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d1f');
const now = new Date('2026-10-14T00:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    _id: invitationId,
    membershipId,
    organizationId,
    status: 'PENDING',
    version: 1,
    expiresAt: new Date('2026-10-21T00:00:00.000Z'),
    createdAt: new Date('2026-10-14T00:00:00.000Z'),
    membershipVersion: 1,
    membershipStatus: 'PENDING_INVITE',
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
  it('lists only pending, live invitations bound to the current user and normalized email', async () => {
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
        contractVersion: 2,
        targetUserId: userId,
        email: 'invitee@example.test',
      },
    });
    expect(pipeline).toContainEqual({
      $match: {
        status: 'PENDING',
        expiresAt: { $gt: now },
        membershipStatus: 'PENDING_INVITE',
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
          membershipId: membershipId.toHexString(),
          organizationId: organizationId.toHexString(),
          status: 'PENDING',
          version: 1,
          expiresAt: '2026-10-21T00:00:00.000Z',
          createdAt: '2026-10-14T00:00:00.000Z',
          membershipVersion: 1,
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
        contractVersion: 2,
        targetUserId: userId,
        email: 'invitee@example.test',
      },
    });
    expect(pipeline).toContainEqual({ $match: { _id: invitationId } });
    expect(result).toEqual({
      membership: {
        id: membershipId.toHexString(),
        status: 'PENDING_INVITE',
        version: 1,
      },
      invitation: {
        id: invitationId.toHexString(),
        membershipId: membershipId.toHexString(),
        organizationId: organizationId.toHexString(),
        status: 'EXPIRED',
        version: 1,
        expiresAt: '2026-10-13T23:59:00.000Z',
        createdAt: '2026-10-14T00:00:00.000Z',
        membershipVersion: 1,
        organizationName: 'Continuum',
      },
    });
    expect(result).not.toHaveProperty('invitation.targetUserId');
    expect(result).not.toHaveProperty('invitation.email');
    expect(result).not.toHaveProperty('invitation.roleCode');
  });
});
