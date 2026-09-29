import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  AuthorizationEvidenceProvider,
  ProjectCreateEvidence,
} from '../../application/authorization/authorization-evidence.provider';
import { IAM_PERSISTENCE } from '../persistence';

interface MembershipDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}

interface RoleAssignmentDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId?: Types.ObjectId | null;
  roleId: Types.ObjectId;
  roleCode: string;
}

interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
}

interface GrantDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  capability: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

const modelName = (collection: string): string =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class MongoAuthorizationEvidenceProvider implements AuthorizationEvidenceProvider {
  constructor(
    @Optional() @InjectConnection() private readonly connection?: Connection,
  ) {}

  async loadProjectCreate(
    userId: string,
    organizationId: string,
  ): Promise<ProjectCreateEvidence | null> {
    if (!validId(userId) || !validId(organizationId)) return null;
    const userObjectId = new Types.ObjectId(userId);
    const organizationObjectId = new Types.ObjectId(organizationId);
    const membership = await this.model<MembershipDocument>(
      'organization_memberships',
    )
      .findOne(
        {
          userId: userObjectId,
          organizationId: organizationObjectId,
          status: 'ACTIVE',
        },
        { userId: 1, organizationId: 1, status: 1 },
      )
      .lean()
      .exec();
    if (!membership) {
      return {
        membership: null,
        roleAssignments: [],
        grants: [],
        explicitDeny: 'CLEAR',
      };
    }

    const assignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find(
        {
          userId: userObjectId,
          organizationId: organizationObjectId,
          projectId: null,
        },
        { userId: 1, organizationId: 1, projectId: 1, roleId: 1, roleCode: 1 },
      )
      .lean()
      .exec();
    const roleIds = assignments
      .map((row) => row.roleId)
      .filter((value) => value instanceof Types.ObjectId);
    const roles = roleIds.length
      ? await this.model<RoleDocument>('roles')
          .find({ _id: { $in: roleIds } }, { _id: 1, code: 1 })
          .lean()
          .exec()
      : [];
    const codesByRoleId = new Map(
      roles.map((row) => [String(row._id), row.code]),
    );
    const roleAssignments = assignments
      .filter((row) => codesByRoleId.get(String(row.roleId)) === row.roleCode)
      .map((row) => ({
        userId: String(row.userId),
        organizationId: String(row.organizationId),
        projectId: row.projectId == null ? null : String(row.projectId),
        roleCode: row.roleCode,
      }));

    const grants = await this.model<GrantDocument>(
      'organization_capability_grants',
    )
      .find(
        {
          userId: userObjectId,
          organizationId: organizationObjectId,
          capability: 'project.create',
        },
        {
          userId: 1,
          organizationId: 1,
          capability: 1,
          expiresAt: 1,
          revokedAt: 1,
        },
      )
      .lean()
      .exec();

    return {
      membership: {
        userId: String(membership.userId),
        organizationId: String(membership.organizationId),
        status: membership.status,
      },
      roleAssignments,
      grants: grants.map((row) => ({
        userId: String(row.userId),
        organizationId: String(row.organizationId),
        capability: row.capability,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      })),
      // These current sources can grant project.create but have no DENY field.
      // DEC-002 evaluates explicit DENY only from a source that supports it.
      explicitDeny: 'CLEAR',
    };
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(`Authorization evidence unavailable: ${collection}`);
    return model;
  }
}
