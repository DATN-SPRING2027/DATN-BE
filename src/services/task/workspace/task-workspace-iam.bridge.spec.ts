import { NotFoundException } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import type { AuthenticationApplicationService } from '../../iam/application/authentication/authentication.application.service';
import { TaskWorkspaceIamBridge } from './task-workspace-iam.bridge';

const userId = '651a2b3c4d5e6f7a8b9c0d1e';
const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const projectId = '651a2b3c4d5e6f7a8b9c0d20';
const otherProjectId = '651a2b3c4d5e6f7a8b9c0d21';

describe('TaskWorkspaceIamBridge role boundaries', () => {
  let bridge: TaskWorkspaceIamBridge;
  let roles: string[];
  let assignments: Array<{
    projectId: Types.ObjectId | null;
    roleCode: string;
  }>;
  let projectMember: boolean;
  let activeOrganizationMember: boolean;

  beforeEach(() => {
    roles = ['MEMBER'];
    assignments = [];
    projectMember = true;
    activeOrganizationMember = true;
    const authentication = {
      getCurrentIdentity: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ id: userId, name: 'Actor', organizationId, roles }),
        ),
    } as unknown as AuthenticationApplicationService;
    const connection = {
      db: {
        collection: (name: string) => ({
          findOne: jest.fn().mockImplementation(() =>
            Promise.resolve(
              name === 'projects'
                ? {
                    _id: new Types.ObjectId(projectId),
                    name: 'Project',
                    code: 'PRJ',
                  }
                : name === 'organization_memberships'
                  ? activeOrganizationMember
                    ? {}
                    : null
                  : name === 'project_memberships'
                    ? projectMember
                      ? {}
                      : null
                    : (assignments.find(
                        (row) =>
                          row.roleCode === 'ADMIN' && row.projectId === null,
                      ) ?? null),
            ),
          ),
          find: () => ({ toArray: () => Promise.resolve(assignments) }),
        }),
      },
    } as unknown as Connection;
    bridge = new TaskWorkspaceIamBridge(authentication, connection);
  });

  it('does not promote a Member from a stale ADMIN identity claim', async () => {
    roles = ['ADMIN'];
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).resolves.toMatchObject({ actorRole: 'MEMBER' });
    await expect(
      bridge.resolveOrgAdminContext(undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not let stale Manager claims bypass missing Project membership', async () => {
    roles = ['ADMIN'];
    projectMember = false;
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps the accepted current Manager access to organization Tasks', async () => {
    assignments = [{ projectId: null, roleCode: 'ADMIN' }];
    projectMember = false;
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).resolves.toMatchObject({ actorRole: 'ADMIN' });
    await expect(
      bridge.resolveOrgAdminContext(undefined, undefined),
    ).resolves.toMatchObject({ actorId: userId, organizationId });
  });

  it('grants Leader authority only in the matching active Project membership', async () => {
    assignments = [
      {
        projectId: new Types.ObjectId(otherProjectId),
        roleCode: 'TEAM_LEADER',
      },
    ];
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).resolves.toMatchObject({ actorRole: 'MEMBER' });
    assignments = [
      { projectId: new Types.ObjectId(projectId), roleCode: 'TEAM_LEADER' },
    ];
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).resolves.toMatchObject({ actorRole: 'TEAM_LEADER' });
    projectMember = false;
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies every role when organization membership is inactive or context mismatches', async () => {
    assignments = [{ projectId: null, roleCode: 'ADMIN' }];
    activeOrganizationMember = false;
    await expect(
      bridge.resolveProjectContext(undefined, undefined, projectId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      bridge.resolveOrgAdminContext(undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    activeOrganizationMember = true;
    await expect(
      bridge.resolveProjectContext(
        undefined,
        undefined,
        projectId,
        otherProjectId,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
