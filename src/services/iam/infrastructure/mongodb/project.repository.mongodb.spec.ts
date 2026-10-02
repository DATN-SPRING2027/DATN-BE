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

integration('MongoProjectRepository transaction and unique index', () => {
  it('bootstraps creator access, reads the Private Project, rolls back failures, and scopes codes by Organization', async () => {
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
        code: 'MEMBER',
        name: 'Member',
        permissions: ['project.read'],
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
              getCurrentIdentity: jest.fn().mockResolvedValue(identity),
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
          roleCode: 'MEMBER',
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
          roleCode: 'MEMBER',
        }),
      ).toBe(1);
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
      expect(await auditDb.collection('audit_logs_iam').countDocuments()).toBe(
        2,
      );
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
