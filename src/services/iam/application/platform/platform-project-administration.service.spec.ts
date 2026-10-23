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
  memberCount: 0,
  leaders: [],
  leadersTruncated: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

describe('Platform Project application boundary', () => {
  const repository = {
    findProject: jest.fn(),
    listProjects: jest.fn(),
    listProjectMemberships: jest.fn(),
    changeProjectMetadata: jest.fn(),
  };
  const service = new PlatformAdministrationService(
    repository as unknown as PlatformAdministrationRepository,
    {} as OrganizationMembershipCommandRepository,
    { isReady: jest.fn() },
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
});
