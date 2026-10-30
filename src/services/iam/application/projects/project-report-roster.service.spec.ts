import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Types } from 'mongoose';
import { ProjectReportRosterService } from './project-report-roster.service';

describe('Project Report roster', () => {
  jest.setTimeout(120_000);
  it('returns active organization and Project members and leaders in distinct tiers and resolves active Managers', async () => {
    const server = await MongoMemoryServer.create({
      binary: { version: '7.0.24' },
    });
    const connection = mongoose.createConnection(server.getUri());
    try {
      await connection.asPromise();
      const db = connection.db!;
      const organizationId = new Types.ObjectId();
      const projectId = new Types.ObjectId();
      const author = new Types.ObjectId();
      const member = new Types.ObjectId();
      const leader = new Types.ObjectId();
      const manager = new Types.ObjectId();
      const inactive = new Types.ObjectId();
      const suspended = new Types.ObjectId();
      const leaderRoleId = new Types.ObjectId();
      const adminRoleId = new Types.ObjectId();
      const joinedAt = new Date('2026-10-20T12:00:00.000Z');
      await db.collection('projects').insertOne({
        _id: projectId,
        organizationId,
        status: 'ACTIVE',
        createdBy: author,
      });
      await db.collection('project_memberships').insertMany(
        [member, leader, inactive, suspended].map((userId) => ({
          organizationId,
          projectId,
          userId,
          status: 'ACTIVE',
          joinedAt,
        })),
      );
      await db.collection('organization_memberships').insertMany([
        { organizationId, userId: member, status: 'ACTIVE' },
        { organizationId, userId: leader, status: 'ACTIVE' },
        { organizationId, userId: manager, status: 'ACTIVE' },
        { organizationId, userId: inactive, status: 'INACTIVE' },
        { organizationId, userId: suspended, status: 'ACTIVE' },
      ]);
      await db.collection('users').insertMany([
        { _id: member, status: 'ACTIVE' },
        { _id: leader, status: 'ACTIVE' },
        { _id: manager, status: 'ACTIVE' },
        { _id: suspended, status: 'SUSPENDED' },
      ]);
      await db.collection('roles').insertMany([
        { _id: leaderRoleId, code: 'TEAM_LEADER' },
        { _id: adminRoleId, code: 'ADMIN' },
      ]);
      await db.collection('role_assignments').insertMany([
        {
          organizationId,
          projectId,
          userId: leader,
          roleCode: 'TEAM_LEADER',
          roleId: leaderRoleId,
        },
        {
          organizationId,
          projectId: null,
          userId: manager,
          roleCode: 'ADMIN',
          roleId: adminRoleId,
        },
      ]);
      const roster = new ProjectReportRosterService(connection);
      const projects = [];
      for await (const project of roster.activeProjects())
        projects.push(project);
      expect(projects).toEqual([
        {
          organizationId: String(organizationId),
          projectId: String(projectId),
          projectCreatedBy: String(author),
          members: [
            { userId: String(member), joinedAt: joinedAt.toISOString() },
          ],
          leaders: [
            { userId: String(leader), joinedAt: joinedAt.toISOString() },
          ],
        },
      ]);
      await expect(
        roster.listActiveProjectLeaderIds(
          String(organizationId),
          String(projectId),
        ),
      ).resolves.toEqual([String(leader).toLowerCase()]);
      await expect(
        roster.listActiveOrganizationManagerIds(String(organizationId)),
      ).resolves.toEqual([String(manager).toLowerCase()]);
    } finally {
      await connection.close();
      await server.stop();
    }
  });
});
