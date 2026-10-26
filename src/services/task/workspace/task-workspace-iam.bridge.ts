import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { AuthenticationApplicationService } from '../../iam/application/authentication/authentication.application.service';
import { IAM_PERSISTENCE } from '../../iam/infrastructure/persistence';
import type { WorkspaceActorRole } from './task-workspace.types';

export interface WorkspaceProjectContext {
  actorId: string;
  actorName: string;
  organizationId: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  actorRole: WorkspaceActorRole;
}

export interface WorkspaceOrgAdminContext {
  actorId: string;
  actorName: string;
  organizationId: string;
}

export interface WorkspaceProjectMeta {
  id: string;
  name: string;
  code: string;
}

export const TASK_WORKSPACE_IAM_BRIDGE = Symbol('TASK_WORKSPACE_IAM_BRIDGE');

export interface TaskWorkspaceIamBridgePort {
  resolveProjectContext(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
    projectId: string,
    headerOrgId?: string,
    queryOrgId?: string,
  ): Promise<WorkspaceProjectContext>;
  resolveOrgAdminContext(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<WorkspaceOrgAdminContext>;
  isActiveProjectMember(
    organizationId: string,
    projectId: string,
    userId: string,
  ): Promise<boolean>;
  listOrganizationProjects(
    organizationId: string,
  ): Promise<WorkspaceProjectMeta[]>;
  resolveUsersById(
    userIds: string[],
  ): Promise<Map<string, { id: string; fullName: string }>>;
}

const OBJECT_ID_REGEX = /^[a-f\d]{24}$/i;

@Injectable()
export class TaskWorkspaceIamBridge implements TaskWorkspaceIamBridgePort {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  private get db() {
    if (!this.iamConnection?.db) {
      throw new ServiceUnavailableException({
        code: 'RETRY_LATER',
        message: 'Identity persistence is currently unavailable.',
      });
    }
    return this.iamConnection.db;
  }

  async resolveProjectContext(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
    projectId: string,
    headerOrgId?: string,
    queryOrgId?: string,
  ): Promise<WorkspaceProjectContext> {
    const identity = await this.authentication.getCurrentIdentity(
      authorizationHeader,
      cookieHeader,
    );

    if (
      (headerOrgId !== undefined && headerOrgId !== identity.organizationId) ||
      (queryOrgId !== undefined && queryOrgId !== identity.organizationId) ||
      !OBJECT_ID_REGEX.test(projectId)
    ) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    const userObjectId = new Types.ObjectId(identity.id);
    const orgObjectId = new Types.ObjectId(identity.organizationId);
    const projectObjectId = new Types.ObjectId(projectId);

    const [project, orgMembership, projectMembership, assignments] =
      await Promise.all([
        this.db.collection('projects').findOne(
          {
            _id: projectObjectId,
            organizationId: orgObjectId,
            status: 'ACTIVE',
          },
          { projection: { _id: 1, name: 1, code: 1, visibility: 1 } },
        ),
        this.db.collection('organization_memberships').findOne(
          {
            userId: userObjectId,
            organizationId: orgObjectId,
            status: 'ACTIVE',
          },
          { projection: { _id: 1 } },
        ),
        this.db.collection('project_memberships').findOne(
          {
            userId: userObjectId,
            organizationId: orgObjectId,
            projectId: projectObjectId,
            status: 'ACTIVE',
          },
          { projection: { _id: 1 } },
        ),
        this.db
          .collection('role_assignments')
          .find(
            {
              userId: userObjectId,
              organizationId: orgObjectId,
              $or: [
                { projectId: { $exists: false } },
                { projectId: null },
                { projectId: projectObjectId },
              ],
            },
            { projection: { roleCode: 1, projectId: 1 } },
          )
          .toArray(),
      ]);

    if (!project || !orgMembership) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    // Session role labels cannot replace the current scoped assignment read.
    const isOrgAdmin = assignments.some(
      (a) =>
        (a.projectId === null || a.projectId === undefined) &&
        a.roleCode === 'ADMIN',
    );

    // Gate G4: Organization ADMIN can view, create, edit and transition tasks
    // in every active Project of the Organization, including PRIVATE projects
    // where the ADMIN is not a direct project member.
    if (isOrgAdmin) {
      return {
        actorId: identity.id,
        actorName: identity.name,
        organizationId: identity.organizationId,
        projectId,
        projectCode: String(project.code ?? 'TASK').toUpperCase(),
        projectName: String(project.name ?? 'Project'),
        actorRole: 'ADMIN',
      };
    }

    if (!projectMembership) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    const isTeamLeader = assignments.some(
      (a) =>
        a.projectId != null &&
        String(a.projectId) === projectId &&
        a.roleCode === 'TEAM_LEADER',
    );

    return {
      actorId: identity.id,
      actorName: identity.name,
      organizationId: identity.organizationId,
      projectId,
      projectCode: String(project.code ?? 'TASK').toUpperCase(),
      projectName: String(project.name ?? 'Project'),
      actorRole: isTeamLeader ? 'TEAM_LEADER' : 'MEMBER',
    };
  }

