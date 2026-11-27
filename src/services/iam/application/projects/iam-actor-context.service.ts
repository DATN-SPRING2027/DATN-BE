import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { memoizeInRequest } from '../../../../common/http/request-context';
import { IAM_PERSISTENCE } from '../../infrastructure/persistence';
import {
  AuthenticationApplicationService,
  type AuthenticatedIdentity,
} from '../authentication/authentication.application.service';

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

export interface IamProjectSummary {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  status: 'ACTIVE' | 'ARCHIVED';
  visibility: 'PRIVATE' | 'PUBLIC';
}

export interface IamProjectActorContext {
  actor: AuthenticatedIdentity;
  project: IamProjectSummary;
  isProjectMember: boolean;
  isLeader: boolean;
  isManager: boolean;
  joinedAt: string | null;
  canReview: boolean;
}

@Injectable()
export class IamActorContextService {
  constructor(
    private readonly auth: AuthenticationApplicationService,
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

  async resolveProjectActorContext(input: {
    authorization?: string;
    cookie?: string;
    actor?: AuthenticatedIdentity;
    projectId: string;
    organizationHeader?: string;
    requireActiveProject?: boolean;
  }): Promise<IamProjectActorContext> {
    if (!OBJECT_ID_RE.test(input.projectId)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Invalid projectId format.',
      });
    }
    const actor =
      input.actor ??
      (await this.auth.getCurrentIdentity(input.authorization, input.cookie));
    const normalizedProjectId = input.projectId.toLowerCase();
    const orgIdStr = actor.organizationId.toLowerCase();

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

    const memoKey = `${actor.id.toLowerCase()}:${orgIdStr}:${normalizedProjectId}:${input.requireActiveProject ? 'active' : 'any'}`;
    return memoizeInRequest('iam:project-actor-context', memoKey, async () => {
      const db = this.db();
      const orgObjId = new Types.ObjectId(orgIdStr);
      const projectObjId = new Types.ObjectId(normalizedProjectId);
      const actorObjId = new Types.ObjectId(actor.id.toLowerCase());

      const [project, membership, roleAssignments] = await Promise.all([
        db.collection('projects').findOne(
          {
            _id: projectObjId,
            organizationId: orgObjId,
          },
          {
            projection: {
              _id: 1,
              organizationId: 1,
              name: 1,
              code: 1,
              status: 1,
              visibility: 1,
            },
          },
        ),
        db.collection('project_memberships').findOne(
          {
            organizationId: orgObjId,
            projectId: projectObjId,
            userId: actorObjId,
            status: 'ACTIVE',
          },
          { projection: { _id: 1, status: 1, joinedAt: 1 } },
        ),
        db
          .collection('role_assignments')
          .find(
            {
              organizationId: orgObjId,
              userId: actorObjId,
              $or: [
                { projectId: { $exists: false } },
                { projectId: null },
                { projectId: projectObjId },
              ],
            },
            { projection: { projectId: 1, roleCode: 1 } },
          )
          .toArray(),
      ]);

      if (
        !project ||
        (input.requireActiveProject !== false && project.status !== 'ACTIVE')
      ) {
        throw new NotFoundException({
          code: 'PROJECT_NOT_FOUND',
          message: 'Project not found.',
        });
      }

      const isProjectMember = Boolean(membership);
      const isLeader =
        isProjectMember &&
        roleAssignments.some(
          (row) =>
            row.projectId instanceof Types.ObjectId &&
            row.projectId.equals(projectObjId) &&
            row.roleCode === 'TEAM_LEADER',
        );
      const isManager =
        roleAssignments.some(
          (row) =>
            (row.projectId === null || row.projectId === undefined) &&
            row.roleCode === 'ADMIN',
        ) ||
        (Array.isArray(actor.roles) && actor.roles.includes('ADMIN'));

      const joinedAtDate =
        membership?.joinedAt instanceof Date &&
        Number.isFinite(membership.joinedAt.getTime())
          ? membership.joinedAt
          : null;

      return {
        actor,
        project: {
          id: normalizedProjectId,
          organizationId: orgIdStr,
          name: typeof project.name === 'string' ? project.name : 'Project',
          code: typeof project.code === 'string' ? project.code : 'PRJ',
          status: project.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
          visibility: project.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
        },
        isProjectMember,
        isLeader,
        isManager,
        joinedAt: joinedAtDate ? joinedAtDate.toISOString() : null,
        canReview: isLeader || isManager,
      };
    });
  }

  /**
   * Lists ONLY ACTIVE projects in the actor's active Organization where the
   * actor has an explicit ACTIVE project membership (`SEC-AUTH-001` / Trap 5).
   * Never includes unjoined PUBLIC projects, unjoined PRIVATE projects, or
   * ARCHIVED projects.
   */
  async listActiveMemberProjects(
    actor: AuthenticatedIdentity,
    maxCount = 256,
  ): Promise<IamProjectSummary[]> {
    const orgIdStr = actor.organizationId.toLowerCase();
    const actorIdStr = actor.id.toLowerCase();
    if (!OBJECT_ID_RE.test(orgIdStr) || !OBJECT_ID_RE.test(actorIdStr)) {
      return [];
    }
    const db = this.db();
    const orgObjId = new Types.ObjectId(orgIdStr);
    const actorObjId = new Types.ObjectId(actorIdStr);

    const memberships = await db
      .collection('project_memberships')
      .find(
        {
          organizationId: orgObjId,
          userId: actorObjId,
          status: 'ACTIVE',
        },
        { projection: { projectId: 1 } },
      )
      .limit(maxCount + 1)
      .toArray();

    const projectObjIds = memberships
      .map((row) => row.projectId as unknown)
      .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
    if (projectObjIds.length === 0) {
      return [];
    }

    const projects = await db
      .collection('projects')
      .find(
        {
          _id: { $in: projectObjIds },
          organizationId: orgObjId,
          status: 'ACTIVE',
        },
        {
          projection: {
            _id: 1,
            organizationId: 1,
            name: 1,
            code: 1,
            status: 1,
            visibility: 1,
          },
        },
      )
      .limit(maxCount + 1)
      .toArray();

    return projects.map((project) => ({
      id: project._id.toHexString().toLowerCase(),
      organizationId: orgIdStr,
      name: typeof project.name === 'string' ? project.name : 'Project',
      code: typeof project.code === 'string' ? project.code : 'PRJ',
      status: 'ACTIVE' as const,
      visibility: project.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    }));
  }
}
