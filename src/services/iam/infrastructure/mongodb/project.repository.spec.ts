import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoProjectRepository } from './project.repository';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';

const orgId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const userId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const projectId = 'cccccccccccccccccccccccc';
const otherProjectId = 'dddddddddddddddddddddddd';
const roleId = new Types.ObjectId('eeeeeeeeeeeeeeeeeeeeeeee');

function query<T>(value: T) {
  const result = { lean: jest.fn(), exec: jest.fn().mockResolvedValue(value) };
  result.lean.mockReturnValue(result);
  return result;
}

function fixture(
  options: {
    activeOrganization?: boolean;
    assignmentProjectId?: string | null;
    assignmentCode?: string;
    roleCode?: string;
    permissions?: string[];
    activeProjectId?: string | null;
  } = {},
) {
  const assignmentProjectId =
    options.assignmentProjectId === undefined
      ? projectId
      : options.assignmentProjectId;
  const project = {
    _id: new Types.ObjectId(projectId),
    organizationId: new Types.ObjectId(orgId),
    name: 'Example',
    code: 'EX',
    status: 'ACTIVE',
    createdBy: new Types.ObjectId(userId),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  const memberships = {
    exists: jest
      .fn()
      .mockResolvedValue(options.activeOrganization === false ? null : {}),
  };
  const assignments = {
    find: jest.fn().mockReturnValue(
      query([
        {
          roleId,
          roleCode: options.assignmentCode ?? 'MEMBER',
          projectId:
            assignmentProjectId === null
              ? null
              : new Types.ObjectId(assignmentProjectId),
        },
      ]),
    ),
  };
  const roles = {
    find: jest.fn().mockReturnValue(
      query([
        {
          _id: roleId,
          code: options.roleCode ?? 'MEMBER',
          permissions: options.permissions ?? ['project.read'],
        },
      ]),
    ),
  };
  const projectMemberships = {
    find: jest.fn().mockReturnValue(
      query(
        options.activeProjectId === null
          ? []
          : [
              {
                projectId: new Types.ObjectId(
                  options.activeProjectId ?? projectId,
                ),
              },
            ],
      ),
    ),
  };
  const projects = {
    create: jest.fn().mockResolvedValue([{ toObject: () => project }]),
    findOne: jest.fn().mockReturnValue(query(project)),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([project]),
    }),
    countDocuments: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(1) }),
  };
  const audit = { insertOne: jest.fn().mockResolvedValue({}) };
  const session = {
    withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const collection = jest.fn().mockReturnValue(audit);
  const connection = {
    models: {
      continuum_iam_organization_memberships: memberships,
      continuum_iam_role_assignments: assignments,
      continuum_iam_roles: roles,
      continuum_iam_project_memberships: projectMemberships,
      continuum_iam_projects: projects,
    },
    startSession: jest.fn().mockResolvedValue(session),
    collection,
  } as unknown as Connection;
  return {
    repository: new MongoProjectRepository(
      new AuthorizationPolicy(),
      connection,
    ),
    memberships,
    assignments,
    projectMemberships,
    projects,
    audit,
    session,
    connection,
    collection,
  };
}

describe('MongoProjectRepository visibility', () => {
  it('allows organization ADMIN to read metadata without ProjectMembership', async () => {
    const { repository, projects, projectMemberships } = fixture({
      assignmentProjectId: null,
      assignmentCode: 'ADMIN',
      roleCode: 'ADMIN',
      permissions: [],
      activeProjectId: null,
    });
    const found = await repository.findVisible(orgId, userId, projectId);
    expect(found?.id).toBe(projectId);
    expect(projectMemberships.find).toHaveBeenCalled();
    expect(projects.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: new Types.ObjectId(orgId),
      }),
    );
  });

  it('allows a member only with active ProjectMembership and scoped Role permission', async () => {
    const { repository, projectMemberships } = fixture();
    expect((await repository.findVisible(orgId, userId, projectId))?.id).toBe(
      projectId,
    );
    expect(
      await repository.findVisible(orgId, userId, otherProjectId),
    ).toBeNull();
    expect(projectMemberships.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ACTIVE' }),
      expect.any(Object),
    );
  });

  it('filters list before pagination to the authorized Project IDs and Organization', async () => {
    const { repository, projects } = fixture();
    const result = await repository.listVisible(orgId, userId, {
      page: 2,
      pageSize: 10,
      status: 'ACTIVE',
    });
    expect(result.totalItems).toBe(1);
    expect(projects.find).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(orgId),
      _id: { $in: [new Types.ObjectId(projectId)] },
      status: 'ACTIVE',
    });
    expect(projects.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: { $in: [new Types.ObjectId(projectId)] },
      }),
    );
  });

  it.each([
    ['inactive organization membership', { activeOrganization: false }],
    ['inactive project membership', { activeProjectId: null }],
    ['missing permission', { permissions: [] }],
    ['mismatched Role code', { roleCode: 'TEAM_LEADER' }],
    ['organization-scoped assignment', { assignmentProjectId: null }],
  ])('denies %s', async (_case, options) => {
    const { repository, projects } = fixture(options);
    expect(await repository.findVisible(orgId, userId, projectId)).toBeNull();
    expect(projects.findOne).not.toHaveBeenCalled();
  });
});

describe('MongoProjectRepository creation', () => {
  const input = { name: 'Example', code: 'EX' };

  it('writes Project and audit event in one transaction without bootstrap records', async () => {
    const {
      repository,
      projects,
      audit,
      session,
      collection,
      projectMemberships,
      assignments,
    } = fixture();
    const created = await repository.create(orgId, userId, input);
    expect(created.id).toBe(projectId);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(projects.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId: new Types.ObjectId(orgId),
          createdBy: new Types.ObjectId(userId),
          status: 'ACTIVE',
        }),
      ],
      { session },
    );
    expect(collection).toHaveBeenCalledWith('audit_logs_iam');
    expect(audit.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.create',
        projectId,
        actorUserId: userId,
      }),
      { session },
    );
    expect(projectMemberships.find).not.toHaveBeenCalled();
    expect(assignments.find).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  it('maps unique-code races to 409 without writing an audit event', async () => {
    const { repository, projects, audit, session } = fixture();
    projects.create.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: 11000 }),
    );
    await expect(repository.create(orgId, userId, input)).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    expect(audit.insertOne).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  it('fails the mutation if the audit write fails', async () => {
    const { repository, audit, session } = fixture();
    audit.insertOne.mockRejectedValue(new Error('audit unavailable'));
    await expect(repository.create(orgId, userId, input)).rejects.toThrow(
      'audit unavailable',
    );
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalled();
  });
});
