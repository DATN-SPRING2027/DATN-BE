import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type Connection } from 'mongoose';
import { IAM_PERSISTENCE } from '../../infrastructure/persistence';

export interface ReportingProjectMembers {
  organizationId: string;
  projectId: string;
  projectCreatedBy: string;
  members: Array<{ userId: string; joinedAt: string }>;
  leaders?: Array<{ userId: string; joinedAt: string }>;
}

const validObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

/** Read-only project membership source used by Capture's scheduled reports. */
@Injectable()
export class ProjectReportRosterService {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async *activeProjects(): AsyncGenerator<ReportingProjectMembers> {
    const db = this.connection?.db;
    if (!db)
      throw new ServiceUnavailableException('IAM persistence is unavailable.');
    const projects = db.collection('projects').find(
      { status: 'ACTIVE' },
      {
        projection: { _id: 1, organizationId: 1, createdBy: 1 },
      },
    );
    for await (const project of projects) {
      const organizationId = project.organizationId as Types.ObjectId;
      const projectId = project._id;
      const memberships = await db
        .collection('project_memberships')
        .find(
          {
            organizationId,
            projectId,
            status: 'ACTIVE',
          },
          { projection: { userId: 1, joinedAt: 1 } },
        )
        .toArray();
      if (memberships.length === 0) continue;
      const userIds = memberships.map((item) => item.userId as Types.ObjectId);
      const [organizationMemberships, leaderAssignments, inactiveUsers] =
        await Promise.all([
          db
            .collection('organization_memberships')
            .find(
              {
                organizationId,
                userId: { $in: userIds },
                status: 'ACTIVE',
              },
              { projection: { userId: 1 } },
            )
            .toArray(),
          db
            .collection('role_assignments')
            .find(
              {
                organizationId,
                projectId,
                userId: { $in: userIds },
                roleCode: 'TEAM_LEADER',
              },
              { projection: { userId: 1, roleId: 1 } },
            )
            .toArray(),
          db
            .collection('users')
            .find(
              {
                _id: { $in: userIds },
                status: { $ne: 'ACTIVE' },
              },
              { projection: { _id: 1 } },
            )
            .toArray(),
        ]);
      const activeOrganizationUsers = new Set(
        organizationMemberships.map((item) => String(item.userId)),
      );
      const inactiveUserIds = new Set(
        inactiveUsers.map((item) => String(item._id)),
      );
      const currentLeaderRoles = await db
        .collection('roles')
        .find(
          {
            _id: {
              $in: leaderAssignments.map(
                (item) => item.roleId as Types.ObjectId,
              ),
            },
            code: 'TEAM_LEADER',
          },
          { projection: { _id: 1 } },
        )
        .toArray();
      const currentRoleIds = new Set(
        currentLeaderRoles.map((item) => String(item._id)),
      );
      const leaders = new Set(
        leaderAssignments
          .filter((item) => currentRoleIds.has(String(item.roleId)))
          .map((item) => String(item.userId)),
      );
      yield {
        organizationId: String(organizationId),
        projectId: String(projectId),
        projectCreatedBy: String(project.createdBy),
        members: memberships.flatMap((item) => {
          const userId = String(item.userId);
          const joinedAt = item.joinedAt as Date;
          return activeOrganizationUsers.has(userId) &&
            !inactiveUserIds.has(userId) &&
            !leaders.has(userId) &&
            joinedAt instanceof Date
            ? [{ userId, joinedAt: joinedAt.toISOString() }]
            : [];
        }),
        leaders: memberships.flatMap((item) => {
          const userId = String(item.userId);
          const joinedAt = item.joinedAt as Date;
          return activeOrganizationUsers.has(userId) &&
            !inactiveUserIds.has(userId) &&
            leaders.has(userId) &&
            joinedAt instanceof Date
            ? [{ userId, joinedAt: joinedAt.toISOString() }]
            : [];
        }),
      };
    }
  }

