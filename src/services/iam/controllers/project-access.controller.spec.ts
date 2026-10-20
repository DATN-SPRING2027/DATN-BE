import { UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import { ProjectAccessAuthorizationGuard } from '../application/authorization/project-access-authorization.guard';
import type { ProjectAccessService } from '../application/projects/project-access.service';
import { ProjectAccessController } from './project-access.controller';

const actor = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  email: 'leader@example.test',
  name: 'Leader',
  roles: ['TEAM_LEADER'],
};
const projectId = 'cccccccccccccccccccccccc';
const memberId = 'dddddddddddddddddddddddd';
const replacementId = 'eeeeeeeeeeeeeeeeeeeeeeee';

function fixture() {
  const auth = { getCurrentIdentity: jest.fn().mockResolvedValue(actor) };
  const changeVisibility = jest
    .fn()
    .mockResolvedValue({ visibility: 'PUBLIC' });
  const access = {
    changeVisibility,
    updateSettings: jest
      .fn()
      .mockResolvedValue({ id: projectId, name: 'Updated' }),
    listLeaders: jest.fn().mockResolvedValue({ data: [] }),
    listLeaderCandidates: jest.fn().mockResolvedValue({ data: [] }),
    listMembers: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
    listMemberCandidates: jest.fn().mockResolvedValue({ data: [] }),
    addMember: jest.fn().mockResolvedValue({ id: 'membership' }),
    removeMember: jest.fn().mockResolvedValue(undefined),
    assignLeader: jest.fn().mockResolvedValue(undefined),
    changeLeader: jest.fn().mockResolvedValue(undefined),
    revokeLeader: jest.fn().mockResolvedValue(undefined),
  };
  const setHeader = jest.fn();
  const response = { setHeader } as unknown as Response;
  const controller = new ProjectAccessController(
    auth as unknown as AuthenticationApplicationService,
    access as unknown as ProjectAccessService,
  );
  return { auth, access, changeVisibility, setHeader, response, controller };
}

