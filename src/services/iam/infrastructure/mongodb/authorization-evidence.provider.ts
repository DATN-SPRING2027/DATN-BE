import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  AuthorizationEvidenceProvider,
  ProjectAccessEvidence,
  ProjectCreateEvidence,
  PlatformPermissionEvidence,
} from '../../application/authorization/authorization-evidence.provider';
import { IAM_PERSISTENCE } from '../persistence';
import type { PlatformPermission } from '../../application/authorization/authorization.policy';

interface MembershipDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
}

interface ProjectDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
}

interface ProjectMembershipDocument {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  status: string;
}

interface RoleAssignmentDocument {
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  projectId?: Types.ObjectId | null;
}

interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}

interface PlatformAuthorityAssignmentDocument {
  subjectUserId: Types.ObjectId;
  grantedAt: Date;
  grantedBy: Types.ObjectId;
  permission: string;
  scope: string;
  status: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

const modelName = (collection: string): string =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class MongoAuthorizationEvidenceProvider implements AuthorizationEvidenceProvider {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
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
        explicitDeny: 'CLEAR',
      };
    }

    return {
      membership: {
        userId: String(membership.userId),
        organizationId: String(membership.organizationId),
        status: membership.status,
      },
      // Membership has no DENY field; no current project.create source
      // supports explicit deny.
      explicitDeny: 'CLEAR',
    };
  }

  async loadProjectAccess(
    userId: string,
    organizationId: string,
    projectId: string,
  ): Promise<ProjectAccessEvidence | null> {
    if (!validId(userId) || !validId(organizationId) || !validId(projectId))
      return null;
    const user = new Types.ObjectId(userId);
    const organization = new Types.ObjectId(organizationId);
    const projectObjectId = new Types.ObjectId(projectId);
    const project = await this.model<ProjectDocument>('projects')
      .findOne(
        { _id: projectObjectId, organizationId: organization },
        { _id: 1, organizationId: 1, status: 1, visibility: 1 },
      )
      .lean()
      .exec();
    if (!project) {
      return {
        project: null,
        membership: null,
        projectMembership: null,
        assignments: [],
        explicitDeny: 'CLEAR',
      };
    }

    const [membership, projectMembership, assignments] = await Promise.all([
      this.model<MembershipDocument>('organization_memberships')
        .findOne(
          { userId: user, organizationId: organization },
          { userId: 1, organizationId: 1, status: 1 },
        )
        .lean()
        .exec(),
      this.model<ProjectMembershipDocument>('project_memberships')
        .findOne(
          {
            userId: user,
            organizationId: organization,
            projectId: projectObjectId,
          },
          { userId: 1, organizationId: 1, projectId: 1, status: 1 },
        )
        .lean()
        .exec(),
      this.model<RoleAssignmentDocument>('role_assignments')
        .find(
          {
            organizationId: organization,
            userId: user,
            $or: [
              { projectId: { $exists: false } },
              { projectId: null },
              { projectId: projectObjectId },
            ],
          },
          {
            organizationId: 1,
            userId: 1,
            roleId: 1,
            roleCode: 1,
            projectId: 1,
          },
        )
        .lean()
        .exec(),
    ]);
    const roleIds = assignments
      .map((assignment) => assignment.roleId)
      .filter((roleId) => roleId instanceof Types.ObjectId);
    const roles = roleIds.length
      ? await this.model<RoleDocument>('roles')
          .find({ _id: { $in: roleIds } }, { _id: 1, code: 1, permissions: 1 })
          .lean()
          .exec()
      : [];
    const rolesById = new Map(roles.map((role) => [String(role._id), role]));

    return {
      project: {
        id: String(project._id),
        organizationId: String(project.organizationId),
        status: project.status,
        ...(project.visibility ? { visibility: project.visibility } : {}),
      },
      membership: membership
        ? {
            userId: String(membership.userId),
            organizationId: String(membership.organizationId),
            status: membership.status,
          }
        : null,
      projectMembership: projectMembership
        ? {
            userId: String(projectMembership.userId),
            organizationId: String(projectMembership.organizationId),
            projectId: String(projectMembership.projectId),
            status: projectMembership.status,
          }
        : null,
      assignments: assignments.map((assignment) => {
        const role = rolesById.get(String(assignment.roleId));
        return {
          userId: String(assignment.userId),
          organizationId: String(assignment.organizationId),
          projectId:
            assignment.projectId == null ? null : String(assignment.projectId),
          roleCode: assignment.roleCode,
          resolvedRoleCode: role?.code ?? null,
          permissions: role?.permissions ?? [],
        };
      }),
      explicitDeny: 'CLEAR',
    };
  }

  async loadPlatformPermission(
    userId: string,
    permission: PlatformPermission,
  ): Promise<PlatformPermissionEvidence | null> {
    if (!validId(userId)) return null;
    const assignments = await this.model<PlatformAuthorityAssignmentDocument>(
      'platform_authority_assignments',
    )
      .find(
        {
          subjectUserId: new Types.ObjectId(userId),
          permission,
        },
        {
          subjectUserId: 1,
          grantedAt: 1,
          grantedBy: 1,
          permission: 1,
          scope: 1,
          status: 1,
          expiresAt: 1,
          revokedAt: 1,
        },
      )
      .lean()
      .exec();

    return {
      assignments: assignments.map((assignment) => ({
        subjectUserId: String(assignment.subjectUserId),
        grantedAt: assignment.grantedAt,
        grantedBy: String(assignment.grantedBy),
        permission: assignment.permission,
        scope: assignment.scope,
        status: assignment.status,
        expiresAt: assignment.expiresAt ?? null,
        revokedAt: assignment.revokedAt ?? null,
      })),
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
