import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import type { ProjectAccessRepository } from './project-access.repository';
import { ProjectAccessService } from './project-access.service';

describe('ProjectAccessService', () => {
  const actor: AuthenticatedIdentity = {
    id: 'user-leader-1',
    organizationId: 'org-1',
    email: 'leader@example.test',
    name: 'Project Leader',
    roles: ['TEAM_LEADER'],
  };
  const projectId = 'proj-1';

  let listMemberCandidates: jest.Mock;
  let listMembers: jest.Mock;
  let addMember: jest.Mock;
  let listLeaders: jest.Mock;
  let listLeaderCandidates: jest.Mock;
  let updateSettings: jest.Mock;
  let service: ProjectAccessService;

  beforeEach(() => {
    listMemberCandidates = jest.fn();
    listMembers = jest.fn();
    addMember = jest.fn();
    listLeaders = jest.fn();
    listLeaderCandidates = jest.fn();
    updateSettings = jest.fn();
    const repository: ProjectAccessRepository = {
      changeVisibility: jest.fn(),
      updateSettings,
      listLeaders,
      listLeaderCandidates,
      listMembers,
      listMemberCandidates,
      addMember,
      removeMember: jest.fn(),
      assignLeader: jest.fn(),
      changeLeader: jest.fn(),
      revokeLeader: jest.fn(),
    };
    service = new ProjectAccessService(repository);
  });

  it('delegates Project settings updates with trusted organization, actor and project', async () => {
    updateSettings.mockResolvedValue({ id: projectId, name: 'Updated' });
    await expect(
      service.updateSettings(actor, projectId, { name: 'Updated' }),
    ).resolves.toMatchObject({ name: 'Updated' });
    expect(updateSettings).toHaveBeenCalledWith(
      'org-1',
      'user-leader-1',
      'proj-1',
      {
        name: 'Updated',
      },
    );
  });

  it('returns Leader and candidate projections without widening their fields', async () => {
    const leaders = [{ userId: 'user-2', role: 'TEAM_LEADER' as const }];
    const candidates = [{ userId: 'user-3', email: 'candidate@example.test' }];
    listLeaders.mockResolvedValue(leaders);
    listLeaderCandidates.mockResolvedValue(candidates);

    await expect(service.listLeaders(actor, projectId)).resolves.toEqual({
      data: leaders,
    });
    await expect(
      service.listLeaderCandidates(actor, projectId, 'candidate@example.test'),
    ).resolves.toEqual({ data: candidates });
    expect(listLeaders).toHaveBeenCalledWith('org-1', 'proj-1');
    expect(listLeaderCandidates).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'candidate@example.test',
    );
  });

  it('delegates listMemberCandidates with actor organizationId and projectId', async () => {
    const candidates = [
      {
        userId: 'user-2',
        email: 'member@example.test',
        fullName: 'Dev Member',
        avatarUrl: null,
        organizationMembershipStatus: 'ACTIVE' as const,
        isProjectMember: false,
      },
    ];
    listMemberCandidates.mockResolvedValue(candidates);

    const result = await service.listMemberCandidates(
      actor,
      projectId,
      'member@example.test',
    );

    expect(listMemberCandidates).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'member@example.test',
    );
    expect(result).toEqual({ data: candidates });
  });

  it('does not query member candidates when the search is missing or blank', async () => {
    await expect(
      service.listMemberCandidates(actor, projectId),
    ).resolves.toEqual({ data: [] });
    await expect(
      service.listMemberCandidates(actor, projectId, '   '),
    ).resolves.toEqual({ data: [] });

    expect(listMemberCandidates).not.toHaveBeenCalled();
  });

  it('delegates listMembers and returns paginated result', async () => {
    listMembers.mockResolvedValue({
      data: [
        {
          id: 'mem-1',
          organizationId: 'org-1',
          projectId: 'proj-1',
          userId: 'user-leader-1',
          status: 'ACTIVE',
          joinedAt: '2026-10-19T00:00:00.000Z',
          user: {
            id: 'user-leader-1',
            email: 'leader@example.test',
            fullName: 'Project Leader',
            avatarUrl: null,
          },
        },
      ],
      totalItems: 1,
    });

    const result = await service.listMembers(actor, projectId, {
      page: 1,
      pageSize: 20,
    });

    expect(listMembers).toHaveBeenCalledWith('org-1', 'proj-1', {
      page: 1,
      pageSize: 20,
    });
    expect(result.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 1,
      totalPages: 1,
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].user?.email).toBe('leader@example.test');
  });

  it('delegates addMember to repository with actor organizationId and actor id', async () => {
    addMember.mockResolvedValue({
      id: 'mem-2',
      organizationId: 'org-1',
      projectId: 'proj-1',
      userId: 'user-2',
      status: 'ACTIVE',
      joinedAt: '2026-10-19T00:00:00.000Z',
    });

    const result = await service.addMember(actor, projectId, 'user-2');

    expect(addMember).toHaveBeenCalledWith(
      'org-1',
      'user-leader-1',
      'proj-1',
      'user-2',
    );
    expect(result.userId).toBe('user-2');
  });
});