describe('ProjectAccessController contract validation', () => {
  it('guards each enabled route with its exact V1 permission and exposes no role-change route', () => {
    const expected = {
      getSettingsAccess: 'project.update',
      updateSettings: 'project.update',
      changeVisibility: 'project.visibility.manage',
      getVisibilityAccess: 'project.visibility.manage',
      listMembers: 'project.members.list',
      listMemberCandidates: 'project.members.add',
      addMember: 'project.members.add',
      removeMember: 'project.members.remove',
      assignLeader: 'project.leader.manage',
      changeLeader: 'project.leader.manage',
      revokeLeader: 'project.leader.manage',
      listLeaders: 'project.leader.manage',
      listLeaderCandidates: 'project.leader.manage',
    } as const;
    const prototype = ProjectAccessController.prototype;

    expect(
      Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual(Object.keys(expected).sort());

    for (const [methodName, permission] of Object.entries(expected)) {
      const handler = Object.getOwnPropertyDescriptor(prototype, methodName)
        ?.value as (...args: never[]) => unknown;
      expect(
        Reflect.getMetadata('iam.project.access.permission', handler),
      ).toBe(permission);
      expect(Reflect.getMetadata('__guards__', handler)).toContain(
        ProjectAccessAuthorizationGuard,
      );
      expect(typeof handler).toBe('function');
    }
  });

  it('returns a no-store settings access signal and delegates validated Project details', async () => {
    const { controller, response, setHeader, access } = fixture();
    expect(controller.getSettingsAccess(response)).toEqual({
      canUpdateProject: true,
    });
    await controller.updateSettings(
      undefined,
      undefined,
      { name: '  Updated name  ', description: null },
      response,
      projectId,
    );
    expect(access.updateSettings).toHaveBeenCalledWith(actor, projectId, {
      name: 'Updated name',
      description: null,
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');

    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { description: 'x'.repeat(2001) },
      { description: 3 },
      { name: 'Name', code: 'MUTATE-CODE' },
      null,
    ]) {
      await expect(
        controller.updateSettings(
          undefined,
          undefined,
          body,
          response,
          projectId,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    expect(access.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('lists a safe Leader projection and searches eligible Leader candidates by email', async () => {
    const { controller, access, response, setHeader } = fixture();
    const leader = {
      userId: memberId,
      fullName: 'Example Leader',
      email: 'leader@example.test',
      avatarUrl: null,
      role: 'TEAM_LEADER',
      status: 'ACTIVE',
    };
    access.listLeaders.mockResolvedValue({ data: [leader] });
    await expect(
      controller.listLeaders(undefined, undefined, response, projectId),
    ).resolves.toEqual({ data: [leader] });
    await controller.listLeaderCandidates(
      undefined,
      undefined,
      ' member@example.test ',
      response,
      projectId,
    );
    expect(access.listLeaderCandidates).toHaveBeenCalledWith(
      actor,
      projectId,
      'member@example.test',
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('checks access through a read-only guarded route without mutation', () => {
    const { controller, response, setHeader, access } = fixture();
    expect(controller.getVisibilityAccess(response)).toEqual({
      canManageVisibility: true,
    });
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(access.changeVisibility).not.toHaveBeenCalled();
  });

  it.each(['PUBLIC', 'PRIVATE'])(
    'accepts a visibility-only %s request',
    async (visibility) => {
      const { controller, changeVisibility, setHeader, response } = fixture();
      await controller.changeVisibility(
        undefined,
        undefined,
        { visibility },
        response,
        projectId,
      );
      expect(changeVisibility.mock.calls).toEqual([
        [actor, projectId, visibility],
      ]);
      expect(setHeader.mock.calls).toContainEqual([
        'Cache-Control',
        'no-store',
      ]);

      for (const body of [
        { visibility: 'INTERNAL' },
        { visibility: null },
        { visibility: 'PUBLIC', organizationId: actor.organizationId },
        {},
      ]) {
        await expect(
          controller.changeVisibility(
            undefined,
            undefined,
            body,
            response,
            projectId,
          ),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      }
      expect(changeVisibility.mock.calls).toHaveLength(1);
    },
  );

  it('accepts scoped member pagination and rejects unsupported status values', async () => {
    const { controller, access, response } = fixture();
    await controller.listMembers(
      undefined,
      undefined,
      { page: '2', pageSize: '10', status: 'INACTIVE' },
      response,
      projectId,
    );
    expect(access.listMembers).toHaveBeenCalledWith(actor, projectId, {
      page: 2,
      pageSize: 10,
      status: 'INACTIVE',
    });
    await expect(
      controller.listMembers(
        undefined,
        undefined,
        { status: 'PENDING' },
        response,
        projectId,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('lists member candidates filtered by search with no-store cache header', async () => {
    const { controller, access, response, setHeader } = fixture();
    await controller.listMemberCandidates(
      undefined,
      undefined,
      'candidate@example.test',
      undefined,
      response,
      projectId,
    );
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(access.listMemberCandidates).toHaveBeenCalledWith(
      actor,
      projectId,
      'candidate@example.test',
    );
  });

  it('does not accept client-selected roles when adding a Project member', async () => {
    const { controller, access, response } = fixture();
    await expect(
      controller.addMember(
        undefined,
        undefined,
        { userId: memberId, roleCode: 'TEAM_LEADER' },
        response,
        projectId,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(access.addMember).not.toHaveBeenCalled();

    await controller.addMember(
      undefined,
      undefined,
      { userId: memberId },
      response,
      projectId,
    );
    expect(access.addMember).toHaveBeenCalledWith(actor, projectId, memberId);
  });

  it('replaces one Project Leader only when the two target users differ', async () => {
    const { controller, access, response } = fixture();
    await expect(
      controller.changeLeader(
        undefined,
        undefined,
        { previousUserId: memberId, nextUserId: memberId },
        projectId,
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(access.changeLeader).not.toHaveBeenCalled();

    await controller.changeLeader(
      undefined,
      undefined,
      { previousUserId: memberId, nextUserId: replacementId },
      projectId,
      response,
    );
    expect(access.changeLeader).toHaveBeenCalledWith(
      actor,
      projectId,
      memberId,
      replacementId,
    );
  });

  it('supports only validated ADMIN-routed Leader appointment targets', async () => {
    const { controller, access, response } = fixture();
    await controller.assignLeader(
      undefined,
      undefined,
      { userId: memberId },
      projectId,
      response,
    );
    expect(access.assignLeader).toHaveBeenCalledWith(
      actor,
      projectId,
      memberId,
    );

    await controller.revokeLeader(
      undefined,
      undefined,
      projectId,
      memberId,
      response,
    );
    expect(access.revokeLeader).toHaveBeenCalledWith(
      actor,
      projectId,
      memberId,
    );
  });
});
