import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OrganizationMembershipCommandRepository } from '../organizations/organization-membership-command.repository';
import type {
  PlatformAdministrationRepository,
  PlatformProjectSummary,
} from './platform-administration.repository';
import { PlatformAdministrationService } from './platform-administration.service';

const projectId = '651a2b3c4d5e6f7a8b9c0d21';
const organizationId = '651a2b3c4d5e6f7a8b9c0d22';
const project: PlatformProjectSummary = {
  id: projectId,
  organization: {
    id: organizationId,
    name: 'Organization',
    slug: 'organization',
  },
  name: 'Project',
  code: 'PROJ',
  visibility: 'PRIVATE',
  status: 'ACTIVE',
  createdBy: null,
  memberCount: 0,
  leaders: [],
  leadersTruncated: false,
  teamCount: 0,
  teams: [],
  teamsTruncated: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('Platform Project application boundary', () => {
  const repository = {
    findProject: jest.fn(),
    listProjects: jest.fn(),
    listProjectMemberships: jest.fn(),
    changeProjectMetadata: jest.fn(),
    listProjectMemberCandidates: jest.fn(),
    addProjectMember: jest.fn(),
    changeProjectMemberRole: jest.fn(),
    removeProjectMember: jest.fn(),
  };
  const notificationService = {
    notifyProjectMemberAdded: jest.fn(),
    notifyProjectLeaderAssigned: jest.fn(),
    notifyProjectLeaderRevoked: jest.fn(),
    notifyProjectMemberRemoved: jest.fn(),
  };
  const service = new PlatformAdministrationService(
    repository as unknown as PlatformAdministrationRepository,
    {} as OrganizationMembershipCommandRepository,
    { isReady: jest.fn() },
    notificationService as never,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    repository.findProject.mockResolvedValue(project);
    repository.changeProjectMetadata.mockResolvedValue(project);
  });

  it('derives membership organization exclusively from the persisted Project', async () => {
    await service.listProjectMemberships({
      projectId,
      page: 1,
      pageSize: 20,
      search: ' member ',
    });
    expect(repository.listProjectMemberships).toHaveBeenCalledWith({
      projectId,
      organizationId,
      page: 1,
      pageSize: 20,
      search: 'member',
    });
  });

  it('returns 404 and never lists memberships for a missing Project', async () => {
    repository.findProject.mockResolvedValue(null);
    await expect(service.findProject(projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.listProjectMemberships({ projectId, page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.listProjectMemberships).not.toHaveBeenCalled();
  });

  it.each(['invalid', '', '1'.repeat(25)])(
    'rejects malformed Project ID %s before reading persistence',
    async (id) => {
      await expect(service.findProject(id)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(repository.findProject).not.toHaveBeenCalled();
    },
  );

  it('propagates persistence failure rather than returning an empty success', async () => {
    repository.findProject.mockRejectedValue(new Error('database unavailable'));
    await expect(service.findProject(projectId)).rejects.toThrow(
      'database unavailable',
    );
  });

  it('normalizes a metadata name and returns 404 when persistence cannot resolve the Project', async () => {
    const input = {
      actorUserId: organizationId,
      projectId,
      name: ' Reviewed ',
      expectedUpdatedAt: new Date(project.updatedAt),
      now: new Date(),
      reasonCode: 'ACCESS_REVIEW' as const,
    };
    await service.changeProjectMetadata(input);
    expect(repository.changeProjectMetadata).toHaveBeenCalledWith({
      ...input,
      name: 'Reviewed',
    });
    repository.changeProjectMetadata.mockResolvedValue(null);
    await expect(service.changeProjectMetadata(input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('supports locking/unlocking project status and notifies project member governance changes', async () => {
    await service.changeProjectMetadata({
      actorUserId: organizationId,
      projectId,
      status: 'ARCHIVED',
      expectedUpdatedAt: new Date(project.updatedAt),
      now: new Date(),
      reasonCode: 'SECURITY_INCIDENT',
    });
    expect(repository.changeProjectMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ARCHIVED' }),
    );

    const membershipId = 'cccccccccccccccccccccccc';
    const userId = 'dddddddddddddddddddddddd';
    const now = new Date('2026-11-14T00:00:00.000Z');
    repository.listProjectMemberCandidates.mockResolvedValue({
      items: [],
      total: 0,
    });
    await expect(
      service.listProjectMemberCandidates({ projectId, search: ' alice ' }),
    ).resolves.toEqual({ items: [], total: 0 });
    expect(repository.listProjectMemberCandidates).toHaveBeenCalledWith({
      projectId,
      search: 'alice',
      limit: 25,
    });

    repository.addProjectMember.mockResolvedValue({
      id: membershipId,
      projectId,
      organizationId,
      userId,
      status: 'ACTIVE',
      roleCode: 'TEAM_LEADER',
      joinedAt: now.toISOString(),
      user: {
        id: userId,
        email: 'alice@example.com',
        fullName: 'Alice',
        accountStatus: 'ACTIVE',
      },
    });
    await service.addProjectMember({
      actorUserId: organizationId,
      projectId,
      userId,
      roleCode: 'TEAM_LEADER',
      reasonCode: 'ACCESS_REVIEW',
      now,
    });
    expect(notificationService.notifyProjectMemberAdded).toHaveBeenCalledTimes(
      1,
    );
    expect(
      notificationService.notifyProjectLeaderAssigned,
    ).toHaveBeenCalledTimes(1);

    repository.changeProjectMemberRole.mockResolvedValue({
      id: membershipId,
      projectId,
      organizationId,
      userId,
      status: 'ACTIVE',
      roleCode: 'MEMBER',
      joinedAt: now.toISOString(),
      user: null,
    });
    await service.changeProjectMemberRole({
      actorUserId: organizationId,
      projectId,
      membershipId,
      roleCode: 'MEMBER',
      reasonCode: 'ACCESS_REVIEW',
      now,
    });
    expect(
      notificationService.notifyProjectLeaderRevoked,
    ).toHaveBeenCalledTimes(1);

    repository.removeProjectMember.mockResolvedValue({
      id: membershipId,
      projectId,
      organizationId,
      userId,
      status: 'INACTIVE',
      roleCode: 'MEMBER',
      joinedAt: now.toISOString(),
      user: null,
    });
    await service.removeProjectMember({
      actorUserId: organizationId,
      projectId,
      membershipId,
      reasonCode: 'SECURITY_INCIDENT',
      now,
    });
    expect(
      notificationService.notifyProjectMemberRemoved,
    ).toHaveBeenCalledTimes(1);
  });
});
