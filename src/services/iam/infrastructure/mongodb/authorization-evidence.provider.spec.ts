import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function query<T>(value: T) {
  const result = { lean: jest.fn(), exec: jest.fn().mockResolvedValue(value) };
  result.lean.mockReturnValue(result);
  return result;
}

async function loadProjectAccessWithRolePermissions(permissions: unknown) {
  const projectId = 'cccccccccccccccccccccccc';
  const roleId = new Types.ObjectId('dddddddddddddddddddddddd');
  const connection = {
    models: {
      continuum_iam_projects: {
        findOne: jest.fn().mockReturnValue(
          query({
            _id: new Types.ObjectId(projectId),
            organizationId: new Types.ObjectId(orgId),
            status: 'ACTIVE',
            visibility: 'PRIVATE',
          }),
        ),
      },
      continuum_iam_organization_memberships: {
        findOne: jest.fn().mockReturnValue(query(null)),
      },
      continuum_iam_project_memberships: {
        findOne: jest.fn().mockReturnValue(query(null)),
      },
      continuum_iam_role_assignments: {
        find: jest.fn().mockReturnValue(
          query([
            {
              organizationId: new Types.ObjectId(orgId),
              userId: new Types.ObjectId(userId),
              projectId: new Types.ObjectId(projectId),
              roleId,
              roleCode: 'TEAM_LEADER',
            },
          ]),
        ),
      },
      continuum_iam_roles: {
        find: jest
          .fn()
          .mockReturnValue(
            query([{ _id: roleId, code: 'TEAM_LEADER', permissions }]),
          ),
      },
    },
  } as unknown as Connection;

  return new MongoAuthorizationEvidenceProvider(connection).loadProjectAccess(
    userId,
    orgId,
    projectId,
  );
}

describe('MongoAuthorizationEvidenceProvider for project.create', () => {
  it('loads only ACTIVE Organization Membership evidence', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
        }),
      ),
    };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
      },
    } as unknown as Connection;

    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);

    expect(evidence).toEqual({
      membership: { userId, organizationId: orgId, status: 'ACTIVE' },
      explicitDeny: 'CLEAR',
    });
    expect(memberships.findOne).toHaveBeenCalledWith(
      {
        userId: new Types.ObjectId(userId),
        organizationId: new Types.ObjectId(orgId),
        status: 'ACTIVE',
      },
      { userId: 1, organizationId: 1, status: 1 },
    );
  });

  it('returns no eligible membership when the ACTIVE membership lookup misses', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(query(null)),
    };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
      },
    } as unknown as Connection;

    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);

    expect(evidence).toEqual({ membership: null, explicitDeny: 'CLEAR' });
  });

  it('rejects malformed identifiers before querying persistence', async () => {
    const connection = { models: {} } as unknown as Connection;
    const provider = new MongoAuthorizationEvidenceProvider(connection);

    await expect(provider.loadProjectCreate('invalid', orgId)).resolves.toBe(
      null,
    );
    await expect(provider.loadProjectCreate(userId, 'invalid')).resolves.toBe(
      null,
    );
  });
});

