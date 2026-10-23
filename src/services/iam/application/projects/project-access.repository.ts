import type { ProjectRecord } from './project.repository';

export const PROJECT_ACCESS_REPOSITORY = Symbol('PROJECT_ACCESS_REPOSITORY');

export interface ProjectMembershipRecord {
  id: string;
  organizationId: string;
  projectId: string;
  userId: string;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: string;
  user?: {
    id: string;
    fullName?: string;
    email: string;
    avatarUrl?: string | null;
  } | null;
}

export interface ProjectMemberCandidateRecord {
  userId: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  organizationMembershipStatus: 'ACTIVE';
  isProjectMember: boolean;
}

export interface ProjectLeaderRecord {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: 'TEAM_LEADER';
  status: 'ACTIVE' | 'INACTIVE';
}

export interface ProjectLeaderCandidateRecord {
  userId: string;
  fullName: string;
  email: string;
  avatarUrl: string | null;
  role: 'MEMBER';
  status: 'ACTIVE';
}

export type ProjectSettingsUpdateInput = Readonly<{
  name?: string;
  description?: string | null;
}>;

export interface ProjectMembershipListQuery {
  page: number;
  pageSize: number;
  status?: ProjectMembershipRecord['status'];
}

export interface ProjectAccessRepository {
  updateSettings(
    organizationId: string,
    actorId: string,
    projectId: string,
    input: ProjectSettingsUpdateInput,
  ): Promise<ProjectRecord>;
  changeVisibility(
    organizationId: string,
    actorId: string,
    projectId: string,
    visibility: ProjectRecord['visibility'],
  ): Promise<ProjectRecord>;
  listMembers(
    organizationId: string,
    projectId: string,
    query: ProjectMembershipListQuery,
  ): Promise<{ data: ProjectMembershipRecord[]; totalItems: number }>;
  listMemberCandidates(
    organizationId: string,
    projectId: string,
    search?: string,
  ): Promise<ProjectMemberCandidateRecord[]>;
  listLeaders(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectLeaderRecord[]>;
  listLeaderCandidates(
    organizationId: string,
    projectId: string,
    search?: string,
  ): Promise<ProjectLeaderCandidateRecord[]>;
  addMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
    role?: 'MEMBER' | 'TEAM_LEADER',
  ): Promise<ProjectMembershipRecord>;
  removeMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    membershipId: string,
  ): Promise<void>;
  assignLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
  ): Promise<void>;
  changeLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    previousUserId: string,
    nextUserId: string,
  ): Promise<void>;
  revokeLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
  ): Promise<void>;
}
