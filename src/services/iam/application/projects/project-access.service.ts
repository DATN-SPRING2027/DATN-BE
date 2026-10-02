import { Inject, Injectable } from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import {
  PROJECT_ACCESS_REPOSITORY,
  type ProjectAccessRepository,
  type ProjectMembershipListQuery,
} from './project-access.repository';

@Injectable()
export class ProjectAccessService {
  constructor(
    @Inject(PROJECT_ACCESS_REPOSITORY)
    private readonly repository: ProjectAccessRepository,
  ) {}

  makePublic(actor: AuthenticatedIdentity, projectId: string) {
    return this.repository.makePublic(
      actor.organizationId,
      actor.id,
      projectId,
    );
  }

  async listMembers(
    actor: AuthenticatedIdentity,
    projectId: string,
    query: ProjectMembershipListQuery,
  ) {
    const result = await this.repository.listMembers(
      actor.organizationId,
      projectId,
      query,
    );
    return {
      data: result.data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / query.pageSize),
      },
    };
  }

  addMember(actor: AuthenticatedIdentity, projectId: string, userId: string) {
    return this.repository.addMember(
      actor.organizationId,
      actor.id,
      projectId,
      userId,
    );
  }

  removeMember(
    actor: AuthenticatedIdentity,
    projectId: string,
    membershipId: string,
  ) {
    return this.repository.removeMember(
      actor.organizationId,
      actor.id,
      projectId,
      membershipId,
    );
  }

  assignLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    userId: string,
  ) {
    return this.repository.assignLeader(
      actor.organizationId,
      actor.id,
      projectId,
      userId,
    );
  }

  changeLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    previousUserId: string,
    nextUserId: string,
  ) {
    return this.repository.changeLeader(
      actor.organizationId,
      actor.id,
      projectId,
      previousUserId,
      nextUserId,
    );
  }

  revokeLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    userId: string,
  ) {
    return this.repository.revokeLeader(
      actor.organizationId,
      actor.id,
      projectId,
      userId,
    );
  }
}
