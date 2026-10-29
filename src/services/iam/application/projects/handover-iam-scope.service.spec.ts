import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { HandoverIamScopeService } from './handover-iam-scope.service';

describe('HandoverIamScopeService (C04)', () => {
  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');
  const leaderId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d31');
  const departingId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d32');
  const memberBId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d33');
  const managerOnlyId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d34');
  const outsiderId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d35');

  function createDbMock(overrides?: {
    project?: Record<string, unknown> | null;
    users?: Map<string, Record<string, unknown>>;
    orgMemberships?: Map<string, Record<string, unknown>>;
    projectMemberships?: Map<string, Record<string, unknown>>;
    roleAssignments?: Array<Record<string, unknown>>;
  }) {
    const projectDoc =
      overrides && 'project' in overrides
        ? overrides.project
        : {
            _id: projectId,
            organizationId: orgId,
            status: 'ACTIVE',
            visibility: 'PRIVATE',
          };

    const users =
      overrides?.users ??
      new Map<string, Record<string, unknown>>([
        [
          leaderId.toHexString(),
          { _id: leaderId, status: 'ACTIVE', fullName: 'Leader D' },
        ],
        [
          departingId.toHexString(),
          { _id: departingId, status: 'SUSPENDED', fullName: 'Departing A' },
        ],
        [
          memberBId.toHexString(),
          { _id: memberBId, status: 'ACTIVE', fullName: 'Successor B' },
        ],
        [
          managerOnlyId.toHexString(),
          { _id: managerOnlyId, status: 'ACTIVE', fullName: 'Org Manager' },
        ],
        [
          outsiderId.toHexString(),
          { _id: outsiderId, status: 'ACTIVE', fullName: 'Outsider' },
        ],
      ]);

    const orgMemberships =
      overrides?.orgMemberships ??
      new Map<string, Record<string, unknown>>([
        [
          leaderId.toHexString(),
          { organizationId: orgId, userId: leaderId, status: 'ACTIVE' },
        ],
        [
          departingId.toHexString(),
          { organizationId: orgId, userId: departingId, status: 'REMOVED' },
        ],
        [
          memberBId.toHexString(),
          { organizationId: orgId, userId: memberBId, status: 'ACTIVE' },
        ],
        [
          managerOnlyId.toHexString(),
          { organizationId: orgId, userId: managerOnlyId, status: 'ACTIVE' },
        ],
        [
          outsiderId.toHexString(),
          { organizationId: orgId, userId: outsiderId, status: 'ACTIVE' },
        ],
      ]);

    const projectMemberships =
      overrides?.projectMemberships ??
      new Map<string, Record<string, unknown>>([
        [
          leaderId.toHexString(),
          {
            organizationId: orgId,
            projectId,
            userId: leaderId,
            status: 'ACTIVE',
          },
        ],
        [
          departingId.toHexString(),
          {
            organizationId: orgId,
            projectId,
            userId: departingId,
            status: 'INACTIVE',
          },
        ],
        [
          memberBId.toHexString(),
          {
            organizationId: orgId,
            projectId,
            userId: memberBId,
            status: 'ACTIVE',
          },
        ],
      ]);

    const roleAssignments = overrides?.roleAssignments ?? [
      {
        organizationId: orgId,
        projectId,
        userId: leaderId,
        roleCode: 'TEAM_LEADER',
      },
      {
        organizationId: orgId,
        projectId: null,
        userId: managerOnlyId,
        roleCode: 'ADMIN',
      },
    ];

    const idStr = (val: unknown): string => {
      if (val instanceof Types.ObjectId) return val.toHexString();
      if (typeof val === 'string') return val;
      return '';
    };

    const collection = (name: string) => ({
      findOne: jest.fn((filter: Record<string, unknown>) => {
        if (name === 'projects') {
          if (
            projectDoc &&
            idStr(filter._id) === projectId.toHexString() &&
            idStr(filter.organizationId) === orgId.toHexString()
          ) {
            return Promise.resolve(projectDoc);
          }
          return Promise.resolve(null);
        }
        if (name === 'users') {
          return Promise.resolve(users.get(idStr(filter._id)) ?? null);
        }
        if (name === 'organization_memberships') {
          return Promise.resolve(
            orgMemberships.get(idStr(filter.userId)) ?? null,
          );
        }
        if (name === 'project_memberships') {
          const doc = projectMemberships.get(idStr(filter.userId)) ?? null;
          if (!doc) return Promise.resolve(null);
          if (typeof filter.status === 'string' && doc.status !== filter.status)
            return Promise.resolve(null);
          return Promise.resolve(doc);
        }
        if (name === 'role_assignments') {
          return Promise.resolve(
            roleAssignments.find((r) => {
              if (idStr(r.userId) !== idStr(filter.userId)) return false;
              if (idStr(r.organizationId) !== idStr(filter.organizationId))
                return false;
              if (filter.roleCode && r.roleCode !== filter.roleCode)
                return false;
              if ('projectId' in filter) {
                if (
                  filter.projectId === null ||
                  (typeof filter.projectId === 'object' &&
                    '$in' in filter.projectId)
                ) {
                  return r.projectId == null;
                }
                return (
                  r.projectId != null &&
                  idStr(r.projectId) === idStr(filter.projectId)
                );
              }
              return true;
            }) ?? null,
          );
        }
        return Promise.resolve(null);
      }),
    });

    const authService = {
      getCurrentIdentity: jest.fn(),
    };

    const connection = {
      db: { collection },
    };

    return new HandoverIamScopeService(
      authService as never,
      connection as never,
    );
  }

  it('validates historical departing member A even after suspension/removal from project and org', async () => {
    const svc = createDbMock();
    await expect(
      svc.assertHistoricalDepartingMember(
        orgId.toHexString(),
        projectId.toHexString(),
        departingId.toHexString(),
      ),
    ).resolves.toBeUndefined();

    await expect(
      svc.assertHistoricalDepartingMember(
        orgId.toHexString(),
        projectId.toHexString(),
        outsiderId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('grants coordinator administration to Org Manager without granting project content membership', async () => {
    const svc = createDbMock();
    const managerCtx = await svc.resolveProjectActorContext({
      actor: {
        id: managerOnlyId.toHexString(),
        email: 'manager@example.com',
        name: 'Org Manager',
        organizationId: orgId.toHexString(),
        roles: ['ADMIN'],
      },
      projectId: projectId.toHexString(),
    });

    expect(managerCtx.isProjectMember).toBe(false);
    expect(managerCtx.isProjectLeader).toBe(false);
    expect(managerCtx.canAdministerCoordinator).toBe(true);
  });

  it('conceals private project with 404 for non-member non-admin actors and cross-org headers', async () => {
    const svc = createDbMock();
    await expect(
      svc.resolveProjectActorContext({
        actor: {
          id: outsiderId.toHexString(),
          email: 'outsider@example.com',
          name: 'Outsider',
          organizationId: orgId.toHexString(),
          roles: ['MEMBER'],
        },
        projectId: projectId.toHexString(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      svc.resolveProjectActorContext({
        actor: {
          id: leaderId.toHexString(),
          email: 'leader@example.com',
          name: 'Leader',
          organizationId: orgId.toHexString(),
          roles: ['MEMBER'],
        },
        projectId: projectId.toHexString(),
        organizationHeader: '651a2b3c4d5e6f7a8b9c0d99',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires eligible active Project TEAM_LEADER for coordinator D and active member for successor B', async () => {
    const svc = createDbMock();
    await expect(
      svc.assertEligibleCoordinator(
        orgId.toHexString(),
        projectId.toHexString(),
        leaderId.toHexString(),
      ),
    ).resolves.toBeUndefined();

    // Manager who is NOT a Project TEAM_LEADER cannot be coordinator D
    await expect(
      svc.assertEligibleCoordinator(
        orgId.toHexString(),
        projectId.toHexString(),
        managerOnlyId.toHexString(),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // Suspended/inactive departing A cannot be assigned as active successor B
    await expect(
      svc.assertEligibleActiveProjectMember(
        orgId.toHexString(),
        projectId.toHexString(),
        departingId.toHexString(),
        'SUCCESSOR_NOT_ELIGIBLE',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // Active member B is eligible
    await expect(
      svc.assertEligibleActiveProjectMember(
        orgId.toHexString(),
        projectId.toHexString(),
        memberBId.toHexString(),
        'SUCCESSOR_NOT_ELIGIBLE',
      ),
    ).resolves.toBeUndefined();
  });

  it('enforces double-submit CSRF cookie + header pair on mutations', () => {
    const svc = createDbMock();
    expect(() => svc.assertValidCsrf(undefined, 'abc')).toThrow(
      ForbiddenException,
    );
    expect(() =>
      svc.assertValidCsrf('__Host-csrf=token-123', 'wrong-token'),
    ).toThrow(ForbiddenException);
    expect(() =>
      svc.assertValidCsrf(
        '__Host-csrf=token-1234567890123456',
        'token-1234567890123456',
      ),
    ).not.toThrow();
  });
});
