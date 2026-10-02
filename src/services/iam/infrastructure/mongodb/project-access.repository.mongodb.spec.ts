import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import mongoose, { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoProjectAccessRepository } from './project-access.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

function pauseNextAuthorizationFence(
  connection: mongoose.Connection,
  collection: string,
  documentId?: Types.ObjectId,
) {
  const modelName = `${IAM_PERSISTENCE.databaseName}_${collection}`;
  const model = connection.models[modelName] as unknown as Record<
    string,
    unknown
  >;
  const originalMethod = Reflect.get(model, 'updateOne') as (
    ...args: unknown[]
  ) => unknown;
  const original = (...args: unknown[]) =>
    Reflect.apply(originalMethod, model, args);
  let markReached: () => void = () => undefined;
  let releaseFence: () => void = () => undefined;
  let reached = false;
  let released = false;
  const reachedFence = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const releasedPromise = new Promise<void>((resolve) => {
    releaseFence = resolve;
  });

  Reflect.set(model, 'updateOne', (...args: unknown[]) => {
    const update = args[1] as { $inc?: { __v?: number } } | undefined;
    const filter = args[0] as { _id?: unknown } | undefined;
    if (
      !reached &&
      update?.$inc?.__v === 1 &&
      (!documentId || String(filter?._id) === String(documentId))
    ) {
      reached = true;
      markReached();
      return (async () => {
        await releasedPromise;
        return original(...args);
      })();
    }
    return original(...args);
  });

  const release = () => {
    if (!released) {
      released = true;
      releaseFence();
    }
  };
  return {
    reached: reachedFence,
    release,
    restore() {
      release();
      Reflect.set(model, 'updateOne', originalMethod);
    },
  };
}

