import {
  autocompleteClause,
  CHAT_SEARCH_INDEX,
  literalPrefixRange,
} from '../../../../common/search/indexed-search';
import { normalizeSearchText } from '../../../../common/search/literal-search';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, PipelineStage } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  UserDirectoryRepository as UserDirectoryRepositoryPort,
  UserListQuery,
  UserRecord,
  UserStatus,
  UserUpdate,
  ChatCandidate,
} from '../../application/users/user-directory.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  fullName: string;
  avatarUrl?: string | null;
  status: UserStatus;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
interface AssignmentDocument {
  userId: Types.ObjectId;
  roleCode: string;
  roleId: Types.ObjectId;
}
interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}
interface MembershipDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}
interface UserListFacet {
  data: UserDocument[];
  total: { count: number }[];
}

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const organizationLevel = {
  $or: [{ projectId: { $exists: false } }, { projectId: null }],
};
const organizationMembershipManagePermission =
  'organization.memberships.manage';
const publicUserFields = {
  email: 1,
  fullName: 1,
  avatarUrl: 1,
  status: 1,
  lastLoginAt: 1,
  createdAt: 1,
  updatedAt: 1,
} as const;

@Injectable()
export class MongoUserDirectoryRepository implements UserDirectoryRepositoryPort {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async isAdmin(organizationId: string, actorId: string): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(actorId)
    )
      return false;
    const eligibleAdminIds = await this.eligibleAdminIds(
      new Types.ObjectId(organizationId),
    );
    return eligibleAdminIds.some(
      (id) => id.toHexString() === actorId.toLowerCase(),
    );
  }

  async list(organizationId: string, query: UserListQuery) {
    const organizationObjectId = new Types.ObjectId(organizationId);
    const pipeline: PipelineStage[] = [
      {
        $match: { organizationId: organizationObjectId, status: 'ACTIVE' },
      },
      ...(query.roleCode
        ? ([
            {
              $lookup: {
                from: 'role_assignments',
                localField: 'userId',
                foreignField: 'userId',
                pipeline: [
                  {
                    $match: {
                      organizationId: organizationObjectId,
                      ...organizationLevel,
                      roleCode: query.roleCode,
                    },
                  },
                  { $project: { _id: 1 } },
                ],
                as: 'matchingRole',
              },
            },
            { $match: { 'matchingRole.0': { $exists: true } } },
          ] as PipelineStage[])
        : []),
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [{ $project: publicUserFields }],
          as: 'user',
        },
      },
      { $unwind: '$user' },
      ...(query.status
        ? [{ $match: { 'user.status': query.status } } as PipelineStage]
        : []),
      { $sort: { 'user.createdAt': -1, userId: -1 } },
      {
        $facet: {
          data: [
            { $skip: (query.page - 1) * query.pageSize },
            { $limit: query.pageSize },
            { $replaceRoot: { newRoot: '$user' } },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];
    const [facet] = await this.memberships()
      .aggregate<UserListFacet>(pipeline)
      .allowDiskUse(true)
      .exec();
    return {
      data: await this.withRoles(organizationObjectId, facet?.data ?? []),
      totalItems: facet?.total[0]?.count ?? 0,
    };
  }

  async find(
    organizationId: string,
    userId: string,
  ): Promise<UserRecord | null> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(userId)
    )
      return null;
    const organizationObjectId = new Types.ObjectId(organizationId);
    const userObjectId = new Types.ObjectId(userId);
    const membership = await this.memberships().exists({
      organizationId: organizationObjectId,
      userId: userObjectId,
      status: 'ACTIVE',
    });
    if (!membership) return null;
    const assignments = await this.assignments()
      .find(
        {
          organizationId: organizationObjectId,
          userId: userObjectId,
          ...organizationLevel,
        },
        { userId: 1, roleCode: 1, _id: 0 },
      )
      .lean()
      .exec();
    const user = await this.users()
      .findById(userObjectId, publicUserFields)
      .lean()
      .exec();
    return user
      ? this.mapUser(
          user,
          assignments.map((row) => row.roleCode),
        )
      : null;
  }

  async searchChatCandidates(
    organizationId: string,
    actorId: string,
    search = '',
  ): Promise<ChatCandidate[]> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(actorId)
    )
      return [];
    const trimmed = search.trim();
    const membershipFilter: PipelineStage[] = [
      {
        $match: { status: 'ACTIVE', _id: { $ne: new Types.ObjectId(actorId) } },
      },
      {
        $lookup: {
          from: 'organization_memberships',
          localField: '_id',
          foreignField: 'userId',
          pipeline: [
            {
              $match: {
                organizationId: new Types.ObjectId(organizationId),
                status: 'ACTIVE',
              },
            },
          ],
          as: 'activeMembership',
        },
      },
      { $match: { 'activeMembership.0': { $exists: true } } },
    ];
    const projectionStage: PipelineStage = {
      $project: {
        _id: 0,
        id: { $toString: '$_id' },
        fullName: 1,
        email: 1,
        avatarUrl: { $ifNull: ['$avatarUrl', null] },
      },
    };
    if (!trimmed) {
      return this.listOrganizationCandidates(
        organizationId,
        actorId,
        50,
        membershipFilter,
        projectionStage,
      );
    }
    const emailPrefix = trimmed.includes('@') ? trimmed.toLowerCase() : null;
    if (!emailPrefix && normalizeSearchText(trimmed).length < 2) {
      return this.filterOrganizationCandidates(
        organizationId,
        actorId,
        trimmed,
        membershipFilter,
        projectionStage,
      );
    }
    const pipeline: PipelineStage[] = [
      ...(emailPrefix
        ? [{ $match: { email: literalPrefixRange(emailPrefix) } }]
        : ([
            {
              $search: {
                index: CHAT_SEARCH_INDEX,
                compound: {
                  should: [
                    autocompleteClause('fullName', trimmed),
                    autocompleteClause('email', trimmed),
                  ],
                  minimumShouldMatch: 1,
                },
              },
            },
          ] as PipelineStage[])),
      ...membershipFilter,
      ...(emailPrefix
        ? ([
            {
              $addFields: {
                searchRank: { $cond: [{ $eq: ['$email', emailPrefix] }, 0, 1] },
              },
            },
            { $sort: { searchRank: 1, email: 1, _id: 1 } },
          ] as PipelineStage[])
        : []),
      { $limit: 20 },
      projectionStage,
    ];
    try {
      return await this.users().aggregate<ChatCandidate>(pipeline).exec();
    } catch {
      return this.filterOrganizationCandidates(
        organizationId,
        actorId,
        trimmed,
        membershipFilter,
        projectionStage,
      );
    }
  }

  private async listOrganizationCandidates(
    organizationId: string,
    actorId: string,
    limit: number,
    membershipFilter: PipelineStage[],
    projectionStage: PipelineStage,
  ): Promise<ChatCandidate[]> {
    const membershipsModel = this.connection?.models[
      modelName('organization_memberships')
    ] as Model<MembershipDocument> | undefined;
    if (membershipsModel) {
      return membershipsModel
        .aggregate<ChatCandidate>([
          {
            $match: {
              organizationId: new Types.ObjectId(organizationId),
              userId: { $ne: new Types.ObjectId(actorId) },
              status: 'ACTIVE',
            },
          },
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              pipeline: [
                { $match: { status: 'ACTIVE' } },
                { $project: { fullName: 1, email: 1, avatarUrl: 1 } },
              ],
              as: 'user',
            },
          },
          { $unwind: '$user' },
          { $sort: { 'user.fullName': 1, userId: 1 } },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: { $toString: '$userId' },
              fullName: '$user.fullName',
              email: '$user.email',
              avatarUrl: { $ifNull: ['$user.avatarUrl', null] },
            },
          },
        ])
        .exec();
    }
    return this.users()
      .aggregate<ChatCandidate>([
        ...membershipFilter,
        { $sort: { fullName: 1, _id: 1 } },
        { $limit: limit },
        projectionStage,
      ])
      .exec();
  }

  private async filterOrganizationCandidates(
    organizationId: string,
    actorId: string,
    trimmed: string,
    membershipFilter: PipelineStage[],
    projectionStage: PipelineStage,
  ): Promise<ChatCandidate[]> {
    const allMembers = await this.listOrganizationCandidates(
      organizationId,
      actorId,
      1000,
      membershipFilter,
      projectionStage,
    );
    const normalizedTokens = normalizeSearchText(trimmed)
      .split(/\s+/)
      .filter(Boolean);
    const lowerQuery = trimmed.toLowerCase();
    return allMembers
      .filter((candidate) => {
        const normalizedName = normalizeSearchText(candidate.fullName);
        const lowerEmail = candidate.email?.toLowerCase() ?? '';
        const matchesTokens =
          normalizedTokens.length > 0 &&
          normalizedTokens.every(
            (token) =>
              normalizedName.includes(token) || lowerEmail.includes(token),
          );
        return matchesTokens || lowerEmail.includes(lowerQuery);
      })
      .slice(0, 20);
  }

  async findChatCandidates(
    organizationId: string,
    actorId: string,
    userIds: string[],
  ): Promise<ChatCandidate[]> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(actorId)
    )
      return [];
    const ids = [...new Set(userIds.map((id) => id.toLowerCase()))]
      .filter(
        (id) => id !== actorId.toLowerCase() && Types.ObjectId.isValid(id),
      )
      .map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return [];
    const pipeline: PipelineStage[] = [
      {
        $match: {
          organizationId: new Types.ObjectId(organizationId),
          userId: { $in: ids },
          status: 'ACTIVE',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $match: { status: 'ACTIVE' } },
            { $project: { fullName: 1, email: 1, avatarUrl: 1 } },
          ],
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $project: {
          _id: 0,
          id: { $toString: '$userId' },
          fullName: '$user.fullName',
          email: '$user.email',
          avatarUrl: { $ifNull: ['$user.avatarUrl', null] },
        },
      },
    ];
    return this.memberships().aggregate<ChatCandidate>(pipeline).exec();
  }

  async update(
    organizationId: string,
    userId: string,
    changes: UserUpdate,
    actorId: string,
  ): Promise<UserRecord | null> {
    const before = await this.find(organizationId, userId);
    if (!before) return null;
    if (changes.status !== undefined) {
      await this.updateStatusAtomically(
        organizationId,
        userId,
        actorId,
        changes,
      );
      return this.find(organizationId, userId);
    }
    await this.updateProfileAtomically(
      organizationId,
      userId,
      actorId,
      changes,
    );
    return this.find(organizationId, userId);
  }

  private async updateProfileAtomically(
    organizationId: string,
    userId: string,
    actorId: string,
    changes: UserUpdate,
  ): Promise<void> {
    if (!this.connection)
      throw new Error('User directory persistence unavailable');
    const session = await this.connection.startSession();
    const userObjectId = new Types.ObjectId(userId);
    try {
      await session.withTransaction(async () => {
        const existing = await this.users()
          .findById(userObjectId, { fullName: 1, avatarUrl: 1 })
          .session(session)
          .lean()
          .exec();
        if (!existing) return;
        await this.users()
          .updateOne({ _id: userObjectId }, { $set: changes }, { session })
          .exec();
        await this.connection!.useDb(AUDIT_DATABASE_NAME, { useCache: true })
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .insertOne(
            {
              eventId: randomUUID(),
              schemaVersion: 2,
              operationId: new Types.ObjectId().toHexString(),
              organizationId,
              actorUserId: actorId,
              action: 'ORGANIZATION_USER_PROFILE_UPDATED',
              scope: 'ORGANIZATION',
              result: 'SUCCESS',
              occurredAt: new Date(),
              reasonCode: 'ORGANIZATION_USER_PROFILE_UPDATED',
              targetResource: 'USER',
              targetResourceId: userId,
              before: {
                fullName: existing.fullName,
                avatarUrl: existing.avatarUrl ?? '',
              },
              after: {
                fullName: changes.fullName ?? existing.fullName,
                avatarUrl:
                  changes.avatarUrl !== undefined
                    ? (changes.avatarUrl ?? '')
                    : (existing.avatarUrl ?? ''),
              },
            },
            { session },
          );
      });
    } finally {
      await session.endSession();
    }
  }

  private async updateStatusAtomically(
    organizationId: string,
    userId: string,
    actorId: string,
    changes: UserUpdate,
  ): Promise<void> {
    if (!this.connection)
      throw new Error('User directory persistence unavailable');
    const session = await this.connection.startSession();
    const userObjectId = new Types.ObjectId(userId);
    const actorObjectId = new Types.ObjectId(actorId);
    const organizationObjectId = new Types.ObjectId(organizationId);
    try {
      await session.withTransaction(async () => {
        // Every status update writes the same organization document before
        // counting admins. Concurrent transactions then conflict and retry.
        const guard = await this.organizations()
          .updateOne(
            { _id: organizationObjectId },
            {
              $inc: { membershipAdminRevision: 1 },
              $currentDate: { updatedAt: true },
            },
            { session },
          )
          .exec();
        if (guard.matchedCount !== 1) {
          throw new ConflictException({
            code: 'ORGANIZATION_NOT_FOUND',
            message: 'Organization is unavailable.',
          });
        }

        // Recheck the actor from current IAM records only after taking the
        // Organization fence. This callback runs again on transaction retry.
        const eligibleAdminIds = await this.eligibleAdminIds(
          organizationObjectId,
          session,
        );
        if (!eligibleAdminIds.some((id) => id.equals(actorObjectId))) {
          throw new ForbiddenException({
            code: 'USER_MANAGEMENT_FORBIDDEN',
            message: 'Organization admin access required.',
          });
        }

        const organizations = await this.memberships()
          .distinct('organizationId', {
            userId: userObjectId,
            status: 'ACTIVE',
          })
          .session(session)
          .exec();
        if (
          organizations.length !== 1 ||
          String(organizations[0]) !== organizationId
        ) {
          throw new ConflictException({
            code: 'SHARED_ACCOUNT_STATUS_CHANGE',
            message: 'Status of a shared account cannot be changed here.',
          });
        }

        const existing = await this.users()
          .findById(userObjectId, { status: 1 })
          .session(session)
          .lean()
          .exec();
        if (!existing) return;
        if (existing.status === 'ACTIVE' && changes.status !== 'ACTIVE') {
          if (
            eligibleAdminIds.some((id) => id.equals(userObjectId)) &&
            eligibleAdminIds.length <= 1
          ) {
            throw new ConflictException({
              code: 'LAST_ELIGIBLE_ADMIN',
              message:
                'The last active organization admin cannot be suspended.',
            });
          }
        }
        await this.users()
          .updateOne(
            { _id: userObjectId },
            { $set: changes, $inc: { mutationFence: 1 } },
            { session },
          )
          .exec();
        if (typeof this.connection?.useDb === 'function') {
          await this.connection
            .useDb(AUDIT_DATABASE_NAME, { useCache: true })
            .collection(IAM_AUDIT_COLLECTION_NAME)
            .insertOne(
              {
                eventId: randomUUID(),
                schemaVersion: 2,
                operationId: new Types.ObjectId().toHexString(),
                organizationId,
                actorUserId: actorId,
                action: 'ORGANIZATION_USER_STATUS_UPDATED',
                scope: 'ORGANIZATION',
                result: 'SUCCESS',
                occurredAt: new Date(),
                reasonCode: 'ORGANIZATION_USER_STATUS_UPDATED',
                targetResource: 'USER',
                targetResourceId: userId,
                before: { status: existing.status },
                after: { status: changes.status ?? existing.status },
              },
              { session },
            );
        }
      });
    } finally {
      await session.endSession();
    }
  }

  private async eligibleAdminIds(
    organizationId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const assignments = await this.assignments()
      .find(
        {
          organizationId,
          roleCode: 'ADMIN',
          ...organizationLevel,
        },
        { userId: 1, roleId: 1 },
      )
      .session(session ?? null)
      .lean()
      .exec();
    if (assignments.length === 0) return [];
    const roles = await this.roles()
      .find(
        {
          _id: { $in: assignments.map((assignment) => assignment.roleId) },
          code: 'ADMIN',
          permissions: organizationMembershipManagePermission,
        },
        { _id: 1 },
      )
      .session(session ?? null)
      .lean()
      .exec();
    const eligibleRoleIds = new Set(
      roles.map((role) => role._id.toHexString()),
    );
    const assignmentUserIds = [
      ...new Map(
        assignments
          .filter((assignment) =>
            eligibleRoleIds.has(assignment.roleId.toHexString()),
          )
          .map((assignment) => [
            assignment.userId.toHexString(),
            assignment.userId,
          ]),
      ).values(),
    ];
    if (assignmentUserIds.length === 0) return [];
    const activeMembershipUserIds = await this.memberships()
      .distinct('userId', {
        organizationId,
        userId: { $in: assignmentUserIds },
        status: 'ACTIVE',
      })
      .session(session ?? null)
      .exec();
    return this.users()
      .distinct('_id', {
        _id: { $in: activeMembershipUserIds },
        status: 'ACTIVE',
      })
      .session(session ?? null)
      .exec();
  }

  private async withRoles(
    organizationId: Types.ObjectId,
    users: UserDocument[],
  ): Promise<UserRecord[]> {
    if (users.length === 0) return [];
    const assignments = await this.assignments()
      .find(
        {
          organizationId,
          userId: { $in: users.map((user) => user._id) },
          ...organizationLevel,
        },
        { userId: 1, roleCode: 1, _id: 0 },
      )
      .lean()
      .exec();
    const roles = new Map<string, string[]>();
    for (const assignment of assignments) {
      const id = String(assignment.userId);
      roles.set(id, [...(roles.get(id) ?? []), assignment.roleCode]);
    }
    return users.map((user) =>
      this.mapUser(user, roles.get(String(user._id)) ?? []),
    );
  }

  private mapUser(user: UserDocument, roleCodes: string[]): UserRecord {
    return {
      id: String(user._id),
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl ?? null,
      status: user.status,
      roleCodes: [...new Set(roleCodes)].sort(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private users(): Model<UserDocument> {
    const model = this.connection?.models[modelName('users')] as
      Model<UserDocument> | undefined;
    if (!model)
      throw new Error('User directory persistence unavailable: users model');
    return model;
  }

  private assignments(): Model<AssignmentDocument> {
    const model = this.connection?.models[modelName('role_assignments')] as
      Model<AssignmentDocument> | undefined;
    if (!model)
      throw new Error(
        'User directory persistence unavailable: assignments model',
      );
    return model;
  }

  private roles(): Model<RoleDocument> {
    const model = this.connection?.models[modelName('roles')] as
      Model<RoleDocument> | undefined;
    if (!model)
      throw new Error('User directory persistence unavailable: roles model');
    return model;
  }

  private memberships(): Model<MembershipDocument> {
    const model = this.connection?.models[
      modelName('organization_memberships')
    ] as Model<MembershipDocument> | undefined;
    if (!model)
      throw new Error(
        'User directory persistence unavailable: organization memberships model',
      );
    return model;
  }

  private organizations(): Model<{ _id: Types.ObjectId }> {
    const model = this.connection?.models[modelName('organizations')] as
      Model<{ _id: Types.ObjectId }> | undefined;
    if (!model)
      throw new Error(
        'User directory persistence unavailable: organizations model',
      );
    return model;
  }
}