  async listActiveProjectLeaderIds(
    organizationId: string,
    projectId: string,
  ): Promise<string[]> {
    const db = this.connection?.db;
    if (!db || !validObjectId(organizationId) || !validObjectId(projectId)) {
      return [];
    }
    const orgObjectId = new Types.ObjectId(organizationId.toLowerCase());
    const projectObjectId = new Types.ObjectId(projectId.toLowerCase());
    const leaderAssignments = await db
      .collection('role_assignments')
      .find(
        {
          organizationId: orgObjectId,
          projectId: projectObjectId,
          roleCode: 'TEAM_LEADER',
        },
        { projection: { userId: 1, roleId: 1 } },
      )
      .toArray();
    if (leaderAssignments.length === 0) return [];
    const currentLeaderRoles = await db
      .collection('roles')
      .find(
        {
          _id: {
            $in: leaderAssignments.map((item) => item.roleId as Types.ObjectId),
          },
          code: 'TEAM_LEADER',
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    const validRoleIds = new Set(
      currentLeaderRoles.map((item) => String(item._id)),
    );
    const candidateUserIds = [
      ...new Set(
        leaderAssignments
          .filter((item) => validRoleIds.has(String(item.roleId)))
          .map((item) => String(item.userId).toLowerCase())
          .filter(validObjectId),
      ),
    ];
    if (candidateUserIds.length === 0) return [];
    const candidateObjectIds = candidateUserIds.map(
      (id) => new Types.ObjectId(id),
    );
    const [projectMemberships, orgMemberships, inactiveUsers] =
      await Promise.all([
        db
          .collection('project_memberships')
          .find(
            {
              organizationId: orgObjectId,
              projectId: projectObjectId,
              userId: { $in: candidateObjectIds },
              status: 'ACTIVE',
            },
            { projection: { userId: 1 } },
          )
          .toArray(),
        db
          .collection('organization_memberships')
          .find(
            {
              organizationId: orgObjectId,
              userId: { $in: candidateObjectIds },
              status: 'ACTIVE',
            },
            { projection: { userId: 1 } },
          )
          .toArray(),
        db
          .collection('users')
          .find(
            {
              _id: { $in: candidateObjectIds },
              status: { $ne: 'ACTIVE' },
            },
            { projection: { _id: 1 } },
          )
          .toArray(),
      ]);
    const activeProjectUserIds = new Set(
      projectMemberships.map((item) => String(item.userId).toLowerCase()),
    );
    const activeOrgUserIds = new Set(
      orgMemberships.map((item) => String(item.userId).toLowerCase()),
    );
    const inactiveUserIds = new Set(
      inactiveUsers.map((item) => String(item._id).toLowerCase()),
    );
    return candidateUserIds.filter(
      (id) =>
        activeProjectUserIds.has(id) &&
        activeOrgUserIds.has(id) &&
        !inactiveUserIds.has(id),
    );
  }

  async listActiveOrganizationManagerIds(
    organizationId: string,
  ): Promise<string[]> {
    const db = this.connection?.db;
    if (!db || !validObjectId(organizationId)) {
      return [];
    }
    const orgObjectId = new Types.ObjectId(organizationId.toLowerCase());
    const adminAssignments = await db
      .collection('role_assignments')
      .find(
        {
          organizationId: orgObjectId,
          projectId: null,
          roleCode: 'ADMIN',
        },
        { projection: { userId: 1, roleId: 1 } },
      )
      .toArray();
    if (adminAssignments.length === 0) return [];
    const currentAdminRoles = await db
      .collection('roles')
      .find(
        {
          _id: {
            $in: adminAssignments.map((item) => item.roleId as Types.ObjectId),
          },
          code: 'ADMIN',
        },
        { projection: { _id: 1 } },
      )
      .toArray();
    const validRoleIds = new Set(
      currentAdminRoles.map((item) => String(item._id)),
    );
    const candidateUserIds = [
      ...new Set(
        adminAssignments
          .filter((item) => validRoleIds.has(String(item.roleId)))
          .map((item) => String(item.userId).toLowerCase())
          .filter(validObjectId),
      ),
    ];
    if (candidateUserIds.length === 0) return [];
    const candidateObjectIds = candidateUserIds.map(
      (id) => new Types.ObjectId(id),
    );
    const [orgMemberships, inactiveUsers] = await Promise.all([
      db
        .collection('organization_memberships')
        .find(
          {
            organizationId: orgObjectId,
            userId: { $in: candidateObjectIds },
            status: 'ACTIVE',
          },
          { projection: { userId: 1 } },
        )
        .toArray(),
      db
        .collection('users')
        .find(
          {
            _id: { $in: candidateObjectIds },
            status: { $ne: 'ACTIVE' },
          },
          { projection: { _id: 1 } },
        )
        .toArray(),
    ]);
    const activeOrgUserIds = new Set(
      orgMemberships.map((item) => String(item.userId).toLowerCase()),
    );
    const inactiveUserIds = new Set(
      inactiveUsers.map((item) => String(item._id).toLowerCase()),
    );
    return candidateUserIds.filter(
      (id) => activeOrgUserIds.has(id) && !inactiveUserIds.has(id),
    );
  }
}
