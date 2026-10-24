import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import { NotificationService } from '../../../notification/notification.service';
import {
  PROJECT_ACCESS_REPOSITORY,
  type ProjectAccessRepository,
  type ProjectMembershipListQuery,
  type ProjectSettingsUpdateInput,
} from './project-access.repository';

@Injectable()
export class ProjectAccessService {
  constructor(
    @Inject(PROJECT_ACCESS_REPOSITORY)
    private readonly repository: ProjectAccessRepository,
    @Optional()
    private readonly notificationService?: NotificationService,
  ) {}

  updateSettings(
    actor: AuthenticatedIdentity,
    projectId: string,
    input: ProjectSettingsUpdateInput,
  ) {
    return this.repository.updateSettings(
      actor.organizationId,
      actor.id,
      projectId,
      input,
    );
  }

  changeVisibility(
    actor: AuthenticatedIdentity,
    projectId: string,
    visibility: 'PRIVATE' | 'PUBLIC',
  ) {
    return this.repository.changeVisibility(
      actor.organizationId,
      actor.id,
      projectId,
      visibility,
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

  async listMemberCandidates(
    actor: AuthenticatedIdentity,
    projectId: string,
    search?: string,
  ) {
    const searchTerm = search?.trim();
    const candidates = await this.repository.listMemberCandidates(
      actor.organizationId,
      projectId,
      searchTerm && searchTerm.length > 0 ? searchTerm : undefined,
    );
    return { data: candidates };
  }

  async listLeaders(actor: AuthenticatedIdentity, projectId: string) {
    const leaders = await this.repository.listLeaders(
      actor.organizationId,
      projectId,
    );
    return { data: leaders };
  }

  async listLeaderCandidates(
    actor: AuthenticatedIdentity,
    projectId: string,
    search?: string,
  ) {
    const candidates = await this.repository.listLeaderCandidates(
      actor.organizationId,
      projectId,
      search,
    );
    return { data: candidates };
  }

  async addMember(
    actor: AuthenticatedIdentity,
    projectId: string,
    userId: string,
    role?: 'MEMBER' | 'TEAM_LEADER',
  ) {
    const result = role
      ? await this.repository.addMember(
          actor.organizationId,
          actor.id,
          projectId,
          userId,
          role,
        )
      : await this.repository.addMember(
          actor.organizationId,
          actor.id,
          projectId,
          userId,
        );

    if (this.notificationService) {
      const eventId = `add:${result.id}:${Date.now()}`;
      if (role === 'TEAM_LEADER') {
        await this.notificationService.notifyProjectLeaderAssigned({
          actorId: actor.id,
          recipientUserIds: [userId],
          organizationId: actor.organizationId,
          projectId,
          eventId,
        });
      } else {
        await this.notificationService.notifyProjectMemberAdded({
          actorId: actor.id,
          recipientUserIds: [userId],
          organizationId: actor.organizationId,
          projectId,
          eventId,
        });
      }
    }

    return result;
  }

  async removeMember(
    actor: AuthenticatedIdentity,
    projectId: string,
    membershipId: string,
  ) {
    await this.repository.removeMember(
      actor.organizationId,
      actor.id,
      projectId,
      membershipId,
    );

    if (this.notificationService) {
      await this.notificationService.notifyProjectMemberRemoved({
        actorId: actor.id,
        membershipId,
        organizationId: actor.organizationId,
        projectId,
        eventId: `remove:${membershipId}:${Date.now()}`,
      });
    }
  }

  async assignLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    userId: string,
  ) {
    const result = await this.repository.assignLeader(
      actor.organizationId,
      actor.id,
      projectId,
      userId,
    );

    if (this.notificationService) {
      await this.notificationService.notifyProjectLeaderAssigned({
        actorId: actor.id,
        recipientUserIds: [userId],
        organizationId: actor.organizationId,
        projectId,
        eventId: `assign:${userId}:${Date.now()}`,
      });
    }

    return result;
  }

  async changeLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    previousUserId: string,
    nextUserId: string,
  ) {
    const result = await this.repository.changeLeader(
      actor.organizationId,
      actor.id,
      projectId,
      previousUserId,
      nextUserId,
    );

    if (this.notificationService) {
      await this.notificationService.notifyProjectLeaderChanged({
        actorId: actor.id,
        previousLeaderUserId: previousUserId,
        nextLeaderUserId: nextUserId,
        organizationId: actor.organizationId,
        projectId,
        eventId: `change:${previousUserId}:${nextUserId}:${Date.now()}`,
      });
    }

    return result;
  }

  async revokeLeader(
    actor: AuthenticatedIdentity,
    projectId: string,
    userId: string,
  ) {
    const result = await this.repository.revokeLeader(
      actor.organizationId,
      actor.id,
      projectId,
      userId,
    );

    if (this.notificationService) {
      await this.notificationService.notifyProjectLeaderRevoked({
        actorId: actor.id,
        recipientUserId: userId,
        organizationId: actor.organizationId,
        projectId,
        eventId: `revoke:${userId}:${Date.now()}`,
      });
    }

    return result;
  }
}
