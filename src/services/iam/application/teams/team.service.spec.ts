import {
  HttpException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import type { TeamFoundationRepository } from './team.repository';
import { TeamService } from './team.service';

describe('TeamService error mapping', () => {
  const actor = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    organizationId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
  } as AuthenticatedIdentity;

  it('maps unexpected command failures to the shared Team command code', async () => {
    const repository = {
      create: jest.fn(() => {
        throw new Error('mongodb://private-host/password=secret');
      }),
    } as unknown as TeamFoundationRepository;
    const service = new TeamService(repository);

    const error = await service
      .create(
        actor,
        'cccccccccccccccccccccccc',
        { name: 'Operations', code: 'OPS', description: null },
        'create:1',
      )
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(InternalServerErrorException);
    expect((error as HttpException).getStatus()).toBe(500);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'TEAM_COMMAND_FAILED',
      message: 'Team command failed.',
    });
    expect(
      JSON.stringify((error as HttpException).getResponse()),
    ).not.toContain('private-host');
  });

  it('maps unexpected read failures and preserves known HTTP errors', async () => {
    const failedReadRepository = {
      list: jest.fn().mockRejectedValue(new Error('database details')),
    } as unknown as TeamFoundationRepository;
    const failedReadService = new TeamService(failedReadRepository);
    const readError = await failedReadService
      .list(actor, 'cccccccccccccccccccccccc', {
        page: 1,
        pageSize: 20,
        status: 'ACTIVE',
      })
      .catch((failure: unknown) => failure);

    expect(readError).toBeInstanceOf(InternalServerErrorException);
    expect((readError as HttpException).getResponse()).toMatchObject({
      code: 'TEAM_READ_FAILED',
      message: 'Team read failed.',
    });

    const knownError = new ServiceUnavailableException({
      code: 'TEAM_POLICY_NOT_READY',
      message: 'Team persistence is not ready.',
    });
    const unavailableReadRepository = {
      list: jest.fn().mockRejectedValue(knownError),
    } as unknown as TeamFoundationRepository;
    const unavailableReadService = new TeamService(unavailableReadRepository);

    await expect(
      unavailableReadService.list(actor, 'cccccccccccccccccccccccc', {
        page: 1,
        pageSize: 20,
        status: 'ACTIVE',
      }),
    ).rejects.toBe(knownError);
  });
});
