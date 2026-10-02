import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  AuthenticationAccount,
  AuthenticationProfile,
  AuthenticationRepositoryPort,
  LoginOrganizationOption,
  OrganizationRoleAssignment,
} from '../../application/authentication/authentication.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  fullName: string;
  status: string;
  twoFactorEnabled?: boolean;
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
  tokenHash: string;
  isRevoked: boolean;
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
          status: 1,
          twoFactorEnabled: 1,
        },
      )
      .lean()
      .exec();

    if (!user) return null;

    return {
      userId: String(user._id),
      email: user.email,
      name: user.fullName,
      passwordHash:
        typeof user.passwordHash === 'string' ? user.passwordHash : '',
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
      .findById(new Types.ObjectId(userId), { fullName: 1, status: 1 })
      .lean()
      .exec();
    return user ? { name: user.fullName, status: user.status } : null;
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

  async revokeRefreshSessionByHash(tokenHash: string): Promise<boolean> {
    const model = this.getModel<RefreshSessionDocument>(
      REFRESH_SESSIONS_MODEL,
      'REFRESH_SESSION_MODEL_UNAVAILABLE',
    );
    const result = await model
      .updateOne(
        { tokenHash, isRevoked: { $ne: true } },
        { $set: { isRevoked: true } },
      )
      .exec();
    return result.modifiedCount > 0;
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
