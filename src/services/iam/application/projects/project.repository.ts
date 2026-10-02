export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';
export type ProjectVisibility = 'PRIVATE' | 'PUBLIC';

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description?: string | null;
  visibility: ProjectVisibility;
  status: ProjectStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListQuery {
  page: number;
  pageSize: number;
  status?: ProjectStatus;
}

export interface ProjectCreateInput {
  name: string;
  code: string;
  description?: string;
}

export interface ProjectRepository {
  create(
    organizationId: string,
    creatorId: string,
    input: ProjectCreateInput,
  ): Promise<ProjectRecord>;
  listVisible(
    organizationId: string,
    userId: string,
    query: ProjectListQuery,
  ): Promise<{ data: ProjectRecord[]; totalItems: number }>;
  findVisible(
    organizationId: string,
    userId: string,
    projectId: string,
  ): Promise<ProjectRecord | null>;
}
