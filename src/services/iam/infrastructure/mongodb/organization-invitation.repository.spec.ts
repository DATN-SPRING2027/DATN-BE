import { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoOrganizationInvitationRepository } from './organization-invitation.repository';

const organizationId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1f');
const userId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d1f');
const invitationId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d1f');
const roleId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
const invitedBy = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');

function query<T>(value: T) {
  return {
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe('MongoOrganizationInvitationRepository.accept', () => {
  const session = {
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  let invitation: Record<string, unknown>;
  let models: Record<string, Record<string, jest.Mock>>;
  let auditInsert: jest.Mock;
  let repository: MongoOrganizationInvitationRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    invitation = {
      _id: invitationId,
      organizationId,
      email: 'invitee@example.com',
      roleCode: 'MEMBER',
      status: 'PENDING',
      invitedBy,
      expiresAt: new Date('2026-10-18T00:00:00.000Z'),
    };
    auditInsert = jest.fn().mockResolvedValue(undefined);
    models = {
      [`${IAM_PERSISTENCE.databaseName}_organization_invitations`]: {
        findOne: jest.fn(() => query(invitation)),
        findOneAndUpdate: jest.fn(() =>
          query({ ...invitation, status: 'ACCEPTED' }),
        ),
      },
      [`${IAM_PERSISTENCE.databaseName}_users`]: {
        findOne: jest.fn(() =>
          query({
            _id: userId,
            email: 'invitee@example.com',
            status: 'ACTIVE',
          }),
        ),
      },
      [`${IAM_PERSISTENCE.databaseName}_organizations`]: {
        findById: jest.fn(() =>
          query({ _id: organizationId, name: 'Continuum' }),
        ),
      },
      [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]: {
        findOne: jest.fn(() => query(null)),
        create: jest.fn().mockResolvedValue([]),
      },
      [`${IAM_PERSISTENCE.databaseName}_roles`]: {
        findOne: jest.fn(() => query({ _id: roleId, code: 'MEMBER' })),
      },
      [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: {
        findOne: jest.fn(() => query(null)),
        create: jest.fn().mockResolvedValue([]),
      },
    };
    const connection = {
      models,
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn(() => ({
        collection: jest.fn(() => ({ insertOne: auditInsert })),
      })),
    };
    repository = new MongoOrganizationInvitationRepository(connection as never);
  });

  it('atomically activates membership, assigns the invited role, consumes the invite and audits acceptance', async () => {
    const result = await repository.accept({
      invitationId: String(invitationId),
      userId: String(userId),
      email: 'invitee@example.com',
      now: new Date('2026-10-11T00:00:00.000Z'),
    });

    expect(result).toEqual({
      organizationId: String(organizationId),
      organizationName: 'Continuum',
    });
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_organization_memberships`].create,
    ).toHaveBeenCalledWith([{ organizationId, userId, status: 'ACTIVE' }], {
      session,
    });
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_role_assignments`].create,
    ).toHaveBeenCalledWith(
      [
        {
          organizationId,
          userId,
          roleId,
          roleCode: 'MEMBER',
          assignedBy: invitedBy,
        },
      ],
      { session },
    );
    expect(auditInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORGANIZATION_INVITATION_ACCEPTED',
        targetResourceId: String(invitationId),
        actorUserId: userId,
      }),
      { session },
    );
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not consume or grant access when the invitation does not match the account email', async () => {
    models[
      `${IAM_PERSISTENCE.databaseName}_organization_invitations`
    ].findOne.mockReturnValue(query(null));

    const result = await repository.accept({
      invitationId: String(invitationId),
      userId: String(userId),
      email: 'different@example.com',
      now: new Date('2026-10-11T00:00:00.000Z'),
    });

    expect(result).toBeNull();
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_organization_invitations`]
        .findOneAndUpdate,
    ).not.toHaveBeenCalled();
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_organization_memberships`].create,
    ).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });

  it('does not reactivate a removed or suspended membership through an invitation', async () => {
    models[
      `${IAM_PERSISTENCE.databaseName}_organization_memberships`
    ].findOne.mockReturnValue(
      query({ _id: new Types.ObjectId(), status: 'REMOVED' }),
    );

    const result = await repository.accept({
      invitationId: String(invitationId),
      userId: String(userId),
      email: 'invitee@example.com',
      now: new Date('2026-10-11T00:00:00.000Z'),
    });

    expect(result).toBeNull();
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_organization_invitations`]
        .findOneAndUpdate,
    ).not.toHaveBeenCalled();
    expect(
      models[`${IAM_PERSISTENCE.databaseName}_organization_memberships`].create,
    ).not.toHaveBeenCalled();
    expect(auditInsert).not.toHaveBeenCalled();
  });
});
