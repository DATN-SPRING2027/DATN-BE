import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
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
  ) {}

  async create(
    actor: AuthenticatedIdentity,
    input: ProjectCreateInput,
  ): Promise<ProjectRecord> {
    return this.repository.create(actor.organizationId, actor.id, input);
  }

  async list(actor: AuthenticatedIdentity, query: ProjectListQuery) {
    const result = await this.repository.listVisible(
      actor.organizationId,
      actor.id,
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
}
