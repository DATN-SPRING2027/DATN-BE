import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { isEmail } from 'class-validator';
import {
  ConnectionStates,
  mongo,
  Types,
  type Connection,
  type Model,
  type PipelineStage,
} from 'mongoose';
import {
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipReadRepository,
  type OrganizationMembershipSummary,
  type OrganizationMembershipListQuery,
  type OrganizationMembershipStatus,
} from '../../application/organizations/organization-membership-read.repository';
import type { UserStatus } from '../../application/users/user-directory.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: OrganizationMembershipStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    _id: Types.ObjectId;
    fullName: string;
    email: string;
    status: UserStatus;
  } | null;
  organizationRoleAssignments?: {
    roleCode: string;
    mutationFence?: number;
    roleId: Types.ObjectId;
    catalogRoleCode?: string;
  }[];
}
const queryTimeoutMs = 5000;
function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
    message: 'Membership read prerequisites are unavailable.',
  });
}
const memberProjection = {
  _id: 1,
  organizationId: 1,
  userId: 1,
  status: 1,
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  user: 1,
  organizationRoleAssignments: 1,
};
const memberLookups: (
  PipelineStage.Lookup | PipelineStage.Unwind | PipelineStage.Project
)[] = [
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      pipeline: [{ $project: { _id: 1, fullName: 1, email: 1, status: 1 } }],
      as: 'user',
    },
  },
  { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
  {
    $lookup: {
      from: 'role_assignments',
      let: { organizationId: '$organizationId', userId: '$userId' },
      pipeline: [
        {
          $match: {
            projectId: null,
            $expr: {
              $and: [
                { $eq: ['$organizationId', '$$organizationId'] },
                { $eq: ['$userId', '$$userId'] },
              ],
            },
          },
        },
        {
          $lookup: {
            from: 'roles',
            localField: 'roleId',
            foreignField: '_id',
            pipeline: [
              { $match: { isSystem: true } },
              { $project: { _id: 0, code: 1 } },
            ],
            as: 'catalogRole',
          },
        },
        {
          $unwind: {
            path: '$catalogRole',
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 0,
            roleCode: 1,
            mutationFence: 1,
            roleId: 1,
            catalogRoleCode: '$catalogRole.code',
          },
        },
      ],
      as: 'organizationRoleAssignments',
    },
  },
  { $project: memberProjection },
];
function summary(row: MembershipDocument): OrganizationMembershipSummary {
  if (
    !(row._id instanceof Types.ObjectId) ||
    !(row.organizationId instanceof Types.ObjectId) ||
    !(row.userId instanceof Types.ObjectId) ||
    !ORGANIZATION_MEMBERSHIP_STATUSES.includes(row.status) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  )
    unavailable();
  const assignments = row.organizationRoleAssignments ?? [];
  if (!Array.isArray(assignments) || assignments.length > 1) unavailable();
  const assignment = assignments[0];
  let roleCode: OrganizationMembershipSummary['roleCode'] = null;
  let roleVersion = 0;
  if (assignment) {
    if (
      !(assignment.roleId instanceof Types.ObjectId) ||
      (assignment.roleCode !== 'ADMIN' && assignment.roleCode !== 'MEMBER') ||
      assignment.catalogRoleCode !== assignment.roleCode ||
      !Number.isSafeInteger(assignment.mutationFence) ||
      Number(assignment.mutationFence) < 0
    )
      unavailable();
    roleCode = assignment.roleCode;
    roleVersion = Number(assignment.mutationFence);
  }
  const user = row.user;
  if (
    user &&
    (!(user._id instanceof Types.ObjectId) ||
      typeof user.fullName !== 'string' ||
      typeof user.email !== 'string' ||
      !isEmail(user.email) ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(user.status))
  )
    unavailable();
  return {
    id: row._id.toHexString(),
    organizationId: row.organizationId.toHexString(),
    userId: row.userId.toHexString(),
    status: row.status,
    version: row.version,
    roleCode,
    roleVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: user
      ? {
          id: user._id.toHexString(),
          fullName: user.fullName,
          email: user.email,
          accountStatus: user.status,
        }
      : null,
  };
}

