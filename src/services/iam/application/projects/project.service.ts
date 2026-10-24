import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import { NotificationService } from '../../../notification/notification.service';
import {
  PROJECT_REPOSITORY,
  type ProjectCreateInput,
  type ProjectListQuery,
  type ProjectRecord,
  type ProjectRepository,
} from './project.repository';

@Injectable()
export class ProjectService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly repository: ProjectRepository,
    @Optional()
    private readonly notificationService?: NotificationService,
  ) {}

  async create(
    actor: AuthenticatedIdentity,
    input: ProjectCreateInput,
  ): Promise<ProjectRecord> {
    const project = await this.repository.create(
      actor.organizationId,
      actor.id,
      input,
    );

    if (this.notificationService) {
      const leaderSet = new Set<string>([
        ...(input.leaderUserIds ?? []),
        ...(input.initialLeaderUserIds ?? []),
      ]);
      const memberIds = [
        ...(input.memberUserIds ?? []),
        ...(input.initialMemberUserIds ?? []),
      ].filter((id: string) => !leaderSet.has(id));
      if (leaderSet.size > 0) {
        await this.notificationService.notifyProjectLeaderAssigned({
          actorId: actor.id,
          recipientUserIds: [...leaderSet],
          organizationId: actor.organizationId,
          projectId: project.id,
          projectName: project.name,
          eventId: `create_leaders:${project.id}`,
        });
      }
      if (memberIds.length > 0) {
        await this.notificationService.notifyProjectMemberAdded({
          actorId: actor.id,
          recipientUserIds: memberIds,
          organizationId: actor.organizationId,
          projectId: project.id,
          projectName: project.name,
          eventId: `create_members:${project.id}`,
        });
      }
    }

    return project;
  }

  async list(actor: AuthenticatedIdentity, query: ProjectListQuery) {
    const result = await this.repository.listVisible(
      actor.organizationId,
      actor.id,
      { ...query, includeTotal: true },
    );
    const totalItems = result.totalItems ?? 0;
    return {
      data: result.data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async listSuggestions(
    actor: AuthenticatedIdentity,
    query: ProjectListQuery & { q: string },
  ) {
    const result = await this.repository.listVisible(
      actor.organizationId,
      actor.id,
      { ...query, includeTotal: false },
    );
    return {
      data: result.data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        hasMore: result.hasMore ?? false,
      },
    };
  }

  async get(
    actor: AuthenticatedIdentity,
    projectId: string,
  ): Promise<ProjectRecord> {
    const project = await this.repository.findVisible(
      actor.organizationId,
      actor.id,
      projectId,
    );
    if (!project)
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    return project;
  }

  async listMemberCandidates(actor: AuthenticatedIdentity, search?: string) {
    const data = this.repository.listOrganizationMemberCandidates
      ? await this.repository.listOrganizationMemberCandidates(
          actor.organizationId,
          actor.id,
          search,
        )
      : [];
    return { data };
  }
}
