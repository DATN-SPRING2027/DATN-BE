import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../../infrastructure/persistence';
import {
  AuthenticationApplicationService,
  readCookie,
  validCsrfPair,
  type AuthenticatedIdentity,
} from '../authentication/authentication.application.service';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface HandoverProjectActorContext {
  userId: string;
  userName: string;
  organizationId: string;
  projectId: string;
  projectVisibility: 'PRIVATE' | 'PUBLIC';
  isProjectMember: boolean;
  isProjectLeader: boolean;
  canAdministerCoordinator: boolean;
}

@Injectable()
export class HandoverIamScopeService {
  constructor(
    private readonly authService: AuthenticationApplicationService,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  private db() {
    if (!this.connection?.db) {
      throw new ServiceUnavailableException({
        code: 'IAM_DATABASE_UNAVAILABLE',
        message: 'IAM persistence is unavailable.',
      });
    }
    return this.connection.db;
  }

  async authenticateActor(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedIdentity> {
    return this.authService.getCurrentIdentity(authorization, cookieHeader);
  }

  assertValidCsrf(
    cookieHeader: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    const trimmed = typeof csrfHeader === 'string' ? csrfHeader.trim() : '';
    const cookieToken =
      readCookie(cookieHeader, '__Host-csrf') ??
      readCookie(cookieHeader, 'continuum_csrf') ??
      readCookie(cookieHeader, 'csrf_token');
    if (!validCsrfPair(cookieToken, trimmed)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing or invalid CSRF token.',
      });
    }
  }

  async resolveProjectActorContext(input: {
    actor: AuthenticatedIdentity;
    projectId: string;
    organizationHeader?: string;
  }): Promise<HandoverProjectActorContext> {
    if (!OBJECT_ID_RE.test(input.projectId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid projectId format.',
      });
    }
    const normalizedProjectId = input.projectId.toLowerCase();
    const orgIdStr = input.actor.organizationId.toLowerCase();

    if (
      input.organizationHeader !== undefined &&
      input.organizationHeader.trim() !== '' &&
      input.organizationHeader.trim().toLowerCase() !== orgIdStr
    ) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    const db = this.db();
    const orgObjId = new Types.ObjectId(orgIdStr);
    const projectObjId = new Types.ObjectId(normalizedProjectId);
    const actorObjId = new Types.ObjectId(input.actor.id.toLowerCase());

    const project = await db.collection('projects').findOne({
      _id: projectObjId,
      organizationId: orgObjId,
    });
    if (!project || project.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    const [activeMembership, projectLeaderRole, orgAdminRole] =
      await Promise.all([
        db.collection('project_memberships').findOne({
          organizationId: orgObjId,
          projectId: projectObjId,
          userId: actorObjId,
          status: 'ACTIVE',
        }),
        db.collection('role_assignments').findOne({
          organizationId: orgObjId,
          projectId: projectObjId,
          userId: actorObjId,
          roleCode: 'TEAM_LEADER',
        }),
        db.collection('role_assignments').findOne({
          organizationId: orgObjId,
          projectId: { $in: [null, undefined] },
          userId: actorObjId,
          roleCode: 'ADMIN',
        }),
      ]);

    const isProjectMember = Boolean(activeMembership);
    const isProjectLeader = isProjectMember && Boolean(projectLeaderRole);
    const isOrgAdmin =
      Boolean(orgAdminRole) ||
      (Array.isArray(input.actor.roles) && input.actor.roles.includes('ADMIN'));
    const canAdministerCoordinator = isProjectLeader || isOrgAdmin;
    const visibility =
      project.visibility === 'PUBLIC' ? 'PUBLIC' : ('PRIVATE' as const);

    if (
      !isProjectMember &&
      !canAdministerCoordinator &&
      visibility === 'PRIVATE'
    ) {
      throw new NotFoundException({
        code: 'PROJECT_NOT_FOUND',
        message: 'Project not found.',
      });
    }

    return {
      userId: input.actor.id.toLowerCase(),
      userName: input.actor.name,
      organizationId: orgIdStr,
      projectId: normalizedProjectId,
      projectVisibility: visibility,
      isProjectMember,
      isProjectLeader,
      canAdministerCoordinator,
    };
  }