@Injectable()
export class MongoOrganizationMembershipReadRepository implements OrganizationMembershipReadRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}
  async hasReadAccess(
    organizationId: string,
    actorId: string,
  ): Promise<boolean> {
    if (
      !/^[a-f\d]{24}$/i.test(organizationId) ||
      !/^[a-f\d]{24}$/i.test(actorId)
    )
      return false;
    const scope = new Types.ObjectId(organizationId);
    const [evidence] = await this.aggregate<{
      assignments: { permissions?: unknown }[];
    }>('users', [
      { $match: { _id: new Types.ObjectId(actorId), status: 'ACTIVE' } },
      {
        $lookup: {
          from: 'organization_memberships',
          localField: '_id',
          foreignField: 'userId',
          pipeline: [
            { $match: { organizationId: scope, status: 'ACTIVE' } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: 'membership',
        },
      },
      { $match: { 'membership.0': { $exists: true } } },
      {
        $lookup: {
          from: 'role_assignments',
          localField: '_id',
          foreignField: 'userId',
          pipeline: [
            {
              $match: {
                organizationId: scope,
                projectId: null,
                roleCode: 'ADMIN',
                $expr: { $eq: [{ $type: '$roleId' }, 'objectId'] },
              },
            },
            {
              $lookup: {
                from: 'roles',
                localField: 'roleId',
                foreignField: '_id',
                pipeline: [
                  { $match: { code: 'ADMIN' } },
                  { $project: { permissions: 1 } },
                ],
                as: 'role',
              },
            },
            { $unwind: '$role' },
            { $project: { _id: 0, permissions: '$role.permissions' } },
          ],
          as: 'assignments',
        },
      },
      { $project: { _id: 0, assignments: 1 } },
    ]);
    // No explicit-deny source exists in the current IAM role model. Only a
    // well-formed, currently resolved ADMIN permission supplies positive evidence.
    return Boolean(
      evidence?.assignments.some(
        ({ permissions }) =>
          Array.isArray(permissions) &&
          permissions.every((permission) => typeof permission === 'string') &&
          permissions.includes('organization.memberships.read'),
      ),
    );
  }
  async list(organizationId: string, query: OrganizationMembershipListQuery) {
    const [facet] = await this.aggregate<{
      data: MembershipDocument[];
      total: { count: number }[];
    }>('organization_memberships', [
      {
        $match: {
          organizationId: new Types.ObjectId(organizationId),
          ...(query.status ? { status: query.status } : {}),
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: (query.page - 1) * query.pageSize },
            { $limit: query.pageSize },
            ...memberLookups,
          ],
          total: [{ $count: 'count' }],
        },
      },
    ]);
    return {
      data: (facet?.data ?? []).map(summary),
      totalItems: facet?.total[0]?.count ?? 0,
    };
  }
  async find(
    organizationId: string,
    membershipId: string,
  ): Promise<OrganizationMembershipSummary | null> {
    const [row] = await this.aggregate<MembershipDocument>(
      'organization_memberships',
      [
        {
          $match: {
            organizationId: new Types.ObjectId(organizationId),
            _id: new Types.ObjectId(membershipId),
          },
        },
        { $limit: 1 },
        ...memberLookups,
      ],
    );
    return row ? summary(row) : null;
  }
  private async aggregate<T>(
    collection: string,
    pipeline: PipelineStage[],
  ): Promise<T[]> {
    try {
      return await this.model(collection)
        .aggregate<T>(pipeline)
        .option({ maxTimeMS: queryTimeoutMs })
        .exec();
    } catch (error) {
      if (
        error instanceof mongo.MongoNetworkError ||
        error instanceof mongo.MongoServerSelectionError ||
        error instanceof mongo.MongoOperationTimeoutError ||
        error instanceof mongo.MongoNotConnectedError ||
        error instanceof mongo.MongoClientClosedError ||
        error instanceof mongo.MongoServerClosedError ||
        error instanceof mongo.MongoTopologyClosedError ||
        (error instanceof mongo.MongoServerError && error.code === 50)
      )
        unavailable();
      throw error;
    }
  }
  private model(collection: string): Model<unknown> {
    if (this.connection?.readyState !== ConnectionStates.connected)
      unavailable();
    const model = this.connection?.models[
      `${IAM_PERSISTENCE.databaseName}_${collection}`
    ] as Model<unknown> | undefined;
    if (!model) unavailable();
    return model;
  }
}
