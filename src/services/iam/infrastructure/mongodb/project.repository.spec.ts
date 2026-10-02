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
  const result = {
    lean: jest.fn(),
    session: jest.fn(),
    exec: jest.fn().mockResolvedValue(value),
  };
  result.lean.mockReturnValue(result);
  result.session.mockReturnValue(result);
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
    projectVisibility?: 'PRIVATE' | 'PUBLIC';
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
    visibility: options.projectVisibility ?? 'PRIVATE',
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
    create: jest.fn().mockResolvedValue([{ _id: new Types.ObjectId() }]),
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
    findOne: jest
      .fn()
      .mockReturnValue(
        query({ _id: roleId, code: 'MEMBER', permissions: ['project.read'] }),
      ),
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
    create: jest.fn().mockResolvedValue([{ _id: new Types.ObjectId() }]),
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
    findOne: jest.fn((filter?: { visibility?: 'PRIVATE' | 'PUBLIC' }) =>
      query(
        filter?.visibility && filter.visibility !== project.visibility
          ? null
          : project,
      ),
    ),
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
  const auditConnection = { collection };
  const useDb = jest.fn().mockReturnValue(auditConnection);
  const connection = {
    models: {
      continuum_iam_organization_memberships: memberships,
      continuum_iam_role_assignments: assignments,
      continuum_iam_roles: roles,
      continuum_iam_project_memberships: projectMemberships,
      continuum_iam_projects: projects,
    },
    startSession: jest.fn().mockResolvedValue(session),
    useDb,
  } as unknown as Connection;
  return {
    repository: new MongoProjectRepository(
      new AuthorizationPolicy(),
      connection,
    ),
    memberships,
    assignments,
    roles,
    projectMemberships,
    projects,
    audit,
    session,
    connection,
    auditConnection,
    collection,
    useDb,
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

  it('allows an active Organization member to read PUBLIC metadata without ProjectMembership', async () => {
    const { repository, projects } = fixture({
      assignmentProjectId: null,
      activeProjectId: null,
      projectVisibility: 'PUBLIC',
    });
    expect((await repository.findVisible(orgId, userId, projectId))?.id).toBe(
      projectId,
    );
    expect(projects.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(projectId),
      organizationId: new Types.ObjectId(orgId),
      visibility: 'PUBLIC',
    });
  });

  it('keeps a PRIVATE Project hidden from an active Organization member outside the Project', async () => {
    const { repository, projects } = fixture({
      assignmentProjectId: null,
      activeProjectId: null,
      projectVisibility: 'PRIVATE',
    });
    projects.findOne.mockReturnValue(query(null));
    expect(await repository.findVisible(orgId, userId, projectId)).toBeNull();
    expect(projects.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(projectId),
      organizationId: new Types.ObjectId(orgId),
      visibility: 'PUBLIC',
    });
  });

  it('does not make PUBLIC Projects visible without ACTIVE OrganizationMembership', async () => {
    const { repository, memberships, projects } = fixture({
      activeOrganization: false,
      projectVisibility: 'PUBLIC',
    });
    expect(await repository.findVisible(orgId, userId, projectId)).toBeNull();
    expect(memberships.exists).toHaveBeenCalledWith({
      organizationId: new Types.ObjectId(orgId),
      userId: new Types.ObjectId(userId),
      status: 'ACTIVE',
    });
    expect(projects.findOne).not.toHaveBeenCalled();
  });

  it('filters list before pagination to the authorized Project IDs and Organization', async () => {
    const { repository, projects } = fixture();
    const result = await repository.listVisible(orgId, userId, {
      page: 2,
      pageSize: 10,
      status: 'ACTIVE',
    });
    expect(result.totalItems).toBe(1);
    const expectedFilter = {
      organizationId: new Types.ObjectId(orgId),
      $or: [
        { visibility: 'PUBLIC' },
        { _id: { $in: [new Types.ObjectId(projectId)] } },
      ],
      status: 'ACTIVE',
    };
    expect(projects.find).toHaveBeenCalledWith(expectedFilter);
    expect(projects.countDocuments).toHaveBeenCalledWith(expectedFilter);
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
    if (
      'activeOrganization' in options &&
      options.activeOrganization === false
    ) {
      expect(projects.findOne).not.toHaveBeenCalled();
    } else {
      expect(projects.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: 'PUBLIC' }),
      );
    }
  });
});

describe('MongoProjectRepository creation', () => {
  const input = { name: 'Example', code: 'EX' };

  it('bootstraps the creator as a Project MEMBER with read access in one transaction', async () => {
    const {
      repository,
      projects,
      audit,
      session,
      useDb,
      collection,
      projectMemberships,
      assignments,
      roles,
    } = fixture();
    const created = await repository.create(orgId, userId, input);
    expect(created.id).toBe(projectId);
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(projects.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId: new Types.ObjectId(orgId),
          createdBy: new Types.ObjectId(userId),
          visibility: 'PRIVATE',
          status: 'ACTIVE',
        }),
      ],
      { session },
    );
    expect(roles.findOne).toHaveBeenCalledWith({ code: 'MEMBER' });
    expect(projectMemberships.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId: new Types.ObjectId(orgId),
          projectId: new Types.ObjectId(projectId),
          userId: new Types.ObjectId(userId),
          status: 'ACTIVE',
        }),
      ],
      { session },
    );
    expect(assignments.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          organizationId: new Types.ObjectId(orgId),
          projectId: new Types.ObjectId(projectId),
          userId: new Types.ObjectId(userId),
          roleId,
          roleCode: 'MEMBER',
          assignedBy: new Types.ObjectId(userId),
        }),
      ],
      { session },
    );
    expect(useDb).toHaveBeenCalledWith('continuum_audit', { useCache: true });
    expect(collection).toHaveBeenCalledWith('audit_logs_iam');
    expect(audit.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'project.create',
        projectId,
        actorUserId: userId,
      }),
      { session },
    );
    expect(session.endSession).toHaveBeenCalled();
  });

  it('fails closed without a configured MEMBER role with project.read', async () => {
    const {
      repository,
      projects,
      projectMemberships,
      assignments,
      audit,
      roles,
    } = fixture();
    roles.findOne.mockReturnValue(
      query({ _id: roleId, code: 'MEMBER', permissions: [] }),
    );

    await expect(repository.create(orgId, userId, input)).rejects.toThrow(
      'Project bootstrap requires a MEMBER Role with project.read',
    );
    expect(projects.create).not.toHaveBeenCalled();
    expect(projectMemberships.create).not.toHaveBeenCalled();
    expect(assignments.create).not.toHaveBeenCalled();
    expect(audit.insertOne).not.toHaveBeenCalled();
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
    const { repository, audit, session, projectMemberships, assignments } =
      fixture();
    audit.insertOne.mockRejectedValue(new Error('audit unavailable'));
    await expect(repository.create(orgId, userId, input)).rejects.toThrow(
      'audit unavailable',
    );
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(projectMemberships.create).toHaveBeenCalled();
    expect(assignments.create).toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  it('does not report an audit duplicate as a Project code conflict', async () => {
    const { repository, audit } = fixture();
    audit.insertOne.mockRejectedValue(
      Object.assign(new Error('audit duplicate'), { code: 11000 }),
    );
    await expect(repository.create(orgId, userId, input)).rejects.toMatchObject(
      { code: 11000 },
    );
  });
});
