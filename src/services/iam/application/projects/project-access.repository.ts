import type { ProjectRecord } from './project.repository';

export const PROJECT_ACCESS_REPOSITORY = Symbol('PROJECT_ACCESS_REPOSITORY');

export interface ProjectMembershipRecord {
  id: string;
  organizationId: string;
  projectId: string;
  userId: string;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: string;
}

export interface ProjectMembershipListQuery {
  page: number;
  pageSize: number;
  status?: ProjectMembershipRecord['status'];
}

export interface ProjectAccessRepository {
  makePublic(
    organizationId: string,
    actorId: string,
    projectId: string,
  ): Promise<ProjectRecord>;
  listMembers(
    organizationId: string,
    projectId: string,
    query: ProjectMembershipListQuery,
  ): Promise<{ data: ProjectMembershipRecord[]; totalItems: number }>;
  addMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
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
