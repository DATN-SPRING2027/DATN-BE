import type {
  TeamCreateInput,
  TeamListQuery,
  TeamStatus,
  TeamUpdateInput,
} from './team-contract';

export const TEAM_FOUNDATION_REPOSITORY = Symbol('TEAM_FOUNDATION_REPOSITORY');

export interface TeamRecord {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  code: string;
  description: string | null;
  status: TeamStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
}

export interface TeamCommandResult {
  statusCode: 200 | 201;
  team: TeamRecord;
  etag: string;
  location?: string;
  replayed: boolean;
}

export interface TeamListResult {
  data: TeamRecord[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface TeamFoundationRepository {
  create(
    organizationId: string,
    actorUserId: string,
    projectId: string,
    input: TeamCreateInput,
    idempotencyKey: string | undefined,
  ): Promise<TeamCommandResult>;
  update(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    input: TeamUpdateInput,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult>;
  list(
    organizationId: string,
    actorUserId: string,
    projectId: string,
    query: TeamListQuery,
  ): Promise<TeamListResult>;
  get(
    organizationId: string,
    actorUserId: string,
    teamId: string,
  ): Promise<TeamRecord>;
  archive(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    reason: string,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult>;
  restore(
    organizationId: string,
    actorUserId: string,
    teamId: string,
    reason: string,
    idempotencyKey: string | undefined,
    ifMatch: string | undefined,
  ): Promise<TeamCommandResult>;
}
