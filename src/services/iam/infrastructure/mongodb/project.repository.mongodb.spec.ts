import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthenticationApplicationService } from '../../application/authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type ProjectCreateEvidence,
} from '../../application/authorization/authorization-evidence.provider';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { ProjectCreateAuthorizationGuard } from '../../application/authorization/project-create-authorization.guard';
import { ProjectService } from '../../application/projects/project.service';
import { PROJECT_REPOSITORY } from '../../application/projects/project.repository';
import { ProjectController } from '../../controllers/project.controller';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoProjectRepository } from './project.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

interface ProjectResponse {
  id: string;
  organizationId: string;
}

function isProjectResponse(value: unknown): value is ProjectResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'organizationId' in value &&
    typeof value.organizationId === 'string'
  );
}

function isProjectListResponse(
  value: unknown,
): value is { data: Array<{ id: string }> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'data' in value &&
    Array.isArray(value.data) &&
    value.data.every(
      (project: unknown) =>
        typeof project === 'object' &&
        project !== null &&
        'id' in project &&
        typeof project.id === 'string',
    )
  );
}

function isProjectMetadataResponse(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

integration('MongoProjectRepository transaction and unique index', () => {
  it('bootstraps creator access, enforces Project read boundaries, rolls back failures, and scopes codes by Organization', async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    const databaseName = `pf_api_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const auditDatabaseName = `${databaseName}_audit`;
    const connection = mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    let app: INestApplication | undefined;
    let createdDatabase = false;
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db) throw new Error('MongoDB connection unavailable');
      if (db.databaseName !== databaseName)
        throw new Error('Wrong test database');
      createdDatabase = true;
      const auditDb = connection.useDb(auditDatabaseName, { useCache: true });
      const collections = [
        'projects',
        'organization_memberships',
        'project_memberships',
        'role_assignments',
        'roles',
        'teams',
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
      const repository = new MongoProjectRepository(
        new AuthorizationPolicy(),
        connection,
        auditDatabaseName,
      );
      const orgA = new Types.ObjectId().toString();
      const orgB = new Types.ObjectId().toString();
      const user = new Types.ObjectId().toString();
      await db.collection('roles').insertOne({
        _id: new Types.ObjectId(),
        code: 'TEAM_LEADER',
        name: 'Team Leader',
        permissions: [
          'project.read',
          'project.members.list',
          'project.members.add',
          'project.members.remove',
          'project.update',
          'project.visibility.manage',
        ],
        isSystem: true,
      });
      await db.collection('organization_memberships').insertOne({
        organizationId: new Types.ObjectId(orgA),
        userId: new Types.ObjectId(user),
        status: 'ACTIVE',
      });

      const identity = {
        id: user,
        organizationId: orgA,
        email: 'creator@example.test',
        name: 'Creator',
        roles: ['MEMBER'],
      };
      let currentIdentity = identity;
      const facts: ProjectCreateEvidence = {
        membership: { userId: user, organizationId: orgA, status: 'ACTIVE' },
        explicitDeny: 'CLEAR',
      };
      const module = await Test.createTestingModule({
        controllers: [ProjectController],
        providers: [
          ProjectCreateAuthorizationGuard,
          AuthorizationPolicy,
          {
            provide: AuthenticationApplicationService,
            useValue: {
              getCurrentIdentity: jest
                .fn()
                .mockImplementation(() => Promise.resolve(currentIdentity)),
            },
          },
          {
            provide: AUTHORIZATION_EVIDENCE_PROVIDER,
            useValue: {
              loadProjectCreate: jest.fn().mockResolvedValue(facts),
            },
          },
          ProjectService,
          { provide: PROJECT_REPOSITORY, useValue: repository },
        ],
      }).compile();
      app = module.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.init();

      const post = await request(app.getHttpServer() as App)
        .post('/api/v1/iam/projects')
        .set('Authorization', 'Bearer valid')
        .send({ name: 'First', code: 'EX' })
        .expect(201);
      const firstBody: unknown = post.body;
      if (!isProjectResponse(firstBody))
        throw new Error('Create Project response is invalid');
      const first = firstBody;
      expect(first.organizationId).toBe(orgA);
      expect(first.id).toMatch(/^[a-f\d]{24}$/i);
      expect(await db.collection('projects').countDocuments()).toBe(1);
      const storedProject = await db.collection('projects').findOne({
        _id: new Types.ObjectId(first.id),
      });
      expect(storedProject).toMatchObject({
        organizationId: new Types.ObjectId(orgA),
        createdBy: new Types.ObjectId(user),
        visibility: 'PRIVATE',
      });
      expect(
        await auditDb.collection('audit_logs_iam').countDocuments({
          targetResourceId: first.id,
          action: 'project.create',
        }),
      ).toBe(1);
      const auditEvent = await auditDb.collection('audit_logs_iam').findOne({
        targetResourceId: first.id,
        action: 'project.create',
      });
      expect(auditEvent?.metadata).toMatchObject({
        bootstrap: {
          roleCode: 'TEAM_LEADER',
        },
      });
      expect(
        await db.collection('project_memberships').countDocuments({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
          status: 'ACTIVE',
        }),
      ).toBe(1);
      expect(
        await db.collection('role_assignments').countDocuments({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
          roleCode: 'TEAM_LEADER',
        }),
      ).toBe(1);
      expect(
        await db.collection('role_assignments').countDocuments({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
        }),
      ).toBe(1);
      expect(
        await db.collection('role_assignments').countDocuments({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
          roleCode: 'MEMBER',
        }),
      ).toBe(0);
      expect(
        await db.collection('teams').countDocuments({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
        }),
      ).toBe(0);
      const headers = { Authorization: 'Bearer valid' };
      const visibleProjects = await request(app.getHttpServer() as App)
        .get('/api/v1/iam/projects')
        .set(headers)
        .expect(200);
      const visibleProjectsBody: unknown = visibleProjects.body;
      if (!isProjectListResponse(visibleProjectsBody))
        throw new Error('List Projects response is invalid');
      expect(visibleProjectsBody.data.map((project) => project.id)).toEqual([
        first.id,
      ]);
      const detail = await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${first.id}`)
        .set(headers)
        .expect(200);
      const detailBody: unknown = detail.body;
      expect(detailBody).toMatchObject({ id: first.id, organizationId: orgA });

      // Test-only audit constraint forces the second audit write to fail.
      await auditDb
        .collection('audit_logs_iam')
        .createIndex({ action: 1 }, { unique: true });
      await expect(
        repository.create(orgA, user, { name: 'Rolled back', code: 'NEW' }),
      ).rejects.toMatchObject({ code: 11000 });
      expect(await db.collection('projects').countDocuments()).toBe(1);
      expect(
        await db.collection('projects').countDocuments({ code: 'NEW' }),
      ).toBe(0);
      expect(await db.collection('project_memberships').countDocuments()).toBe(
        1,
      );
      expect(await db.collection('role_assignments').countDocuments()).toBe(1);
      expect(await db.collection('teams').countDocuments()).toBe(0);
      expect(await auditDb.collection('audit_logs_iam').countDocuments()).toBe(
        1,
      );
      await auditDb.collection('audit_logs_iam').dropIndex('action_1');

      await expect(
        repository.create(orgA, user, { name: 'Duplicate', code: 'EX' }),
      ).rejects.toMatchObject({ status: 409 });
      const second = await repository.create(orgB, user, {
        name: 'Other Org',
        code: 'EX',
      });
      expect(second.organizationId).toBe(orgB);
      expect(await db.collection('projects').countDocuments()).toBe(2);
      expect(await db.collection('project_memberships').countDocuments()).toBe(
        2,
      );
      expect(await db.collection('role_assignments').countDocuments()).toBe(2);
      expect(await db.collection('teams').countDocuments()).toBe(0);
      expect(await auditDb.collection('audit_logs_iam').countDocuments()).toBe(
        2,
      );

      const publicReaderId = new Types.ObjectId();
      const externalReaderId = new Types.ObjectId();
      const inactiveReaderId = new Types.ObjectId();
      const crossOrganizationReaderId = new Types.ObjectId();
      await db.collection('organization_memberships').insertMany([
        {
          organizationId: new Types.ObjectId(orgA),
          userId: publicReaderId,
          status: 'ACTIVE',
        },
        {
          organizationId: new Types.ObjectId(orgA),
          userId: inactiveReaderId,
          status: 'SUSPENDED',
        },
        {
          organizationId: new Types.ObjectId(orgB),
          userId: crossOrganizationReaderId,
          status: 'ACTIVE',
        },
      ]);

      const publicProjectId = new Types.ObjectId();
      const projectTimestamp = new Date();
      await db.collection('projects').insertOne({
        _id: publicProjectId,
        organizationId: new Types.ObjectId(orgA),
        name: 'Public project',
        code: 'PUB',
        description: 'Metadata only',
        visibility: 'PUBLIC',
        status: 'ACTIVE',
        createdBy: new Types.ObjectId(user),
        createdAt: projectTimestamp,
        updatedAt: projectTimestamp,
      });
      const unrelatedProjectId = new Types.ObjectId();
      await db.collection('projects').insertOne({
        _id: unrelatedProjectId,
        organizationId: new Types.ObjectId(orgA),
        name: 'Unrelated private project',
        code: 'OTHER',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: new Types.ObjectId(user),
        createdAt: projectTimestamp,
        updatedAt: projectTimestamp,
      });
      const creatorRoleAssignment = await db
        .collection('role_assignments')
        .findOne({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
          roleCode: 'TEAM_LEADER',
        });
      if (!creatorRoleAssignment)
        throw new Error('Creator TEAM_LEADER RoleAssignment missing');
      await db.collection('project_memberships').insertOne({
        organizationId: new Types.ObjectId(orgA),
        projectId: unrelatedProjectId,
        userId: publicReaderId,
        status: 'ACTIVE',
      });
      await db.collection('role_assignments').insertOne({
        organizationId: new Types.ObjectId(orgA),
        projectId: unrelatedProjectId,
        userId: publicReaderId,
        roleId: creatorRoleAssignment.roleId,
        roleCode: 'TEAM_LEADER',
        assignedBy: new Types.ObjectId(user),
      });

      currentIdentity = {
        ...identity,
        id: publicReaderId.toString(),
        email: 'public-reader@example.test',
        roles: [],
      };
      const publicList = await request(app.getHttpServer() as App)
        .get('/api/v1/iam/projects')
        .set(headers)
        .expect(200);
      const publicListBody: unknown = publicList.body;
      if (!isProjectListResponse(publicListBody))
        throw new Error('Public Project list response is invalid');
      expect(publicListBody.data.map((project) => project.id).sort()).toEqual(
        [publicProjectId.toString(), unrelatedProjectId.toString()].sort(),
      );

      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${first.id}`)
        .set(headers)
        .expect(404);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${unrelatedProjectId.toString()}`)
        .set(headers)
        .expect(200);
      const publicDetail = await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(200);
      const publicDetailBody: unknown = publicDetail.body;
      if (!isProjectMetadataResponse(publicDetailBody))
        throw new Error('Public Project detail response is invalid');
      expect(publicDetailBody).toMatchObject({
        id: publicProjectId.toString(),
        organizationId: orgA,
        name: 'Public project',
        visibility: 'PUBLIC',
      });
      expect(Object.keys(publicDetailBody).sort()).toEqual([
        'code',
        'createdAt',
        'createdBy',
        'description',
        'id',
        'name',
        'organizationId',
        'status',
        'updatedAt',
        'visibility',
      ]);

      currentIdentity = {
        ...identity,
        id: externalReaderId.toString(),
        email: 'external-reader@example.test',
        roles: [],
      };
      const externalList = await request(app.getHttpServer() as App)
        .get('/api/v1/iam/projects')
        .set(headers)
        .expect(200);
      const externalListBody: unknown = externalList.body;
      if (!isProjectListResponse(externalListBody))
        throw new Error('External Project list response is invalid');
      expect(externalListBody.data).toEqual([]);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(404);

      currentIdentity = {
        ...identity,
        id: inactiveReaderId.toString(),
        email: 'inactive-reader@example.test',
        roles: [],
      };
      const inactiveList = await request(app.getHttpServer() as App)
        .get('/api/v1/iam/projects')
        .set(headers)
        .expect(200);
      const inactiveListBody: unknown = inactiveList.body;
      if (!isProjectListResponse(inactiveListBody))
        throw new Error('Inactive Project list response is invalid');
      expect(inactiveListBody.data).toEqual([]);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(404);

      currentIdentity = {
        ...identity,
        id: crossOrganizationReaderId.toString(),
        organizationId: orgB,
        email: 'cross-organization-reader@example.test',
        roles: [],
      };
      const crossOrganizationList = await request(app.getHttpServer() as App)
        .get('/api/v1/iam/projects')
        .set(headers)
        .expect(200);
      const crossOrganizationListBody: unknown = crossOrganizationList.body;
      if (!isProjectListResponse(crossOrganizationListBody))
        throw new Error('Cross-organization Project list response is invalid');
      expect(crossOrganizationListBody.data).toEqual([]);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(404);

      currentIdentity = identity;
      const leaderRole = await db.collection('roles').findOne({
        code: 'TEAM_LEADER',
      });
      if (!leaderRole) throw new Error('Provisioned TEAM_LEADER Role missing');
      const permissionRevoked = await db
        .collection('roles')
        .updateOne({ _id: leaderRole._id }, { $set: { permissions: [] } });
      expect(permissionRevoked.modifiedCount).toBe(1);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${first.id}`)
        .set(headers)
        .expect(404);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(200);

      await db
        .collection('roles')
        .updateOne(
          { _id: leaderRole._id },
          { $set: { permissions: ['project.read'] } },
        );
      const creatorMembership = await db
        .collection('project_memberships')
        .findOne({
          organizationId: new Types.ObjectId(orgA),
          projectId: new Types.ObjectId(first.id),
          userId: new Types.ObjectId(user),
          status: 'ACTIVE',
        });
      if (!creatorMembership)
        throw new Error('Creator ProjectMembership missing');
      const membershipRevoked = await db
        .collection('project_memberships')
        .updateOne(
          { _id: creatorMembership._id, status: 'ACTIVE' },
          { $set: { status: 'INACTIVE' } },
        );
      expect(membershipRevoked.modifiedCount).toBe(1);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${first.id}`)
        .set(headers)
        .expect(404);
      await request(app.getHttpServer() as App)
        .get(`/api/v1/iam/projects/${publicProjectId.toString()}`)
        .set(headers)
        .expect(200);
    } finally {
      await app?.close();
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
