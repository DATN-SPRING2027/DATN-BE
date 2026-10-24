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
}

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
      };
    }
  }
}
