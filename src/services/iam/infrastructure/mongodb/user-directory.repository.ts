import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
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
}

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const organizationLevel = {
  $or: [{ projectId: { $exists: false } }, { projectId: null }],
};
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
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async isAdmin(organizationId: string, actorId: string): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(actorId)
    )
      return false;
    const assignment = await this.assignments().exists({
      organizationId: new Types.ObjectId(organizationId),
      userId: new Types.ObjectId(actorId),
      roleCode: 'ADMIN',
      ...organizationLevel,
    });
    if (!assignment) return false;
    const active = await this.users().exists({
      _id: new Types.ObjectId(actorId),
      status: 'ACTIVE',
    });
    return Boolean(active);
  }

  async list(organizationId: string, query: UserListQuery) {
    const organizationObjectId = new Types.ObjectId(organizationId);
    const assignments = await this.assignments()
      .find(
        {
          organizationId: organizationObjectId,
          ...organizationLevel,
          ...(query.roleCode ? { roleCode: query.roleCode } : {}),
        },
        { userId: 1, _id: 0 },
      )
      .lean()
      .exec();
    const ids = [...new Set(assignments.map((row) => String(row.userId)))].map(
      (id) => new Types.ObjectId(id),
    );
    const filter = {
      _id: { $in: ids },
      ...(query.status ? { status: query.status } : {}),
    };
    const [totalItems, rows] = await Promise.all([
      this.users().countDocuments(filter).exec(),
      this.users()
        .find(filter, publicUserFields)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean()
        .exec(),
    ]);
    return {
      data: await this.withRoles(organizationObjectId, rows),
      totalItems,
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
    if (assignments.length === 0) return null;
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
  ): Promise<UserRecord | null> {
    if (!(await this.find(organizationId, userId))) return null;
    if (changes.status !== undefined) {
      await this.updateStatusAtomically(organizationId, userId, changes);
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
    changes: UserUpdate,
  ): Promise<void> {
    if (!this.connection)
      throw new Error('User directory persistence unavailable');
    const session = await this.connection.startSession();
    const userObjectId = new Types.ObjectId(userId);
    const organizationObjectId = new Types.ObjectId(organizationId);
    try {
      await session.withTransaction(async () => {
        const organizations = await this.assignments()
          .distinct('organizationId', {
            userId: userObjectId,
            ...organizationLevel,
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

        // Every status update writes the same organization document before
        // counting admins. Concurrent transactions then conflict and retry.
        const guard = await this.organizations()
          .updateOne(
            { _id: organizationObjectId },
            { $currentDate: { updatedAt: true } },
            { session },
          )
          .exec();
        if (guard.matchedCount !== 1) {
          throw new ConflictException({
            code: 'ORGANIZATION_NOT_FOUND',
            message: 'Organization is unavailable.',
          });
        }

        const existing = await this.users()
          .findById(userObjectId, { status: 1 })
          .session(session)
          .lean()
          .exec();
        if (!existing) return;
        if (existing.status === 'ACTIVE' && changes.status !== 'ACTIVE') {
          const assignment = await this.assignments()
            .exists({
              organizationId: organizationObjectId,
              userId: userObjectId,
              roleCode: 'ADMIN',
              ...organizationLevel,
            })
            .session(session);
          if (assignment) {
            const ids = await this.assignments()
              .distinct('userId', {
                organizationId: organizationObjectId,
                roleCode: 'ADMIN',
                ...organizationLevel,
              })
              .session(session)
              .exec();
            const count = await this.users()
              .countDocuments({ _id: { $in: ids }, status: 'ACTIVE' })
              .session(session)
              .exec();
            if (count <= 1) {
              throw new ConflictException({
                code: 'LAST_ACTIVE_ADMIN',
                message:
                  'The last active organization admin cannot be suspended.',
              });
            }
          }
        }
        await this.users()
          .updateOne({ _id: userObjectId }, { $set: changes }, { session })
          .exec();
      });
    } finally {
      await session.endSession();
    }
  }

  async countActiveAdmins(organizationId: string): Promise<number> {
    const ids = await this.assignments()
      .distinct('userId', {
        organizationId: new Types.ObjectId(organizationId),
        roleCode: 'ADMIN',
        ...organizationLevel,
      })
      .exec();
    return this.users()
      .countDocuments({ _id: { $in: ids }, status: 'ACTIVE' })
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
