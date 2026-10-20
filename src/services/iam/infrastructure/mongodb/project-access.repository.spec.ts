import { Types } from 'mongoose';
import type { Connection, PipelineStage } from 'mongoose';
import { MongoProjectAccessRepository } from './project-access.repository';

function query(result: unknown) {
  const chain = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(result),
  };
  chain.select.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
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
