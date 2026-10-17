import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  AuthenticationAccount,
  AuthenticationProfile,
  AuthenticationRepositoryPort,
  LoginOrganizationOption,
  NewGoogleAccount,
  NewRefreshSession,
  OrganizationRoleAssignment,
  RefreshSessionContext,
  RefreshAccount,
  RefreshRotationResult,
  RefreshSessionLookup,
} from '../../application/authentication/authentication.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  passwordHash?: string;
  googleSubject?: string;
  fullName: string;
  status: string;
  twoFactorEnabled?: boolean;
  mutationFence?: number;
}

interface RoleAssignmentDocument {
  organizationId: Types.ObjectId;
  roleCode: string;
}

interface OrganizationMembershipDocument {
  organizationId: Types.ObjectId;
}

interface OrganizationDocument {
  _id: Types.ObjectId;
  name: string;
}

interface RefreshSessionDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId?: string;
  userFence?: number;
  organizationId?: Types.ObjectId | null;
  context?: string;
  tokenHash: string;
  isRevoked: boolean;
  expiresAt: Date;
}

function refreshSessionContext(
  row: RefreshSessionDocument,
): { context: RefreshSessionContext; organizationId?: Types.ObjectId } | null {
  const context = row.context === undefined ? 'ORGANIZATION' : row.context;
  if (
    context === 'ORGANIZATION' &&
    row.organizationId instanceof Types.ObjectId
  )
    return { context, organizationId: row.organizationId };
  if (
    (context === 'PLATFORM' || context === 'ACCOUNT') &&
    row.organizationId == null
  )
    return { context };
  return null;
}

export class AuthenticationRepositoryUnavailableError extends Error {
  constructor(
    reason:
      | 'CONNECTION_UNAVAILABLE'
      | 'USER_MODEL_UNAVAILABLE'
      | 'ROLE_ASSIGNMENT_MODEL_UNAVAILABLE'
      | 'ORGANIZATION_MEMBERSHIP_MODEL_UNAVAILABLE'
      | 'ORGANIZATION_MODEL_UNAVAILABLE'
      | 'REFRESH_SESSION_MODEL_UNAVAILABLE',
  ) {
    super(`Authentication persistence unavailable: ${reason}`);
    this.name = AuthenticationRepositoryUnavailableError.name;
  }
}

const modelName = (collectionName: string) => {
  const collection = IAM_PERSISTENCE.collections.find(
    (entry) => entry.name === collectionName,
  );
  if (!collection) {
    throw new Error(
      `IAM persistence definition does not include ${collectionName}`,
    );
  }
  return `${IAM_PERSISTENCE.databaseName}_${collection.name}`;
};

const USERS_MODEL = modelName('users');
const ROLE_ASSIGNMENTS_MODEL = modelName('role_assignments');
const ORGANIZATION_MEMBERSHIPS_MODEL = modelName('organization_memberships');
const ORGANIZATIONS_MODEL = modelName('organizations');
const REFRESH_SESSIONS_MODEL = modelName('refresh_sessions');

@Injectable()
export class AuthenticationRepository implements AuthenticationRepositoryPort {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async findAccountByEmail(
    email: string,
  ): Promise<AuthenticationAccount | null> {
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const user = await model
      .findOne(
        { email: email.trim().toLowerCase() },
        {
          _id: 1,
          email: 1,
          fullName: 1,
          passwordHash: 1,
          googleSubject: 1,
          status: 1,
          twoFactorEnabled: 1,
        },
      )
      .lean()
      .exec();

    if (!user) return null;

    return this.toAuthenticationAccount(user);
  }

  async findAccountByGoogleSubject(
    googleSubject: string,
  ): Promise<AuthenticationAccount | null> {
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const user = await model
      .findOne(
        { googleSubject },
        {
          _id: 1,
          email: 1,
          fullName: 1,
          passwordHash: 1,
          googleSubject: 1,
          status: 1,
          twoFactorEnabled: 1,
        },
      )
      .lean()
      .exec();
    return user ? this.toAuthenticationAccount(user) : null;
  }

  async linkGoogleSubjectIfMissing(
    userId: string,
    googleSubject: string,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const result = await model
      .updateOne(
        {
          _id: new Types.ObjectId(userId),
          $or: [{ googleSubject: { $exists: false } }, { googleSubject: null }],
        },
        { $set: { googleSubject } },
      )
      .exec();
    return result.modifiedCount === 1;
  }

