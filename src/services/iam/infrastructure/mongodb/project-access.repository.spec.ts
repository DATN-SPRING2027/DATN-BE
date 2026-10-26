import { ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Connection, PipelineStage } from 'mongoose';
import { MongoProjectAccessRepository } from './project-access.repository';

function query(result: unknown) {
  const chain = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    session: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(result),
  };
  chain.select.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.lean.mockReturnValue(chain);
  return chain;
}

describe('MongoProjectAccessRepository member candidates', () => {
  it('searches active organization members by email with a bounded aggregation', async () => {
    const organizationId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const candidate = {
      userId,
      email: 'member@example.test',
      fullName: 'A Different Search Term',
      avatarUrl: null,
    };
    const projectQuery = query({ _id: projectId, organizationId });
    const candidateAggregate = {
      exec: jest.fn().mockResolvedValue([candidate]),
    };
    let pipeline: PipelineStage[] = [];
    const projectMembershipQuery = {
      select: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue([]),
    };
    projectMembershipQuery.select.mockReturnValue(projectMembershipQuery);
    projectMembershipQuery.lean.mockReturnValue(projectMembershipQuery);

    const projects = { findOne: jest.fn().mockReturnValue(projectQuery) };
    const organizationMemberships = {
      aggregate: jest.fn((stages: PipelineStage[]) => {
        pipeline = stages;
        return candidateAggregate;
      }),
      find: jest.fn().mockReturnValue(query([{ userId }])),
    };
    const users = { find: jest.fn().mockReturnValue(query([candidate])) };
    const projectMemberships = {
      find: jest.fn().mockReturnValue(projectMembershipQuery),
    };
    const connection = {
      models: {
        continuum_iam_projects: projects,
        continuum_iam_organization_memberships: organizationMemberships,
        continuum_iam_users: users,
        continuum_iam_project_memberships: projectMemberships,
      },
    } as unknown as Connection;

    await expect(
      new MongoProjectAccessRepository(connection).listMemberCandidates(
        organizationId.toHexString(),
        projectId.toHexString(),
        'member@example.test',
      ),
    ).resolves.toEqual([
      {
        userId: userId.toHexString(),
        email: candidate.email,
        fullName: candidate.fullName,
        avatarUrl: null,
        organizationMembershipStatus: 'ACTIVE',
        isProjectMember: false,
      },
    ]);

    expect(pipeline[0]).toEqual({
      $match: { organizationId, status: 'ACTIVE' },
    });
    expect(pipeline[1]).toEqual({
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    });
    expect(pipeline).toContainEqual({
      $match: {
        'user.status': 'ACTIVE',
        'user.email': /member@example\.test/i,
      },
    });
    expect(pipeline).toContainEqual({ $limit: 50 });
    expect(JSON.stringify(pipeline[3])).not.toContain('fullName');
  });
});

describe('MongoProjectAccessRepository Project Leader candidates', () => {
  it('filters by active Project MEMBER scope before limiting email results', async () => {
    const organizationId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const candidateId = new Types.ObjectId();
    const otherProjectMemberId = new Types.ObjectId();
    const memberRoleId = new Types.ObjectId();
    const candidate = {
      _id: candidateId,
      email: 'candidate@example.test',
      fullName: 'Project Member',
      avatarUrl: null,
      status: 'ACTIVE',
    };
    const projects = {
      findOne: jest
        .fn()
        .mockReturnValue(
          query({ _id: projectId, organizationId, status: 'ACTIVE' }),
        ),
    };
    const projectMemberships = {
      find: jest
        .fn()
        .mockReturnValue(
          query([{ userId: candidateId }, { userId: otherProjectMemberId }]),
        ),
    };
    const organizationMemberships = {
      find: jest
        .fn()
        .mockReturnValue(
          query([{ userId: candidateId }, { userId: otherProjectMemberId }]),
        ),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(
        query([
          {
            userId: candidateId,
            roleId: memberRoleId,
            roleCode: 'MEMBER',
          },
        ]),
      ),
    };
    const roles = {
      find: jest
        .fn()
        .mockReturnValue(query([{ _id: memberRoleId, code: 'MEMBER' }])),
    };
    const userQuery = query([candidate]);
    const users = { find: jest.fn().mockReturnValue(userQuery) };
    const connection = {
      models: {
        continuum_iam_projects: projects,
        continuum_iam_project_memberships: projectMemberships,
        continuum_iam_organization_memberships: organizationMemberships,
        continuum_iam_role_assignments: assignments,
        continuum_iam_roles: roles,
        continuum_iam_users: users,
      },
    } as unknown as Connection;

    await expect(
      new MongoProjectAccessRepository(connection).listLeaderCandidates(
        organizationId.toHexString(),
        projectId.toHexString(),
        'candidate@example.test',
      ),
    ).resolves.toEqual([
      {
        userId: candidateId.toHexString(),
        fullName: 'Project Member',
        email: 'candidate@example.test',
        avatarUrl: null,
        role: 'MEMBER',
        status: 'ACTIVE',
      },
    ]);

    expect(projectMemberships.find).toHaveBeenCalledWith({
      organizationId,
      projectId,
      status: 'ACTIVE',
    });
    expect(organizationMemberships.find).toHaveBeenCalledWith({
      organizationId,
      userId: { $in: [candidateId, otherProjectMemberId] },
      status: 'ACTIVE',
    });
    expect(assignments.find).toHaveBeenCalledWith({
      organizationId,
      projectId,
      userId: { $in: [candidateId, otherProjectMemberId] },
      roleCode: { $in: ['MEMBER', 'TEAM_LEADER'] },
    });
    expect(users.find).toHaveBeenCalledWith({
      _id: { $in: [candidateId] },
      status: 'ACTIVE',
      email: /candidate@example\.test/i,
    });
    expect(userQuery.limit).toHaveBeenCalledWith(50);
  });
});

