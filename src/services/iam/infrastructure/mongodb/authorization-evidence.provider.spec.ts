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