  async createGoogleAccount(
    input: NewGoogleAccount,
  ): Promise<AuthenticationAccount> {
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const user = await model.create({
      email: input.email.trim().toLowerCase(),
      fullName: input.name.trim(),
      googleSubject: input.googleSubject,
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
    return this.toAuthenticationAccount(user.toObject());
  }

  async findAccountById(userId: string): Promise<RefreshAccount | null> {
    if (!Types.ObjectId.isValid(userId)) return null;
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const user = await model
      .findById(new Types.ObjectId(userId), {
        email: 1,
        status: 1,
        twoFactorEnabled: 1,
      })
      .lean()
      .exec();
    if (!user) return null;
    return {
      email: user.email,
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled === true,
    };
  }

  async findOrganizationRoleAssignments(
    userId: string,
  ): Promise<OrganizationRoleAssignment[]> {
    if (!Types.ObjectId.isValid(userId)) return [];

    const model = this.getModel<RoleAssignmentDocument>(
      ROLE_ASSIGNMENTS_MODEL,
      'ROLE_ASSIGNMENT_MODEL_UNAVAILABLE',
    );
    const rows = await model
      .find(
        {
          userId: new Types.ObjectId(userId),
          $or: [{ projectId: { $exists: false } }, { projectId: null }],
        },
        { organizationId: 1, roleCode: 1, _id: 0 },
      )
      .sort({ organizationId: 1, roleCode: 1 })
      .lean()
      .exec();

    return rows.map((row) => ({
      organizationId: String(row.organizationId),
      roleCode: row.roleCode,
    }));
  }

  async findActiveOrganizationMembershipIds(userId: string): Promise<string[]> {
    if (!Types.ObjectId.isValid(userId)) return [];
    const model = this.getModel<OrganizationMembershipDocument>(
      ORGANIZATION_MEMBERSHIPS_MODEL,
      'ORGANIZATION_MEMBERSHIP_MODEL_UNAVAILABLE',
    );
    const rows = await model
      .find(
        { userId: new Types.ObjectId(userId), status: 'ACTIVE' },
        { organizationId: 1, _id: 0 },
      )
      .sort({ organizationId: 1 })
      .lean()
      .exec();
    return [...new Set(rows.map((row) => String(row.organizationId)))];
  }

  async findOrganizationOptions(
    ids: string[],
  ): Promise<LoginOrganizationOption[]> {
    const validIds = ids.filter((id) => Types.ObjectId.isValid(id));
    if (validIds.length === 0) return [];
    const model = this.getModel<OrganizationDocument>(
      ORGANIZATIONS_MODEL,
      'ORGANIZATION_MODEL_UNAVAILABLE',
    );
    const rows = await model
      .find(
        { _id: { $in: validIds.map((id) => new Types.ObjectId(id)) } },
        { _id: 1, name: 1 },
      )
      .lean()
      .exec();
    const names = new Map(rows.map((row) => [String(row._id), row.name]));
    return validIds.flatMap((id) => {
      const name = names.get(id);
      return name ? [{ id, name }] : [];
    });
  }

  async findProfileById(userId: string): Promise<AuthenticationProfile | null> {
    if (!Types.ObjectId.isValid(userId)) return null;

    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const user = await model
      .findById(new Types.ObjectId(userId), {
        fullName: 1,
        status: 1,
        mutationFence: 1,
      })
      .lean()
      .exec();
    if (!user) return null;
    const mutationFence = user.mutationFence ?? 0;
    if (!Number.isSafeInteger(mutationFence) || mutationFence < 0) {
      throw new AuthenticationRepositoryUnavailableError(
        'USER_MODEL_UNAVAILABLE',
      );
    }
    return { name: user.fullName, status: user.status, mutationFence };
  }

  async replacePasswordHashIfCurrent(
    userId: string,
    currentHash: string,
    replacementHash: string,
  ): Promise<void> {
    if (!Types.ObjectId.isValid(userId)) return;
    const model = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    await model
      .updateOne(
        { _id: new Types.ObjectId(userId), passwordHash: currentHash },
        { $set: { passwordHash: replacementHash } },
      )
      .exec();
  }

  async resetPassword(
    userId: string,
    replacementHash: string,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    if (!this.connection) {
      throw new AuthenticationRepositoryUnavailableError(
        'CONNECTION_UNAVAILABLE',
      );
    }

    const users = this.getModel<UserDocument>(
      USERS_MODEL,
      'USER_MODEL_UNAVAILABLE',
    );
    const sessions = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    const accountId = new Types.ObjectId(userId);
    const session = await this.connection.startSession();
    try {
      const changed = await session.withTransaction(async () => {
        const updated = await users
          .updateOne(
            { _id: accountId, status: 'ACTIVE' },
            {
              $set: { passwordHash: replacementHash },
              $inc: { mutationFence: 1 },
            },
            { session },
          )
          .exec();
        if (updated.matchedCount !== 1) return false;

        await sessions
          .updateMany(
            { userId: accountId, isRevoked: { $ne: true } },
            { $set: { isRevoked: true } },
            { session },
          )
          .exec();
        return true;
      });
      return changed === true;
    } finally {
      await session.endSession();
    }
  }

  async revokeRefreshSessionByHash(tokenHash: string): Promise<boolean> {
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    if (!this.connection) {
      throw new AuthenticationRepositoryUnavailableError(
        'CONNECTION_UNAVAILABLE',
      );
    }
    const session = await this.connection.startSession();
    try {
      const revoked = await session.withTransaction(async () => {
        const row = await model
          .findOne({ tokenHash })
          .session(session)
          .lean()
          .exec();
        if (
          !row ||
          row.isRevoked === true ||
          !(row.userId instanceof Types.ObjectId)
        )
          return false;
        const sessionId =
          typeof row.sessionId === 'string'
            ? row.sessionId
            : row._id.toHexString();
        const familyMatch: Record<string, unknown> = {
          userId: row.userId,
          $or: [{ sessionId }],
        };
        if (!row.sessionId)
          (familyMatch.$or as Record<string, unknown>[]).push({
            _id: row._id,
            sessionId: { $exists: false },
          });
        const result = await model
          .updateMany(
            { ...familyMatch, isRevoked: { $ne: true } },
            { $set: { isRevoked: true, updatedAt: new Date() } },
            { session, timestamps: false },
          )
          .exec();
        return result.modifiedCount > 0;
      });
      return revoked === true;
    } finally {
      await session.endSession();
    }
  }

  async findRefreshSessionForRotation(
    tokenHash: string,
  ): Promise<RefreshSessionLookup> {
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    const row = await model
      .findOne({ tokenHash })
      .select({
        _id: 1,
        userId: 1,
        sessionId: 1,
        userFence: 1,
        organizationId: 1,
        context: 1,
        isRevoked: 1,
        expiresAt: 1,
      })
      .lean()
      .exec();
    const sessionContext = row ? refreshSessionContext(row) : null;
    const userFence = row?.userFence ?? 0;
    if (
      !row ||
      !(row.userId instanceof Types.ObjectId) ||
      !sessionContext ||
      typeof row.isRevoked !== 'boolean' ||
      !(row.expiresAt instanceof Date) ||
      !Number.isFinite(row.expiresAt.getTime()) ||
      !Number.isSafeInteger(userFence) ||
      userFence < 0
    ) {
      return { outcome: 'INVALID' };
    }
    return sessionContext.context === 'ORGANIZATION'
      ? {
          outcome: row.isRevoked ? 'REVOKED' : 'ACTIVE',
          userId: String(row.userId),
          sessionId:
            typeof row.sessionId === 'string'
              ? row.sessionId
              : row._id.toHexString(),
          userFence,
          context: sessionContext.context,
          organizationId: String(sessionContext.organizationId),
          expiresAt: row.expiresAt,
        }
      : {
          outcome: row.isRevoked ? 'REVOKED' : 'ACTIVE',
          userId: String(row.userId),
          sessionId:
            typeof row.sessionId === 'string'
              ? row.sessionId
              : row._id.toHexString(),
          userFence,
          context: sessionContext.context,
          expiresAt: row.expiresAt,
        };
  }

  async rotateRefreshSession(
    currentHash: string,
    replacementHash: string,
    expiresAt: Date,
    now: Date,
    requestedSessionId?: string,
  ): Promise<RefreshRotationResult> {
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    if (!this.connection) {
      throw new AuthenticationRepositoryUnavailableError(
        'CONNECTION_UNAVAILABLE',
      );
    }
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const effectiveNow = new Date(Math.max(now.getTime(), Date.now()));
        const row = await model
          .findOne({ tokenHash: currentHash })
          .session(session)
          .lean()
          .exec();
        const sessionContext = row ? refreshSessionContext(row) : null;
        if (
          !row ||
          !(row.userId instanceof Types.ObjectId) ||
          !sessionContext ||
          typeof row.isRevoked !== 'boolean' ||
          !(row.expiresAt instanceof Date) ||
          !Number.isFinite(row.expiresAt.getTime())
        ) {
          return { outcome: 'INVALID' } as const;
        }
        if (row.isRevoked) {
          await model
            .updateMany(
              { userId: row.userId, isRevoked: false },
              { $set: { isRevoked: true } },
              { session },
            )
            .exec();
          const users = this.getModel<UserDocument>(
            USERS_MODEL,
            'USER_MODEL_UNAVAILABLE',
          );
          await users
            .updateOne(
              { _id: row.userId },
              { $inc: { mutationFence: 1 } },
              { session },
            )
            .exec();
          return { outcome: 'REPLAYED' } as const;
        }
        if (row.expiresAt.getTime() <= effectiveNow.getTime()) {
          return { outcome: 'INVALID' } as const;
        }
        const sessionId =
          requestedSessionId ??
          (typeof row.sessionId === 'string'
            ? row.sessionId
            : row._id.toHexString());
        const consumed = await model
          .updateOne(
            {
              _id: row._id,
              tokenHash: currentHash,
              isRevoked: false,
              expiresAt: { $gt: effectiveNow },
            },
            { $set: { isRevoked: true } },
            { session },
          )
          .exec();
        if (consumed.modifiedCount !== 1) {
          return { outcome: 'INVALID' } as const;
        }
        await model.create(
          [
            {
              userId: row.userId,
              sessionId,
              userFence: row.userFence ?? 0,
              ...(sessionContext.context === 'ORGANIZATION'
                ? { organizationId: sessionContext.organizationId }
                : {}),
              context: sessionContext.context,
              tokenHash: replacementHash,
              isRevoked: false,
              expiresAt,
            },
          ],
          { session },
        );
        return sessionContext.context === 'ORGANIZATION'
          ? {
              outcome: 'ROTATED' as const,
              userId: String(row.userId),
              context: sessionContext.context,
              organizationId: String(sessionContext.organizationId),
            }
          : {
              outcome: 'ROTATED' as const,
              userId: String(row.userId),
              context: sessionContext.context,
            };
      });
      if (!result) throw new Error('Refresh transaction returned no result');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async createRefreshSession(session: NewRefreshSession): Promise<void> {
    if (!Types.ObjectId.isValid(session.userId)) {
      throw new Error('Invalid refresh session owner');
    }
    if (
      session.context === 'ORGANIZATION' &&
      !Types.ObjectId.isValid(session.organizationId)
    ) {
      throw new Error('Invalid Organization refresh session context');
    }
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    await model.create({
      userId: new Types.ObjectId(session.userId),
      ...(session.context === 'ORGANIZATION'
        ? { organizationId: new Types.ObjectId(session.organizationId) }
        : {}),
      sessionId: session.sessionId,
      userFence: session.userFence,
      context: session.context,
      tokenHash: session.tokenHash,
      isRevoked: false,
      expiresAt: session.expiresAt,
    });
  }

  async hasActiveRefreshSession(
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(userId)) return false;
    const alternatives: Record<string, unknown>[] = [{ sessionId }];
    if (/^[a-f\d]{24}$/i.test(sessionId)) {
      alternatives.push({
        _id: new Types.ObjectId(sessionId),
        sessionId: { $exists: false },
      });
    }
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    return Boolean(
      await model
        .exists({
          userId: new Types.ObjectId(userId),
          isRevoked: false,
          expiresAt: { $gt: now },
          $or: alternatives,
        })
        .exec(),
    );
  }

  private toAuthenticationAccount(user: UserDocument): AuthenticationAccount {
    return {
      userId: String(user._id),
      email: user.email,
      name: user.fullName,
      passwordHash:
        typeof user.passwordHash === 'string' ? user.passwordHash : '',
      ...(typeof user.googleSubject === 'string'
        ? { googleSubject: user.googleSubject }
        : {}),
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled === true,
    };
  }

  private getModel<T>(
    name: string,
    missingReason: ConstructorParameters<
      typeof AuthenticationRepositoryUnavailableError
    >[0],
  ): Model<T> {
    if (!this.connection) {
      throw new AuthenticationRepositoryUnavailableError(
        'CONNECTION_UNAVAILABLE',
      );
    }
    const model = this.connection.models[name] as Model<T> | undefined;
    if (!model) {
      throw new AuthenticationRepositoryUnavailableError(missingReason);
    }
    return model;
  }
}
