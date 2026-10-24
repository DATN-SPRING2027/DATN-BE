import {
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { ProjectService } from '../application/projects/project.service';
import { ProjectController } from './project.controller';

const actor = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  email: 'member@example.test',
  name: 'Member',
  roles: ['MEMBER'],
};
const otherOrg = 'cccccccccccccccccccccccc';

function fixture() {
  const auth = { getCurrentIdentity: jest.fn().mockResolvedValue(actor) };
  const projects = {
    list: jest.fn().mockResolvedValue({ data: [] }),
    listSuggestions: jest.fn().mockResolvedValue({ data: [] }),
    get: jest.fn().mockResolvedValue({ id: 'project' }),
    create: jest.fn().mockResolvedValue({ id: 'project' }),
    listMemberCandidates: jest.fn().mockResolvedValue({ data: [] }),
  };
  const response = { setHeader: jest.fn() } as unknown as Response;
  const controller = new ProjectController(
    auth as unknown as AuthenticationApplicationService,
    projects as unknown as ProjectService,
  );
  return { auth, projects, response, controller };
}

describe('ProjectController trusted Organization boundary', () => {
  it('validates Project create payload against the accepted contract', async () => {
    const { controller, projects, response } = fixture();
    await controller.create(
      undefined,
      undefined,
      { name: ' Example ', code: 'EX' },
      response,
    );
    expect(projects.create).toHaveBeenCalledWith(actor, {
      name: 'Example',
      code: 'EX',
    });
    for (const body of [
      { code: 'EX' },
      { name: 'Example', code: 'ex' },
      { name: 'Example', code: 'EX', organizationId: otherOrg },
      { name: 'Example', code: 'EX', description: 'x'.repeat(2001) },
    ]) {
      await expect(
        controller.create(undefined, undefined, body, response),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    expect(projects.create).toHaveBeenCalledTimes(1);

    await controller.create(
      undefined,
      undefined,
      {
        name: 'Public Project',
        code: 'PUB1',
        visibility: 'PUBLIC',
        memberUserIds: ['dddddddddddddddddddddddd', 'DDDDDDDDDDDDDDDDDDDDDDDD'],
        leaderUserIds: ['eeeeeeeeeeeeeeeeeeeeeeee'],
      },
      response,
    );
    expect(projects.create).toHaveBeenLastCalledWith(actor, {
      name: 'Public Project',
      code: 'PUB1',
      visibility: 'PUBLIC',
      memberUserIds: ['dddddddddddddddddddddddd'],
      leaderUserIds: ['eeeeeeeeeeeeeeeeeeeeeeee'],
    });
  });

  it('lists active organization member candidates for project creation', async () => {
    const { controller, projects, response } = fixture();
    await controller.listMemberCandidates(
      undefined,
      undefined,
      actor.organizationId,
      { search: ' alice ' },
      response,
    );
    expect(projects.listMemberCandidates).toHaveBeenCalledWith(actor, 'alice');
    await expect(
      controller.listMemberCandidates(
        undefined,
        undefined,
        actor.organizationId,
        { search: 'x'.repeat(201) },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('rejects unauthenticated list and detail before repository access', async () => {
    const { auth, projects, response, controller } = fixture();
    auth.getCurrentIdentity.mockRejectedValue(new UnauthorizedException());
    await expect(
      controller.list(undefined, undefined, undefined, {}, response),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      controller.get(
        undefined,
        undefined,
        undefined,
        undefined,
        'dddddddddddddddddddddddd',
        response,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(projects.list).not.toHaveBeenCalled();
    expect(projects.get).not.toHaveBeenCalled();
  });

  it('rejects forged Organization selectors from header or query', async () => {
    const { projects, response, controller } = fixture();
    await expect(
      controller.list(undefined, undefined, otherOrg, {}, response),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.list(
        undefined,
        undefined,
        undefined,
        { organizationId: otherOrg },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.get(
        undefined,
        undefined,
        otherOrg,
        undefined,
        'dddddddddddddddddddddddd',
        response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(projects.list).not.toHaveBeenCalled();
    expect(projects.get).not.toHaveBeenCalled();
  });

  it('passes trusted context and validated list query', async () => {
    const { projects, response, controller } = fixture();
    await controller.list(
      undefined,
      undefined,
      actor.organizationId,
      {
        page: '2',
        pageSize: '5',
        status: 'ACTIVE',
        q: 'Apollo',
        includeTotal: 'false',
      },
      response,
    );
    expect(projects.listSuggestions).toHaveBeenCalledWith(actor, {
      page: 2,
      pageSize: 5,
      status: 'ACTIVE',
      q: 'Apollo',
      includeTotal: false,
    });
    await expect(
      controller.list(
        undefined,
        undefined,
        actor.organizationId,
        { includeTotal: 'no' },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
