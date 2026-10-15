import { Inject, Injectable } from '@nestjs/common';
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

  create(
    actor: AuthenticatedIdentity,
    projectId: string,
    input: TeamCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.repository.create(
      actor.organizationId,
      actor.id,
      projectId,
      input,
      idempotencyKey,
    );
  }

  update(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamUpdateInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.repository.update(
      actor.organizationId,
      actor.id,
      teamId,
      input,
      idempotencyKey,
      ifMatch,
    );
  }

  list(
    actor: AuthenticatedIdentity,
    projectId: string,
    query: TeamListQuery,
  ): Promise<TeamListResult> {
    return this.repository.list(
      actor.organizationId,
      actor.id,
      projectId,
      query,
    );
  }

  get(actor: AuthenticatedIdentity, teamId: string): Promise<TeamRecord> {
    return this.repository.get(actor.organizationId, actor.id, teamId);
  }

  archive(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamLifecycleInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.repository.archive(
      actor.organizationId,
      actor.id,
      teamId,
      input.reason,
      idempotencyKey,
      ifMatch,
    );
  }

  restore(
    actor: AuthenticatedIdentity,
    teamId: string,
    input: TeamLifecycleInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult> {
    return this.repository.restore(
      actor.organizationId,
      actor.id,
      teamId,
      input.reason,
      idempotencyKey,
      ifMatch,
    );
  }
}