describe('MongoProjectAccessRepository deleteProject', () => {
  it('deletes the project, memberships, and role assignments for Organization ADMIN (Manager) and denies TEAM_LEADER (Leader)', async () => {
    const organizationId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const adminId = new Types.ObjectId();
    const leaderId = new Types.ObjectId();
    const adminRoleId = new Types.ObjectId();
    const leaderRoleId = new Types.ObjectId();
    const orgMembershipId = new Types.ObjectId();
    const projectMembershipId = new Types.ObjectId();
    const adminAssignmentId = new Types.ObjectId();
    const leaderAssignmentId = new Types.ObjectId();

    const session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const insertOne = jest.fn().mockResolvedValue({ acknowledged: true });
    const projects = {
      findOne: jest.fn().mockImplementation(() =>
        query({
          _id: projectId,
          organizationId,
          status: 'ACTIVE',
          visibility: 'PRIVATE',
        }),
      ),
      findOneAndDelete: jest.fn().mockImplementation(() =>
        query({
          _id: projectId,
          organizationId,
          status: 'ACTIVE',
        }),
      ),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const users = {
      findById: jest
        .fn()
        .mockImplementation((id: Types.ObjectId) =>
          query({ _id: id, status: 'ACTIVE' }),
        ),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const organizationMemberships = {
      findOne: jest
        .fn()
        .mockImplementation(({ userId }: { userId: Types.ObjectId }) =>
          query({
            _id: orgMembershipId,
            organizationId,
            userId,
            status: 'ACTIVE',
          }),
        ),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const projectMemberships = {
      findOne: jest
        .fn()
        .mockImplementation(({ userId }: { userId: Types.ObjectId }) =>
          userId.equals(leaderId)
            ? query({
                _id: projectMembershipId,
                organizationId,
                projectId,
                userId,
                status: 'ACTIVE',
              })
            : query(null),
        ),
      deleteMany: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ deletedCount: 2 }),
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const assignments = {
      find: jest
        .fn()
        .mockImplementation(({ userId }: { userId: Types.ObjectId }) =>
          userId.equals(adminId)
            ? query([
                {
                  _id: adminAssignmentId,
                  organizationId,
                  projectId: null,
                  userId: adminId,
                  roleId: adminRoleId,
                  roleCode: 'ADMIN',
                },
              ])
            : query([
                {
                  _id: leaderAssignmentId,
                  organizationId,
                  projectId,
                  userId: leaderId,
                  roleId: leaderRoleId,
                  roleCode: 'TEAM_LEADER',
                },
              ]),
        ),
      deleteMany: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ deletedCount: 2 }),
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const roles = {
      find: jest.fn().mockImplementation(() =>
        query([
          {
            _id: adminRoleId,
            code: 'ADMIN',
            permissions: ['project.visibility.manage', 'project.leader.manage'],
          },
          {
            _id: leaderRoleId,
            code: 'TEAM_LEADER',
            permissions: ['project.update', 'project.visibility.manage'],
          },
        ]),
      ),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    const connection = {
      startSession: jest.fn().mockResolvedValue(session),
      useDb: jest.fn().mockReturnValue({
        collection: jest.fn().mockReturnValue({ insertOne }),
      }),
      models: {
        continuum_iam_projects: projects,
        continuum_iam_users: users,
        continuum_iam_organization_memberships: organizationMemberships,
        continuum_iam_project_memberships: projectMemberships,
        continuum_iam_role_assignments: assignments,
        continuum_iam_roles: roles,
      },
    } as unknown as Connection;

    const repo = new MongoProjectAccessRepository(connection);

    // 1. Leader (TEAM_LEADER) is denied with ForbiddenException
    await expect(
      repo.deleteProject(
        organizationId.toHexString(),
        leaderId.toHexString(),
        projectId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(projects.findOneAndDelete).not.toHaveBeenCalled();

    // 2. Manager (Organization ADMIN) succeeds and deletes project + memberships + assignments + writes audit
    await expect(
      repo.deleteProject(
        organizationId.toHexString(),
        adminId.toHexString(),
        projectId.toHexString(),
      ),
    ).resolves.toBeUndefined();
    expect(projects.findOneAndDelete).toHaveBeenCalledTimes(1);
    expect(projectMemberships.deleteMany).toHaveBeenCalledWith(
      { organizationId, projectId },
      { session },
    );
    expect(assignments.deleteMany).toHaveBeenCalledWith(
      { organizationId, projectId },
      { session },
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: organizationId.toHexString(),
        projectId: projectId.toHexString(),
        actorUserId: adminId.toHexString(),
        action: 'PROJECT_DELETED',
        targetResource: 'PROJECT',
        targetResourceId: projectId.toHexString(),
      }),
      { session },
    );
  });
});
