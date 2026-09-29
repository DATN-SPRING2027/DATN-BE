import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const roleId = new Types.ObjectId('cccccccccccccccccccccccc');
const adminId = 'dddddddddddddddddddddddd';

function query<T>(value: T) {
  const result = { lean: jest.fn(), exec: jest.fn().mockResolvedValue(value) };
  result.lean.mockReturnValue(result);
  return result;
}

describe('MongoAuthorizationEvidenceProvider', () => {
  it('loads only active membership and organization-level assignments with matching Role records', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(
        query([
          {
            userId: new Types.ObjectId(userId),
            organizationId: new Types.ObjectId(orgId),
            roleId,
            roleCode: 'ADMIN',
          },
        ]),
      ),
    };
    const roles = {
      find: jest.fn().mockReturnValue(query([{ _id: roleId, code: 'ADMIN' }])),
    };
    const grants = { find: jest.fn().mockReturnValue(query([])) };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
        continuum_iam_role_assignments: assignments,
        continuum_iam_roles: roles,
        continuum_iam_organization_capability_grants: grants,
      },
    } as unknown as Connection;
    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);
    expect(evidence?.membership?.status).toBe('ACTIVE');
    expect(evidence?.roleAssignments).toEqual([
      { userId, organizationId: orgId, projectId: null, roleCode: 'ADMIN' },
    ]);
    expect(evidence?.explicitDeny).toBe('CLEAR');
    expect(assignments.find).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: new Types.ObjectId(userId),
        organizationId: new Types.ObjectId(orgId),
        projectId: null,
      }),
      expect.any(Object),
    );
    expect(roles.find).toHaveBeenCalledWith(
      { _id: { $in: [roleId] } },
      { _id: 1, code: 1 },
    );
  });

  it('does not turn a dangling or mismatched Role into permission evidence', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
        }),
      ),
    };
    const assignments = {
      find: jest.fn().mockReturnValue(
        query([
          {
            userId: new Types.ObjectId(userId),
            organizationId: new Types.ObjectId(orgId),
            roleId,
            roleCode: 'ADMIN',
          },
        ]),
      ),
    };
    const roles = {
      find: jest.fn().mockReturnValue(query([{ _id: roleId, code: 'MEMBER' }])),
    };
    const grants = {
      find: jest.fn().mockReturnValue(
        query([
          {
            userId: new Types.ObjectId(userId),
            organizationId: new Types.ObjectId(orgId),
            capability: 'project.create',
            grantedBy: new Types.ObjectId(adminId),
          },
        ]),
      ),
    };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
        continuum_iam_role_assignments: assignments,
        continuum_iam_roles: roles,
        continuum_iam_organization_capability_grants: grants,
      },
    } as unknown as Connection;
    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);
    expect(evidence?.roleAssignments).toEqual([]);
    expect(evidence?.grants).toEqual([
      {
        userId,
        organizationId: orgId,
        capability: 'project.create',
        expiresAt: undefined,
        revokedAt: undefined,
      },
    ]);
  });

  it('does not load permissions without an ACTIVE membership', async () => {
    const memberships = { findOne: jest.fn().mockReturnValue(query(null)) };
    const assignments = { find: jest.fn() };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
        continuum_iam_role_assignments: assignments,
      },
    } as unknown as Connection;
    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);
    expect(evidence?.membership).toBeNull();
    expect(assignments.find).not.toHaveBeenCalled();
  });
});