  async assertHistoricalDepartingMember(
    organizationId: string,
    projectId: string,
    departingUserId: string,
  ): Promise<void> {
    if (!OBJECT_ID_RE.test(departingUserId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid departingUserId.',
      });
    }
    const db = this.db();
    const orgObjId = new Types.ObjectId(organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(projectId.toLowerCase());
    const userObjId = new Types.ObjectId(departingUserId.toLowerCase());

    const [user, orgMembership, projectMembership] = await Promise.all([
      db.collection('users').findOne({ _id: userObjId }),
      db.collection('organization_memberships').findOne({
        organizationId: orgObjId,
        userId: userObjId,
      }),
      db.collection('project_memberships').findOne({
        organizationId: orgObjId,
        projectId: projectObjId,
        userId: userObjId,
      }),
    ]);

    const validOrgHistory =
      orgMembership &&
      (orgMembership.status === 'ACTIVE' ||
        orgMembership.status === 'SUSPENDED' ||
        orgMembership.status === 'REMOVED');
    const validProjectHistory =
      projectMembership &&
      (projectMembership.status === 'ACTIVE' ||
        projectMembership.status === 'INACTIVE');

    if (!user || !validOrgHistory || !validProjectHistory) {
      throw new UnprocessableEntityException({
        code: 'DEPARTING_USER_OUT_OF_SCOPE',
        message:
          'Departing user has no active or historical membership in this project.',
      });
    }
  }

  async assertEligibleCoordinator(
    organizationId: string,
    projectId: string,
    assignedLeaderId: string,
  ): Promise<void> {
    if (!OBJECT_ID_RE.test(assignedLeaderId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid assignedLeaderId.',
      });
    }
    const db = this.db();
    const orgObjId = new Types.ObjectId(organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(projectId.toLowerCase());
    const userObjId = new Types.ObjectId(assignedLeaderId.toLowerCase());

    const [user, orgMembership, projectMembership, leaderRole] =
      await Promise.all([
        db.collection('users').findOne({ _id: userObjId }),
        db.collection('organization_memberships').findOne({
          organizationId: orgObjId,
          userId: userObjId,
        }),
        db.collection('project_memberships').findOne({
          organizationId: orgObjId,
          projectId: projectObjId,
          userId: userObjId,
          status: 'ACTIVE',
        }),
        db.collection('role_assignments').findOne({
          organizationId: orgObjId,
          projectId: projectObjId,
          userId: userObjId,
          roleCode: 'TEAM_LEADER',
        }),
      ]);

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !orgMembership ||
      orgMembership.status !== 'ACTIVE' ||
      !projectMembership ||
      !leaderRole
    ) {
      throw new UnprocessableEntityException({
        code: 'COORDINATOR_NOT_ELIGIBLE',
        message:
          'Assigned coordinator D must be an active Project Leader in this project.',
      });
    }
  }

  async assertEligibleActiveProjectMember(
    organizationId: string,
    projectId: string,
    userId: string,
    errorCode = 'MEMBER_NOT_ELIGIBLE',
  ): Promise<void> {
    if (!OBJECT_ID_RE.test(userId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid user identifier.',
      });
    }
    const db = this.db();
    const orgObjId = new Types.ObjectId(organizationId.toLowerCase());
    const projectObjId = new Types.ObjectId(projectId.toLowerCase());
    const userObjId = new Types.ObjectId(userId.toLowerCase());

    const [user, orgMembership, projectMembership] = await Promise.all([
      db.collection('users').findOne({ _id: userObjId }),
      db.collection('organization_memberships').findOne({
        organizationId: orgObjId,
        userId: userObjId,
      }),
      db.collection('project_memberships').findOne({
        organizationId: orgObjId,
        projectId: projectObjId,
        userId: userObjId,
        status: 'ACTIVE',
      }),
    ]);

    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !orgMembership ||
      orgMembership.status !== 'ACTIVE' ||
      !projectMembership
    ) {
      throw new UnprocessableEntityException({
        code: errorCode,
        message: 'Target user must be an active member of this project.',
      });
    }
  }
}
