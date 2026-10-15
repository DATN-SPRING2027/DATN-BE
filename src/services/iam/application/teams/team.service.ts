import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import {
  TEAM_FOUNDATION_REPOSITORY,
  type TeamCommandResult,
  type TeamFoundationRepository,
  type TeamListResult,
  type TeamRecord,
} from './team.repository';
import type {
  TeamCreateInput,
  TeamListQuery,
  TeamLifecycleInput,
  TeamUpdateInput,
} from './team-contract';

@Injectable()
export class TeamService {
  constructor(
    @Inject(TEAM_FOUNDATION_REPOSITORY)
    private readonly repository: TeamFoundationRepository,
  ) {}

  private async execute<T>(
    operation: () => Promise<T>,
    failure: 'TEAM_COMMAND_FAILED' | 'TEAM_READ_FAILED',
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: failure,
        message:
          failure === 'TEAM_COMMAND_FAILED'
            ? 'Team command failed.'
            : 'Team read failed.',
      });
    }
  }

  create(
    actor: AuthenticatedIdentity,
    projectId: string,
    input: TeamCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.execute(
      () =>
        this.repository.create(
          actor.organizationId,
          actor.id,
          projectId,
          input,
          idempotencyKey,
        ),
      'TEAM_COMMAND_FAILED',
    );
  }

  update(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamUpdateInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.execute(
      () =>
        this.repository.update(
          actor.organizationId,
          actor.id,
          teamId,
          input,
          idempotencyKey,
          ifMatch,
        ),
      'TEAM_COMMAND_FAILED',
    );
  }

  list(
    actor: AuthenticatedIdentity,
    projectId: string,
    query: TeamListQuery,
  ): Promise<TeamListResult> {
    return this.execute(
      () =>
        this.repository.list(actor.organizationId, actor.id, projectId, query),
      'TEAM_READ_FAILED',
    );
  }

  get(actor: AuthenticatedIdentity, teamId: string): Promise<TeamRecord> {
    return this.execute(
      () => this.repository.get(actor.organizationId, actor.id, teamId),
      'TEAM_READ_FAILED',
    );
  }

  archive(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamLifecycleInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.execute(
      () =>
        this.repository.archive(
          actor.organizationId,
          actor.id,
          teamId,
          input.reason,
          idempotencyKey,
          ifMatch,
        ),
      'TEAM_COMMAND_FAILED',
    );
  }

  restore(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamLifecycleInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.execute(
      () =>
        this.repository.restore(
          actor.organizationId,
          actor.id,
          teamId,
          input.reason,
          idempotencyKey,
          ifMatch,
        ),
      'TEAM_COMMAND_FAILED',
    );
  }
}
