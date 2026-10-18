import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, PipelineStage } from 'mongoose';
import type {
  UserDirectoryRepository as UserDirectoryRepositoryPort,
  UserListQuery,
  UserRecord,
  UserStatus,
  UserUpdate,
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

  async update(
    organizationId: string,
    userId: string,
    changes: UserUpdate,
    actorId: string,
  ): Promise<UserRecord | null> {
    if (!(await this.find(organizationId, userId))) return null;
    if (changes.status !== undefined) {
      await this.updateStatusAtomically(
        organizationId,
        userId,
        actorId,
        changes,
      );
      return this.find(organizationId, userId);
    }
    await this.users()
      .updateOne({ _id: new Types.ObjectId(userId) }, { $set: changes })
      .exec();
    return this.find(organizationId, userId);
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