integration('MongoProjectAccessRepository mutations and audit', () => {
  it('enforces membership transitions and persists each implemented audit action', async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    const databaseName = `pa_api_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const auditDatabaseName = `${databaseName}_audit`;
    const connection = mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    let createdDatabase = false;
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db || db.databaseName !== databaseName)
        throw new Error('Project Access test database is unavailable');
      createdDatabase = true;
      const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
      const collections = [
        'projects',
        'users',
        'organization_memberships',
        'project_memberships',
        'roles',
        'role_assignments',
      ];
      for (const collection of collections) {
        await db.createCollection(collection);
        const definition = IAM_PERSISTENCE.collections.find(
          (item) => item.name === collection,
        );
        if (!definition) throw new Error(`${collection} schema missing`);
        const model = connection.model(
          `continuum_iam_${collection}`,
          createCollectionSchema(definition),
        );
        await model.createIndexes();
      }
      await auditDb.createCollection('audit_logs_iam');

      const organizationId = new Types.ObjectId();
      const otherOrganizationId = new Types.ObjectId();
      const projectId = new Types.ObjectId();
      const otherProjectId = new Types.ObjectId();
      const adminId = new Types.ObjectId();
      const firstLeaderId = new Types.ObjectId();
      const nextLeaderId = new Types.ObjectId();
      const ordinaryMemberId = new Types.ObjectId();
      const addedMemberId = new Types.ObjectId();
      const membershipRaceRecipientId = new Types.ObjectId();
      const crossOrganizationMemberId = new Types.ObjectId();
      const memberRoleId = new Types.ObjectId();
      const leaderRoleId = new Types.ObjectId();
      const adminRoleId = new Types.ObjectId();
      const now = new Date();

      await db.collection('projects').insertOne({
        _id: projectId,
        organizationId,
        name: 'Private project',
        code: 'PA',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection('projects').insertOne({
        _id: otherProjectId,
        organizationId,
        name: 'Other project',
        code: 'PA-OTHER',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
      const users = [
        adminId,
        firstLeaderId,
        nextLeaderId,
        ordinaryMemberId,
        addedMemberId,
        membershipRaceRecipientId,
        crossOrganizationMemberId,
      ];
      await db.collection('users').insertMany(
        users.map((_id) => ({
          _id,
          email: `${_id.toString()}@example.test`,
          status: 'ACTIVE',
        })),
      );
      await db.collection('organization_memberships').insertMany([
        ...users
          .filter((userId) => !userId.equals(crossOrganizationMemberId))
          .map((userId) => ({
            organizationId,
            userId,
            status: 'ACTIVE',
          })),
        {
          organizationId: otherOrganizationId,
          userId: crossOrganizationMemberId,
          status: 'ACTIVE',
        },
      ]);
      await db.collection('roles').insertMany([
        {
          _id: memberRoleId,
          code: 'MEMBER',
          name: 'Member',
          permissions: ['project.read'],
          isSystem: true,
        },
        {
          _id: leaderRoleId,
          code: 'TEAM_LEADER',
          name: 'Team leader',
          permissions: [
            'project.read',
            'project.members.list',
            'project.members.add',
            'project.members.remove',
          ],
          isSystem: true,
        },
        {
          _id: adminRoleId,
          code: 'ADMIN',
          name: 'Admin',
          permissions: ['project.visibility.manage', 'project.leader.manage'],
          isSystem: true,
        },
      ]);
      await db.collection('role_assignments').insertMany([
        {
          organizationId,
          userId: adminId,
          roleId: adminRoleId,
          roleCode: 'ADMIN',
          assignedBy: adminId,
        },
        ...[firstLeaderId, nextLeaderId, ordinaryMemberId].map((userId) => ({
          organizationId,
          projectId,
          userId,
          roleId: memberRoleId,
          roleCode: 'MEMBER',
          assignedBy: adminId,
        })),
        {
          organizationId,
          projectId: otherProjectId,
          userId: firstLeaderId,
          roleId: leaderRoleId,
          roleCode: 'TEAM_LEADER',
          assignedBy: adminId,
        },
      ]);
      await db.collection('project_memberships').insertMany([
        ...[firstLeaderId, nextLeaderId, ordinaryMemberId].map((userId) => ({
          organizationId,
          projectId,
          userId,
          status: 'ACTIVE',
          joinedAt: now,
        })),
        {
          organizationId,
          projectId: otherProjectId,
          userId: firstLeaderId,
          status: 'ACTIVE',
          joinedAt: now,
        },
      ]);

      const repository = new MongoProjectAccessRepository(
        connection,
        auditDatabaseName,
      );
      const organization = organizationId.toString();
      const project = projectId.toString();
      const admin = adminId.toString();
      const firstLeader = firstLeaderId.toString();
      const nextLeader = nextLeaderId.toString();
      const ordinaryMember = ordinaryMemberId.toString();
      const addedMember = addedMemberId.toString();
      const membershipRaceRecipient = membershipRaceRecipientId.toString();

      const projectDocument = db.collection('projects');
      const orgMemberships = db.collection('organization_memberships');
      const roleAssignments = db.collection('role_assignments');
      const rolesCollection = db.collection('roles');
      const expectConcurrentAuthorizationRevocationToDeny = async (
        collection: string,
        revoke: () => Promise<unknown>,
        restore: () => Promise<unknown>,
      ) => {
        const gate = pauseNextAuthorizationFence(connection, collection);
        const pending = repository.makePublic(organization, admin, project);
        try {
          await gate.reached;
          await revoke();
          gate.release();
          await expect(pending).rejects.toBeInstanceOf(ForbiddenException);
          expect(
            (await projectDocument.findOne({ _id: projectId }))?.visibility,
          ).toBe('PRIVATE');
        } finally {
          gate.restore();
          await restore();
        }
      };

      await expectConcurrentAuthorizationRevocationToDeny(
        'organization_memberships',
        () =>
          orgMemberships.updateOne(
            { organizationId, userId: adminId },
            { $set: { status: 'REMOVED' } },
          ),
        () =>
          orgMemberships.updateOne(
            { organizationId, userId: adminId },
            { $set: { status: 'ACTIVE' } },
          ),
      );
      const adminAssignment = await roleAssignments.findOne({
        organizationId,
        userId: adminId,
        projectId: { $exists: false },
      });
      if (!adminAssignment)
        throw new Error('Seed ADMIN RoleAssignment missing');
      await expectConcurrentAuthorizationRevocationToDeny(
        'role_assignments',
        () => roleAssignments.deleteOne({ _id: adminAssignment._id }),
        () => roleAssignments.insertOne(adminAssignment),
      );
      await expectConcurrentAuthorizationRevocationToDeny(
        'roles',
        () =>
          rolesCollection.updateOne(
            { _id: adminRoleId },
            { $set: { permissions: ['project.leader.manage'] } },
          ),
        () =>
          rolesCollection.updateOne(
            { _id: adminRoleId },
            {
              $set: {
                permissions: [
                  'project.visibility.manage',
                  'project.leader.manage',
                ],
              },
            },
          ),
      );

      const published = await repository.makePublic(
        organization,
        admin,
        project.toUpperCase(),
      );
      expect(published.visibility).toBe('PUBLIC');
      expect(published.id).toBe(project);
      await expect(
        repository.makePublic(organization, admin, project),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repository.makePublic(organization, ordinaryMember, project),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await auditDb
          .collection('audit_logs_iam')
          .countDocuments({ action: 'PROJECT_VISIBILITY_CHANGED' }),
      ).toBe(1);
      await repository.assignLeader(organization, admin, project, firstLeader);
      const added = await repository.addMember(
        organization,
        firstLeader,
        project.toUpperCase(),
        addedMember,
      );
      expect(added.status).toBe('ACTIVE');
      await expect(
        repository.addMember(
          organization,
          firstLeader,
          project.toUpperCase(),
          addedMember,
        ),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        repository.addMember(
          organization,
          firstLeader,
          project,
          crossOrganizationMemberId.toString(),
        ),
      ).rejects.toMatchObject({ status: 404 });

      const raceOrganizationMembership = await orgMemberships.findOne({
        organizationId,
        userId: membershipRaceRecipientId,
        status: 'ACTIVE',
      });
      if (!raceOrganizationMembership)
        throw new Error('Seed race recipient OrganizationMembership missing');
      const recipientOrganizationFence = pauseNextAuthorizationFence(
        connection,
        'organization_memberships',
        raceOrganizationMembership._id,
      );
      const staleRecipientAdd = repository.addMember(
        organization,
        firstLeader,
        project,
        membershipRaceRecipient,
      );
      try {
        await recipientOrganizationFence.reached;
        expect(
          await db.collection('role_assignments').findOne({
            organizationId,
            projectId,
            userId: firstLeaderId,
            roleCode: 'TEAM_LEADER',
          }),
        ).not.toBeNull();
        expect(
          await db.collection('users').findOne({
            _id: firstLeaderId,
            status: 'ACTIVE',
          }),
        ).not.toBeNull();
        expect(
          await orgMemberships.findOne({
            organizationId,
            userId: firstLeaderId,
            status: 'ACTIVE',
          }),
        ).not.toBeNull();
        expect(
          await db.collection('project_memberships').findOne({
            organizationId,
            projectId,
            userId: firstLeaderId,
            status: 'ACTIVE',
          }),
        ).not.toBeNull();
        const revoked = await orgMemberships.updateOne(
          { _id: raceOrganizationMembership._id, status: 'ACTIVE' },
          { $set: { status: 'REMOVED' } },
        );
        expect(revoked.modifiedCount).toBe(1);
        recipientOrganizationFence.release();
        await expect(staleRecipientAdd).rejects.toMatchObject({ status: 404 });
        expect(
          await db.collection('project_memberships').findOne({
            organizationId,
            projectId,
            userId: membershipRaceRecipientId,
          }),
        ).toBeNull();
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: membershipRaceRecipientId,
          }),
        ).toBeNull();
        expect(
          await auditDb
            .collection('audit_logs_iam')
            .countDocuments({ action: 'PROJECT_MEMBER_ADDED' }),
        ).toBe(1);
      } finally {
        recipientOrganizationFence.restore();
        await orgMemberships.updateOne(
          { _id: raceOrganizationMembership._id },
          { $set: { status: 'ACTIVE' } },
        );
      }

      const recipientRoleFence = pauseNextAuthorizationFence(
        connection,
        'roles',
        memberRoleId,
      );
      const staleRoleAdd = repository.addMember(
        organization,
        firstLeader,
        project,
        membershipRaceRecipient,
      );
      try {
        await recipientRoleFence.reached;
        const rolePermissionsChanged = await rolesCollection.updateOne(
          { _id: memberRoleId },
          { $set: { permissions: [] } },
        );
        expect(rolePermissionsChanged.modifiedCount).toBe(1);
        recipientRoleFence.release();
        await expect(staleRoleAdd).rejects.toMatchObject({ status: 409 });
        expect(
          await db.collection('project_memberships').findOne({
            organizationId,
            projectId,
            userId: membershipRaceRecipientId,
          }),
        ).toBeNull();
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: membershipRaceRecipientId,
          }),
        ).toBeNull();
        expect(
          await auditDb
            .collection('audit_logs_iam')
            .countDocuments({ action: 'PROJECT_MEMBER_ADDED' }),
        ).toBe(1);
      } finally {
        recipientRoleFence.restore();
        await rolesCollection.updateOne(
          { _id: memberRoleId },
          { $set: { permissions: ['project.read'] } },
        );
      }

      const addedMembership = await db
        .collection('project_memberships')
        .findOne({
          organizationId,
          projectId,
          userId: addedMemberId,
          status: 'ACTIVE',
        });
      if (!addedMembership)
        throw new Error('Added Project member membership missing');
      const assignmentProjectMembershipFence = pauseNextAuthorizationFence(
        connection,
        'project_memberships',
        addedMembership._id,
      );
      const staleLeaderAssignment = repository.assignLeader(
        organization,
        admin,
        project,
        addedMember,
      );
      try {
        await assignmentProjectMembershipFence.reached;
        const revoked = await db
          .collection('project_memberships')
          .updateOne(
            { _id: addedMembership._id, status: 'ACTIVE' },
            { $set: { status: 'INACTIVE' } },
          );
        expect(revoked.modifiedCount).toBe(1);
        assignmentProjectMembershipFence.release();
        await expect(staleLeaderAssignment).rejects.toMatchObject({
          status: 404,
        });
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: addedMemberId,
            roleCode: 'MEMBER',
          }),
        ).not.toBeNull();
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: addedMemberId,
            roleCode: 'TEAM_LEADER',
          }),
        ).toBeNull();
        expect(
          await auditDb
            .collection('audit_logs_iam')
            .countDocuments({ action: 'PROJECT_LEADER_ASSIGNED' }),
        ).toBe(1);
      } finally {
        assignmentProjectMembershipFence.restore();
        await db
          .collection('project_memberships')
          .updateOne(
            { _id: addedMembership._id },
            { $set: { status: 'ACTIVE' } },
          );
      }

      const memberRecord = await db.collection('project_memberships').findOne({
        organizationId,
        projectId,
        userId: new Types.ObjectId(ordinaryMember),
        status: 'ACTIVE',
      });
      if (!memberRecord) throw new Error('Seed Project member not found');
      const leaderMembership = await db
        .collection('project_memberships')
        .findOne({
          organizationId,
          projectId,
          userId: firstLeaderId,
          status: 'ACTIVE',
        });
      if (!leaderMembership)
        throw new Error('Seed Project Leader membership not found');
      const projectMembershipGate = pauseNextAuthorizationFence(
        connection,
        'project_memberships',
      );
      const staleProjectMembershipMutation = repository.removeMember(
        organization,
        firstLeader,
        project,
        String(memberRecord._id),
      );
      try {
        await projectMembershipGate.reached;
        await db
          .collection('project_memberships')
          .updateOne(
            { _id: leaderMembership._id, status: 'ACTIVE' },
            { $set: { status: 'INACTIVE' } },
          );
        projectMembershipGate.release();
        await expect(staleProjectMembershipMutation).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(
          await db.collection('project_memberships').findOne({
            _id: memberRecord._id,
            status: 'ACTIVE',
          }),
        ).not.toBeNull();
      } finally {
        projectMembershipGate.restore();
        await db
          .collection('project_memberships')
          .updateOne(
            { _id: leaderMembership._id },
            { $set: { status: 'ACTIVE' } },
          );
      }
      await expect(
        repository.removeMember(
          organization,
          ordinaryMember,
          project,
          String(memberRecord._id),
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        repository.removeMember(
          organization,
          firstLeader,
          otherProjectId.toString().toUpperCase(),
          String(memberRecord._id),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        repository.removeMember(
          organization,
          firstLeader,
          project,
          new Types.ObjectId().toString(),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        repository.removeMember(
          otherOrganizationId.toString(),
          firstLeader,
          project,
          String(memberRecord._id),
        ),
      ).rejects.toMatchObject({ status: 404 });
      await repository.removeMember(
        organization,
        firstLeader,
        project,
        String(memberRecord._id),
      );
      await expect(
        repository.removeMember(
          organization,
          firstLeader,
          project,
          String(memberRecord._id),
        ),
      ).resolves.toBeUndefined();

      const replacementMembership = await db
        .collection('project_memberships')
        .findOne({
          organizationId,
          projectId,
          userId: nextLeaderId,
          status: 'ACTIVE',
        });
      if (!replacementMembership)
        throw new Error('Replacement Leader ProjectMembership missing');
      const replacementProjectMembershipFence = pauseNextAuthorizationFence(
        connection,
        'project_memberships',
        replacementMembership._id,
      );
      const staleLeaderChange = repository.changeLeader(
        organization,
        admin,
        project,
        firstLeader,
        nextLeader,
      );
      try {
        await replacementProjectMembershipFence.reached;
        const inactivated = await db
          .collection('project_memberships')
          .updateOne(
            { _id: replacementMembership._id, status: 'ACTIVE' },
            { $set: { status: 'INACTIVE' } },
          );
        expect(inactivated.modifiedCount).toBe(1);
        replacementProjectMembershipFence.release();
        await expect(staleLeaderChange).rejects.toMatchObject({ status: 404 });
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: firstLeaderId,
            roleCode: 'TEAM_LEADER',
          }),
        ).not.toBeNull();
        expect(
          await roleAssignments.findOne({
            organizationId,
            projectId,
            userId: nextLeaderId,
            roleCode: 'MEMBER',
          }),
        ).not.toBeNull();
        expect(
          await auditDb
            .collection('audit_logs_iam')
            .countDocuments({ action: 'PROJECT_LEADER_CHANGED' }),
        ).toBe(0);
      } finally {
        replacementProjectMembershipFence.restore();
        await db
          .collection('project_memberships')
          .updateOne(
            { _id: replacementMembership._id },
            { $set: { status: 'ACTIVE' } },
          );
      }

      await repository.changeLeader(
        organization,
        admin,
        project,
        firstLeader,
        nextLeader,
      );
      await repository.revokeLeader(organization, admin, project, nextLeader);

      expect(
        await db.collection('role_assignments').findOne({
          organizationId,
          projectId,
          userId: new Types.ObjectId(firstLeader),
          roleCode: 'MEMBER',
        }),
      ).not.toBeNull();
      expect(
        await db.collection('role_assignments').findOne({
          organizationId,
          projectId,
          userId: new Types.ObjectId(nextLeader),
          roleCode: 'MEMBER',
        }),
      ).not.toBeNull();
      expect(
        await db.collection('project_memberships').findOne({
          _id: memberRecord._id,
          status: 'INACTIVE',
        }),
      ).not.toBeNull();
      const audit = auditDb.collection('audit_logs_iam');
      for (const [action, count] of [
        ['PROJECT_VISIBILITY_CHANGED', 1],
        ['PROJECT_MEMBER_ADDED', 1],
        ['PROJECT_LEADER_ASSIGNED', 1],
        ['PROJECT_LEADER_CHANGED', 2],
        ['PROJECT_LEADER_REVOKED', 1],
        ['PROJECT_MEMBER_REMOVED', 1],
      ] as const) {
        expect(await audit.countDocuments({ action })).toBe(count);
      }
      expect(await audit.countDocuments()).toBe(7);
    } finally {
      if (
        createdDatabase &&
        connection.readyState === mongoose.ConnectionStates.connected &&
        connection.db?.databaseName === databaseName
      )
        await connection.db.dropDatabase();
      if (createdDatabase)
        await connection.useDb(auditDatabaseName).dropDatabase();
      await connection.close();
    }
  });
});
