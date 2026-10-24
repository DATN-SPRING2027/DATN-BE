import { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { PROJECT_LEADER_REQUIRED_PERMISSIONS } from '../../application/projects/project-permissions';
import { MongoOrganizationMembershipCommandRepository } from './organization-membership-command.repository';

const organizationId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1f');
const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d1f');
const departingUserId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d1f');
const replacementUserId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d1f');
const actorUserId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d1f');
const assignmentId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d1f');

function query<T>(result: T) {
  return {
    session: () => ({ lean: () => ({ exec: () => Promise.resolve(result) }) }),
  };
}

function fixture(replacementActive = true, canManageLeaders = true) {
  const projects = {
    findOne: jest.fn().mockReturnValue(query({ _id: projectId })),
  };
  const projectMemberships = {
    findOne: jest
      .fn()
      .mockReturnValue(query({ _id: new Types.ObjectId(), status: 'ACTIVE' })),
    findOneAndUpdate: jest.fn().mockReturnValue({
      lean: () => ({
        exec: () => Promise.resolve({ _id: new Types.ObjectId() }),
      }),
    }),
  };
  const assignments = {
    findOne: jest
      .fn()
      .mockImplementation((filter: { userId: Types.ObjectId }) =>
        query(
          filter.userId.equals(departingUserId)
            ? { _id: assignmentId, roleCode: 'TEAM_LEADER' }
            : null,
        ),
      ),
    create: jest.fn().mockResolvedValue([]),
    deleteOne: jest
      .fn()
      .mockReturnValue({ exec: () => Promise.resolve({ deletedCount: 1 }) }),
  };
  const memberships = {
    findOne: jest
      .fn()
      .mockReturnValue(
        query(
          replacementActive
            ? { _id: new Types.ObjectId(), status: 'ACTIVE' }
            : null,
        ),
      ),
  };
  const users = {
    findOne: jest
      .fn()
      .mockReturnValue(query({ _id: replacementUserId, status: 'ACTIVE' })),
  };
  const roles = {
    findOne: jest.fn().mockReturnValue(
      query({
        _id: new Types.ObjectId(),
        code: 'TEAM_LEADER',
        permissions: [...PROJECT_LEADER_REQUIRED_PERMISSIONS],
      }),
    ),
  };
  const models = {
    [`${IAM_PERSISTENCE.databaseName}_projects`]: projects,
    [`${IAM_PERSISTENCE.databaseName}_project_memberships`]: projectMemberships,
    [`${IAM_PERSISTENCE.databaseName}_role_assignments`]: assignments,
    [`${IAM_PERSISTENCE.databaseName}_organization_memberships`]: memberships,
    [`${IAM_PERSISTENCE.databaseName}_users`]: users,
    [`${IAM_PERSISTENCE.databaseName}_roles`]: roles,
  };
  const repository = new MongoOrganizationMembershipCommandRepository({
    models,
  } as never);
  jest
    .spyOn(
      repository as unknown as {
        hasPermissionAt: (...args: unknown[]) => Promise<boolean>;
      },
      'hasPermissionAt',
    )
    .mockResolvedValue(canManageLeaders);
  const handover = (
    repository as unknown as {
      handoverProjectLeadership: (...args: unknown[]) => Promise<void>;
    }
  ).handoverProjectLeadership.bind(repository);
  const command = [
    {
      projectId: projectId.toHexString(),
      replacementUserId: replacementUserId.toHexString(),
    },
  ];
  return { handover, command, assignments, projectMemberships };
}

describe('Organization Project Leader handover', () => {
  it('appoints an active replacement before deleting the departing assignment', async () => {
    const { handover, command, assignments, projectMemberships } = fixture();
    await handover(organizationId, departingUserId, actorUserId, command, {});
    expect(projectMemberships.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        projectId,
        userId: replacementUserId,
      }),
      expect.objectContaining({ $set: { status: 'ACTIVE' } }),
      expect.objectContaining({ upsert: true }),
    );
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId,
          projectId,
          userId: replacementUserId,
          roleCode: 'TEAM_LEADER',
        }),
      ],
      expect.any(Object),
    );
    expect(assignments.deleteOne).toHaveBeenCalledWith(
      { _id: assignmentId, roleCode: 'TEAM_LEADER' },
      expect.any(Object),
    );
    expect(assignments.create.mock.invocationCallOrder[0]).toBeLessThan(
      assignments.deleteOne.mock.invocationCallOrder[0],
    );
  });

  it('does not change assignments when the replacement is not an active Organization member', async () => {
    const { handover, command, assignments, projectMemberships } =
      fixture(false);
    await expect(
      handover(organizationId, departingUserId, actorUserId, command, {}),
    ).rejects.toMatchObject({ status: 409 });
    expect(projectMemberships.findOneAndUpdate).not.toHaveBeenCalled();
    expect(assignments.create).not.toHaveBeenCalled();
    expect(assignments.deleteOne).not.toHaveBeenCalled();
  });

  it('does not permit a handover without Project Leader management authority', async () => {
    const { handover, command, assignments } = fixture(true, false);
    await expect(
      handover(organizationId, departingUserId, actorUserId, command, {}),
    ).rejects.toMatchObject({ status: 403 });
    expect(assignments.create).not.toHaveBeenCalled();
    expect(assignments.deleteOne).not.toHaveBeenCalled();
  });
});