  async resolveOrgAdminContext(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<WorkspaceOrgAdminContext> {
    const identity = await this.authentication.getCurrentIdentity(
      authorizationHeader,
      cookieHeader,
    );

    const userObjectId = new Types.ObjectId(identity.id);
    const orgObjectId = new Types.ObjectId(identity.organizationId);

    const [orgMembership, adminAssignment] = await Promise.all([
      this.db.collection('organization_memberships').findOne(
        {
          userId: userObjectId,
          organizationId: orgObjectId,
          status: 'ACTIVE',
        },
        { projection: { _id: 1 } },
      ),
      this.db.collection('role_assignments').findOne(
        {
          userId: userObjectId,
          organizationId: orgObjectId,
          roleCode: 'ADMIN',
          $or: [{ projectId: { $exists: false } }, { projectId: null }],
        },
        { projection: { _id: 1 } },
      ),
    ]);

    const isOrgAdmin = Boolean(orgMembership) && Boolean(adminAssignment);

    if (!isOrgAdmin) {
      // Non-ADMIN receives 404 so the route does not act as an existence oracle.
      throw new NotFoundException({
        code: 'TASK_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    return {
      actorId: identity.id,
      actorName: identity.name,
      organizationId: identity.organizationId,
    };
  }

  async isActiveProjectMember(
    organizationId: string,
    projectId: string,
    userId: string,
  ): Promise<boolean> {
    if (
      !OBJECT_ID_REGEX.test(organizationId) ||
      !OBJECT_ID_REGEX.test(projectId) ||
      !OBJECT_ID_REGEX.test(userId)
    ) {
      return false;
    }
    const orgObjectId = new Types.ObjectId(organizationId);
    const projectObjectId = new Types.ObjectId(projectId);
    const userObjectId = new Types.ObjectId(userId);

    const [orgMembership, projectMembership] = await Promise.all([
      this.db.collection('organization_memberships').findOne(
        {
          userId: userObjectId,
          organizationId: orgObjectId,
          status: 'ACTIVE',
        },
        { projection: { _id: 1 } },
      ),
      this.db.collection('project_memberships').findOne(
        {
          userId: userObjectId,
          organizationId: orgObjectId,
          projectId: projectObjectId,
          status: 'ACTIVE',
        },
        { projection: { _id: 1 } },
      ),
    ]);

    return Boolean(orgMembership && projectMembership);
  }

  async listOrganizationProjects(
    organizationId: string,
  ): Promise<WorkspaceProjectMeta[]> {
    if (!OBJECT_ID_REGEX.test(organizationId)) return [];
    const docs = await this.db
      .collection('projects')
      .find(
        {
          organizationId: new Types.ObjectId(organizationId),
          status: 'ACTIVE',
        },
        { projection: { _id: 1, name: 1, code: 1 } },
      )
      .toArray();

    return docs.map((doc) => ({
      id: String(doc._id),
      name: String(doc.name ?? 'Project'),
      code: String(doc.code ?? 'TASK').toUpperCase(),
    }));
  }

  async resolveUsersById(
    userIds: string[],
  ): Promise<Map<string, { id: string; fullName: string }>> {
    const validIds = [
      ...new Set(userIds.filter((id) => OBJECT_ID_REGEX.test(id))),
    ];
    if (validIds.length === 0) return new Map();

    const docs = await this.db
      .collection('users')
      .find(
        { _id: { $in: validIds.map((id) => new Types.ObjectId(id)) } },
        { projection: { _id: 1, fullName: 1, email: 1 } },
      )
      .toArray();

    const map = new Map<string, { id: string; fullName: string }>();
    for (const doc of docs) {
      const id = String(doc._id);
      const fullName =
        typeof doc.fullName === 'string' && doc.fullName.trim().length > 0
          ? doc.fullName.trim()
          : typeof doc.email === 'string'
            ? doc.email
            : id;
      map.set(id, { id, fullName });
    }
    return map;
  }
}