describe('MongoAuthorizationEvidenceProvider for Project access', () => {
  it('loads exact organization, user, project, membership, and current Role evidence', async () => {
    const projectId = 'cccccccccccccccccccccccc';
    const roleId = new Types.ObjectId('dddddddddddddddddddddddd');
    const projects = {
      findOne: jest.fn().mockReturnValue(
        query({
          _id: new Types.ObjectId(projectId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
          visibility: 'PRIVATE',
        }),
      ),
    };
    const organizationMemberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
        }),
      ),
    };
    const projectMemberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          projectId: new Types.ObjectId(projectId),
          status: 'ACTIVE',
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(
        query([
          {
            organizationId: new Types.ObjectId(orgId),
            userId: new Types.ObjectId(userId),
            projectId: new Types.ObjectId(projectId),
            roleId,
            roleCode: 'TEAM_LEADER',
          },
        ]),
      ),
    };
    const roles = {
      find: jest.fn().mockReturnValue(
        query([
          {
            _id: roleId,
            code: 'TEAM_LEADER',
            permissions: ['project.members.list'],
          },
        ]),
      ),
    };
    const connection = {
      models: {
        continuum_iam_projects: projects,
        continuum_iam_organization_memberships: organizationMemberships,
        continuum_iam_project_memberships: projectMemberships,
        continuum_iam_role_assignments: assignments,
        continuum_iam_roles: roles,
      },
    } as unknown as Connection;

    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectAccess(userId, orgId, projectId);

    expect(evidence).toMatchObject({
      project: {
        id: projectId,
        organizationId: orgId,
        status: 'ACTIVE',
        visibility: 'PRIVATE',
      },
      projectMembership: {
        userId,
        organizationId: orgId,
        projectId,
        status: 'ACTIVE',
      },
      assignments: [
        {
          userId,
          organizationId: orgId,
          projectId,
          roleCode: 'TEAM_LEADER',
          resolvedRoleCode: 'TEAM_LEADER',
          permissions: ['project.members.list'],
        },
      ],
    });
    expect(projectMemberships.findOne).toHaveBeenCalledWith(
      {
        userId: new Types.ObjectId(userId),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectId),
      },
      { userId: 1, organizationId: 1, projectId: 1, status: 1 },
    );
    expect(assignments.find).toHaveBeenCalledWith(
      {
        organizationId: new Types.ObjectId(orgId),
        userId: new Types.ObjectId(userId),
        $or: [
          { projectId: { $exists: false } },
          { projectId: null },
          { projectId: new Types.ObjectId(projectId) },
        ],
      },
      {
        organizationId: 1,
        userId: 1,
        roleId: 1,
        roleCode: 1,
        projectId: 1,
      },
    );
  });

  it('fails closed when Role.permissions is not an array of strings', async () => {
    const scalarEvidence = await loadProjectAccessWithRolePermissions(
      'prefixproject.members.list',
    );
    const mixedEvidence = await loadProjectAccessWithRolePermissions([
      'project.members.list',
      null,
    ]);
    const missingEvidence =
      await loadProjectAccessWithRolePermissions(undefined);

    expect(scalarEvidence?.assignments[0].permissions).toEqual([]);
    expect(mixedEvidence?.assignments[0].permissions).toEqual([]);
    expect(missingEvidence?.assignments[0].permissions).toEqual([]);
  });

  it('starts project, membership, and role-assignment lookups concurrently in one round-trip', async () => {
    const projectId = 'cccccccccccccccccccccccc';
    let releaseProject!: (doc: unknown) => void;
    const projectChain = {
      lean: jest.fn(),
      exec: jest.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseProject = resolve;
          }),
      ),
    };
    projectChain.lean.mockReturnValue(projectChain);

    const projects = { findOne: jest.fn().mockReturnValue(projectChain) };
    const organizationMemberships = {
      findOne: jest.fn().mockReturnValue(query(null)),
    };
    const projectMemberships = {
      findOne: jest.fn().mockReturnValue(query(null)),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(query([])),
    };
    const connection = {
      models: {
        continuum_iam_projects: projects,
        continuum_iam_organization_memberships: organizationMemberships,
        continuum_iam_project_memberships: projectMemberships,
        continuum_iam_role_assignments: assignments,
      },
    } as unknown as Connection;

    const pending = new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectAccess(userId, orgId, projectId);
    await Promise.resolve();

    expect(projects.findOne).toHaveBeenCalledTimes(1);
    expect(organizationMemberships.findOne).toHaveBeenCalledTimes(1);
    expect(projectMemberships.findOne).toHaveBeenCalledTimes(1);
    expect(assignments.find).toHaveBeenCalledTimes(1);

    releaseProject({
      _id: new Types.ObjectId(projectId),
      organizationId: new Types.ObjectId(orgId),
      status: 'ACTIVE',
      visibility: 'PUBLIC',
    });
    await expect(pending).resolves.toMatchObject({
      project: { id: projectId, status: 'ACTIVE', visibility: 'PUBLIC' },
    });
  });
});

describe('MongoAuthorizationEvidenceProvider for platform permission', () => {
  it('loads a fresh exact-user assignment snapshot on every authorization check', async () => {
    const assignments = {
      find: jest
        .fn()
        .mockReturnValueOnce(
          query([
            {
              subjectUserId: new Types.ObjectId(userId),
              grantedAt: new Date('2026-10-05T11:00:00.000Z'),
              grantedBy: new Types.ObjectId('ffffffffffffffffffffffff'),
              permission: 'platform.health.read',
              scope: 'PLATFORM',
              status: 'ACTIVE',
              expiresAt: null,
              revokedAt: null,
            },
          ]),
        )
        .mockReturnValueOnce(
          query([
            {
              subjectUserId: new Types.ObjectId(userId),
              grantedAt: new Date('2026-10-05T11:00:00.000Z'),
              grantedBy: new Types.ObjectId('ffffffffffffffffffffffff'),
              permission: 'platform.health.read',
              scope: 'PLATFORM',
              status: 'REVOKED',
              expiresAt: null,
              revokedAt: new Date('2026-10-05T12:00:00.000Z'),
            },
          ]),
        ),
    };
    const connection = {
      models: {
        continuum_iam_platform_authority_assignments: assignments,
      },
    } as unknown as Connection;
    const provider = new MongoAuthorizationEvidenceProvider(connection);

    const beforeRevoke = await provider.loadPlatformPermission(
      userId,
      'platform.health.read',
    );
    const afterRevoke = await provider.loadPlatformPermission(
      userId,
      'platform.health.read',
    );

    expect(beforeRevoke?.assignments[0]).toMatchObject({
      subjectUserId: userId,
      grantedAt: new Date('2026-10-05T11:00:00.000Z'),
      grantedBy: 'ffffffffffffffffffffffff',
      permission: 'platform.health.read',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      expiresAt: null,
      revokedAt: null,
    });
    expect(afterRevoke?.assignments[0].status).toBe('REVOKED');
    expect(assignments.find).toHaveBeenCalledTimes(2);
    expect(assignments.find).toHaveBeenCalledWith(
      {
        subjectUserId: new Types.ObjectId(userId),
        permission: 'platform.health.read',
      },
      {
        subjectUserId: 1,
        grantedAt: 1,
        grantedBy: 1,
        permission: 1,
        scope: 1,
        status: 1,
        expiresAt: 1,
        revokedAt: 1,
      },
    );
  });
});
