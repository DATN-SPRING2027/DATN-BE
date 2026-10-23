export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED';
export type ProjectVisibility = 'PRIVATE' | 'PUBLIC';

export interface ProjectLeaderSummary {
  userId: string;
  fullName: string;
  email: string;
  roleCode?: 'TEAM_LEADER' | 'MEMBER';
}

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
  activeMemberCount?: number;
  effectiveLeaderCount?: number;
  leaders?: ProjectLeaderSummary[];
  memberPreviews?: ProjectLeaderSummary[];
  requiresLeaderRecovery?: boolean;
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
  visibility?: ProjectVisibility;
  memberUserIds?: string[];
  leaderUserIds?: string[];
}

export interface ProjectOrganizationMemberCandidate {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl?: string | null;
  roleCode: string;
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
  listOrganizationMemberCandidates?(
    organizationId: string,
    actorUserId: string,
    search?: string,
  ): Promise<ProjectOrganizationMemberCandidate[]>;
}
