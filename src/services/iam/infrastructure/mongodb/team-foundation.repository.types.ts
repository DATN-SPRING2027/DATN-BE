import { Types } from 'mongoose';
import type { Document } from 'mongodb';
import type { TeamAuthorizationEvaluationInput } from '../../application/teams/team-authorization.policy';
import type { TeamRecord } from '../../application/teams/team.repository';
import { IAM_PERSISTENCE } from '../persistence';

export interface TeamDocument extends Document {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
  code: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  archivedBy: Types.ObjectId | null;
  archivedReason: string | null;
  __v?: number;
}

export interface UserDocument extends Document {
  _id: Types.ObjectId;
  status: string;
}

export interface OrganizationMembershipDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}

export interface ProjectDocument extends Document {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}

export interface ProjectMembershipDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  status: string;
}

export interface RoleAssignmentDocument extends Document {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  projectId?: Types.ObjectId | null;
}

export interface RoleDocument extends Document {
  _id: Types.ObjectId;
  code: string;
  permissions?: unknown;
}

export interface TeamOperationDocument extends Document {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  keyHash: string;
  fingerprint: string;
  status: 'IN_PROGRESS' | 'COMMITTED';
  commandId: string;
  expiresAt: Date;
  httpStatus?: number;
  responseBody?: TeamRecord;
  etag?: string;
  location?: string;
}

export interface ReadinessIndex {
  unique?: boolean;
  expireAfterSeconds?: number;
  key: Record<string, 1 | -1>;
  partialFilterExpression?: Record<string, unknown>;
  sparse?: boolean;
  hidden?: boolean;
  collation?: Record<string, unknown>;
}

export interface AuthorizationFacts {
  user: UserDocument | null;
  organizationMembership: OrganizationMembershipDocument | null;
  project: ProjectDocument;
  projectMembership: ProjectMembershipDocument | null;
  assignments: Array<{
    document: RoleAssignmentDocument;
    role: RoleDocument | null;
    evidence: TeamAuthorizationEvaluationInput['assignments'][number];
  }>;
}

export interface MutationCommand {
  organizationId: string;
  actorUserId: string;
  method: 'POST' | 'PATCH';
  path: string;
  permission: 'team.create' | 'team.update' | 'team.archive' | 'team.restore';
  idempotencyKey: string | undefined;
  ifMatch?: string;
  body: Record<string, unknown>;
  projectId?: string;
  teamId?: string;
}

export interface PendingResult {
  statusCode: 200 | 201;
  team: TeamRecord;
  etag: string;
  location?: string;
}

export const modelName = (collection: string): string =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;

export const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

export const objectId = (value: string): Types.ObjectId =>
  new Types.ObjectId(value);
