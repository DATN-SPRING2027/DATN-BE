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
  const makePublic = jest.fn().mockResolvedValue({ visibility: 'PUBLIC' });
  const access = {
    makePublic,
    listMembers: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
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
  return { auth, access, makePublic, setHeader, response, controller };
}

describe('ProjectAccessController contract validation', () => {
  it('guards each enabled route with its exact V1 permission and exposes no role-change route', () => {
    const expected = {
      makePublic: 'project.visibility.manage',
      listMembers: 'project.members.list',
      addMember: 'project.members.add',
      removeMember: 'project.members.remove',
      assignLeader: 'project.leader.manage',
      changeLeader: 'project.leader.manage',
      revokeLeader: 'project.leader.manage',
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

  it('allows only the approved PRIVATE to PUBLIC request shape', async () => {
    const { controller, makePublic, setHeader, response } = fixture();
    await controller.makePublic(
      undefined,
      undefined,
      { visibility: 'PUBLIC' },
      response,
      projectId,
    );
    expect(makePublic.mock.calls).toEqual([[actor, projectId]]);
    expect(setHeader.mock.calls).toContainEqual(['Cache-Control', 'no-store']);

    for (const body of [
      { visibility: 'PRIVATE' },
      { visibility: 'PUBLIC', organizationId: actor.organizationId },
      {},
    ]) {
      await expect(
        controller.makePublic(undefined, undefined, body, response, projectId),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    expect(makePublic.mock.calls).toHaveLength(1);
  });

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
