import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type {
  ProjectListQuery,
  ProjectCreateInput,
  ProjectRecord,
  ProjectRepository,
  ProjectStatus,
} from '../../application/projects/project.repository';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../persistence';

interface ProjectDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  code: string;
  description?: string | null;
  visibility?: 'PRIVATE' | 'PUBLIC';
  status: ProjectStatus;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: Date;
}
interface RoleAssignmentDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  projectId?: Types.ObjectId | null;
  assignedBy: Types.ObjectId;
}
interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}

const name = (collection: string) =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class MongoProjectRepository implements ProjectRepository {
  constructor(
    private readonly policy: AuthorizationPolicy,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async create(
    organizationId: string,
    creatorId: string,
    input: ProjectCreateInput,
  ): Promise<ProjectRecord> {
    if (!validId(organizationId) || !validId(creatorId))
      throw new Error('Trusted Project context is invalid');
    if (!this.connection) throw new Error('Project persistence unavailable');
    const session = await this.connection.startSession();
    try {
      let created: ProjectRecord | undefined;
      await session.withTransaction(async () => {
        const memberRole = await this.model<RoleDocument>('roles')
          .findOne({ code: 'MEMBER' })
          .session(session)
          .lean()
          .exec();
        if (
          !memberRole ||
          memberRole.code !== 'MEMBER' ||
          !Array.isArray(memberRole.permissions) ||
          !memberRole.permissions.includes('project.read')
        )
          throw new Error(
            'Project bootstrap requires a MEMBER Role with project.read',
          );

        const [project] = await this.model<ProjectDocument>('projects')
          .create(
            [
              {
                organizationId: new Types.ObjectId(organizationId),
                name: input.name,
                code: input.code,
                ...(input.description === undefined
                  ? {}
                  : { description: input.description }),
                visibility: 'PRIVATE',
                status: 'ACTIVE',
                createdBy: new Types.ObjectId(creatorId),
              },
            ],
            { session },
          )
          .catch((cause: unknown) => {
            if (
              typeof cause === 'object' &&
              cause !== null &&
              'code' in cause &&
              cause.code === 11000
            )
              throw new ConflictException({
                code: 'PROJECT_CODE_CONFLICT',
                message: 'Project code already exists in this organization.',
              });
            throw cause;
          });
        created = this.record(project.toObject());
        const [projectMembership] = await this.model<MembershipDocument>(
          'project_memberships',
        ).create(
          [
            {
              organizationId: new Types.ObjectId(organizationId),
              projectId: new Types.ObjectId(created.id),
              userId: new Types.ObjectId(creatorId),
              status: 'ACTIVE',
              joinedAt: new Date(),
            },
          ],
          { session },
        );
        const [roleAssignment] = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        ).create(
          [
            {
              organizationId: new Types.ObjectId(organizationId),
              projectId: new Types.ObjectId(created.id),
              userId: new Types.ObjectId(creatorId),
              roleId: memberRole._id,
              roleCode: 'MEMBER',
              assignedBy: new Types.ObjectId(creatorId),
            },
          ],
          { session },
        );
        await this.connection!.useDb(this.auditDatabaseName, { useCache: true })
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .insertOne(
            {
              organizationId,
              projectId: created.id,
              actorUserId: creatorId,
              action: 'project.create',
              targetResource: 'PROJECT',
              targetResourceId: created.id,
              metadata: {
                bootstrap: {
                  projectMembershipId: String(projectMembership._id),
                  roleAssignmentId: String(roleAssignment._id),
                  roleCode: 'MEMBER',
                },
              },
              occurredAt: new Date(),
            },
            { session },
          );
      });
      if (!created)
        throw new Error('Project transaction did not create a record');
      return created;
    } finally {
      await session.endSession();
    }
  }

  async listVisible(
    organizationId: string,
    userId: string,
    query: ProjectListQuery,
  ) {
    const scope = await this.visibleScope(organizationId, userId);
    if (!scope) return { data: [], totalItems: 0 };
    if (
      !scope.all &&
      !scope.includePublicProjects &&
      scope.projectIds.length === 0
    )
      return { data: [], totalItems: 0 };
    const filter = {
      organizationId: new Types.ObjectId(organizationId),
      ...(scope.all
        ? {}
        : {
            $or: [
              ...(scope.includePublicProjects
                ? [{ visibility: 'PUBLIC' }]
                : []),
              ...(scope.projectIds.length > 0
                ? [{ _id: { $in: scope.projectIds } }]
                : []),
            ],
          }),
      ...(query.status ? { status: query.status } : {}),
    };
    const projects = this.model<ProjectDocument>('projects');
    const [rows, totalItems] = await Promise.all([
      projects
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean()
        .exec(),
      projects.countDocuments(filter).exec(),
    ]);
    return { data: rows.map((row) => this.record(row)), totalItems };
  }

  async findVisible(organizationId: string, userId: string, projectId: string) {
    if (!validId(projectId)) return null;
    const scope = await this.visibleScope(organizationId, userId);
    if (!scope) return null;
    const hasPrivateProjectAccess =
      scope.all ||
      scope.projectIds.some((id) => String(id) === projectId.toLowerCase());
    if (!hasPrivateProjectAccess && !scope.includePublicProjects) return null;
    const project = await this.model<ProjectDocument>('projects')
      .findOne({
        _id: new Types.ObjectId(projectId),
        organizationId: new Types.ObjectId(organizationId),
        ...(!hasPrivateProjectAccess ? { visibility: 'PUBLIC' } : {}),
      })
      .lean()
      .exec();
    return project ? this.record(project) : null;
  }

  private async visibleScope(
    organizationId: string,
    userId: string,
  ): Promise<
    | { all: true; projectIds: Types.ObjectId[] }
    | {
        all: false;
        projectIds: Types.ObjectId[];
        includePublicProjects: boolean;
      }
    | null
  > {
    if (!validId(organizationId) || !validId(userId)) return null;
    const organization = new Types.ObjectId(organizationId);
    const user = new Types.ObjectId(userId);
    const membership = await this.model('organization_memberships').exists({
      organizationId: organization,
      userId: user,
      status: 'ACTIVE',
    });
    if (!membership) return null;

    const assignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find(
        { organizationId: organization, userId: user },
        { roleId: 1, roleCode: 1, projectId: 1 },
      )
      .lean()
      .exec();
    const roleIds = assignments
      .map((row) => row.roleId)
      .filter((value) => value instanceof Types.ObjectId);
    const roles = roleIds.length
      ? await this.model<RoleDocument>('roles')
          .find({ _id: { $in: roleIds } }, { _id: 1, code: 1, permissions: 1 })
          .lean()
          .exec()
      : [];
    const rolesById = new Map(roles.map((role) => [String(role._id), role]));
    const active = await this.model<MembershipDocument>('project_memberships')
      .find(
        { organizationId: organization, userId: user, status: 'ACTIVE' },
        { projectId: 1 },
      )
      .lean()
      .exec();
    const scope = this.policy.projectReadScope({
      subject: { userId, organizationId, status: 'ACTIVE' },
      requestedOrganizationId: organizationId,
      membership: { userId, organizationId, status: 'ACTIVE' },
      assignments: assignments.map((assignment) => {
        const role = rolesById.get(String(assignment.roleId));
        return {
          projectId:
            assignment.projectId == null ? null : String(assignment.projectId),
          roleCode: assignment.roleCode,
          resolvedRoleCode: role?.code ?? null,
          permissions: role?.permissions ?? [],
        };
      }),
      activeProjectMembershipIds: active.map((row) => String(row.projectId)),
      explicitDeny: 'CLEAR',
    });
    return scope.all
      ? { all: true, projectIds: [] }
      : {
          all: false,
          projectIds: scope.projectIds.map((id) => new Types.ObjectId(id)),
          includePublicProjects: scope.includePublicProjects,
        };
  }

  private record(row: ProjectDocument): ProjectRecord {
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      name: row.name,
      code: row.code,
      ...(row.description === undefined
        ? {}
        : { description: row.description }),
      visibility: row.visibility ?? 'PRIVATE',
      status: row.status,
      createdBy: String(row.createdBy),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[name(collection)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(`Project persistence unavailable: ${collection}`);
    return model;
  }
}
