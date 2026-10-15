import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type ClientSession, type Connection } from 'mongoose';
import type { Document } from 'mongodb';
import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoTeamFoundationRepository } from './team-foundation.repository';

const integration =
  process.env.TEAM_FOUNDATION_MONGODB_INTEGRATION === 'true'
    ? describe
    : describe.skip;

const mongoVersion = '7.0.45';
const teamAuditIndexName = 'team_audit_idempotency';
const disposableReplicaSetMarker = 'datn90-team-foundation-mongo7-disposable';

function disposableReplicaSetUri(): string | undefined {
  const value = process.env.TEAM_FOUNDATION_TEST_MONGODB_URI;
  if (value === undefined) return undefined;
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('Team integration fixture URI is invalid');
  }
  if (
    uri.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.port !== '27017' ||
    uri.username !== '' ||
    uri.password !== '' ||
    uri.pathname !== '/' ||
    uri.searchParams.get('replicaSet') !== 'rs0'
  )
    throw new Error(
      'Team integration fixture must use the local disposable replica set',
    );
  return value;
}

interface TeamAuditEvent extends Document {
  action: string;
  targetResource: string;
  targetResourceId: string;
  metadata: {
    teamId: string;
    commandId: string;
    oldVersion: number | null;
    newVersion: number;
    changedFields: string[];
  };
}

interface TeamOperationRecord extends Document {
  commandId: string;
}

interface DisposableFixtureMarker extends Document {
  _id: string;
}

integration(
  'Team repository transactions on disposable MongoDB 7 replica set',
  () => {
    jest.setTimeout(300_000);

    const databaseName = `datn90team_${randomUUID().replaceAll('-', '')}`;
    const organizationId = new Types.ObjectId();
    const actorUserId = new Types.ObjectId();
    const projectId = new Types.ObjectId();
    const organizationMembershipId = new Types.ObjectId();
    const projectMembershipId = new Types.ObjectId();
    const roleId = new Types.ObjectId();
    const roleAssignmentId = new Types.ObjectId();

    let replicaSet: MongoMemoryReplSet | undefined;
    let connection: Connection | undefined;
    let repository: MongoTeamFoundationRepository;

    const iamCollectionNames = [
      'users',
      'organization_memberships',
      'projects',
      'project_memberships',
      'role_assignments',
      'roles',
      'teams',
    ];

    function iam() {
      if (!connection?.db) throw new Error('IAM test database is unavailable');
      return connection.db;
    }

    function audit() {
      const db = connection?.useDb(AUDIT_DATABASE_NAME, { useCache: true }).db;
      if (!db) throw new Error('Audit test database is unavailable');
      return db.collection<TeamAuditEvent>(IAM_AUDIT_COLLECTION_NAME);
    }

    async function provisionMutationPrerequisites() {
      const db = iam();
      await db.createCollection('team_operations');
      const operations = db.collection('team_operations');
      await operations.createIndex(
        { organizationId: 1, actorUserId: 1, keyHash: 1 },
        { name: 'team_operation_key', unique: true },
      );
      await operations.createIndex(
        { expiresAt: 1 },
        { name: 'team_operation_expiry', expireAfterSeconds: 0 },
      );

      const auditDb = connection!.useDb(AUDIT_DATABASE_NAME, {
        useCache: true,
      }).db!;
      await auditDb.createCollection(IAM_AUDIT_COLLECTION_NAME);
      await auditDb.collection(IAM_AUDIT_COLLECTION_NAME).createIndex(
        {
          organizationId: 1,
          'metadata.commandId': 1,
          action: 1,
          targetResourceId: 1,
        },
        {
          name: teamAuditIndexName,
          unique: true,
          partialFilterExpression: {
            targetResource: 'TEAM',
            'metadata.commandId': { $exists: true },
          },
        },
      );
    }

    async function seedAuthorization() {
      const db = iam();
      await db.collection('users').insertOne({
        _id: actorUserId,
        email: `${actorUserId.toHexString()}@example.test`,
        fullName: 'Team Leader Test',
        passwordHash: 'not-a-real-secret',
        status: 'ACTIVE',
      });
      await db.collection('organization_memberships').insertOne({
        _id: organizationMembershipId,
        organizationId,
        userId: actorUserId,
        status: 'ACTIVE',
        version: 1,
        mutationFence: 0,
      });
      await db.collection('projects').insertOne({
        _id: projectId,
        organizationId,
        name: 'Project Test',
        code: `P${projectId.toHexString().slice(0, 7).toUpperCase()}`,
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: actorUserId,
      });
      await db.collection('project_memberships').insertOne({
        _id: projectMembershipId,
        organizationId,
        projectId,
        userId: actorUserId,
        status: 'ACTIVE',
        joinedAt: new Date(),
      });
      await db.collection('roles').insertOne({
        _id: roleId,
        code: 'TEAM_LEADER',
        name: 'Team Leader Test',
        permissions: ['team.read', 'team:children.manage'],
        isSystem: true,
      });
      await db.collection('role_assignments').insertOne({
        _id: roleAssignmentId,
        organizationId,
        projectId,
        userId: actorUserId,
        roleId,
        roleCode: 'TEAM_LEADER',
        assignedBy: actorUserId,
      });
    }

    async function resetData() {
      for (const name of iamCollectionNames)
        await iam().collection(name).deleteMany({});
      await iam().collection('team_operations').deleteMany({});
      await audit().deleteMany({});
      await seedAuthorization();
    }

    async function createTeam(
      key = `create-${randomUUID()}`,
      input: { name: string; code: string; description: string | null } = {
        name: 'Operations',
        code: 'OPS',
        description: 'internal detail',
      },
    ) {
      return repository.create(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        projectId.toHexString(),
        input,
        key,
      );
    }

    beforeAll(async () => {
      const fixtureUri = disposableReplicaSetUri();
      if (!fixtureUri) {
        replicaSet = await MongoMemoryReplSet.create({
          binary: { version: mongoVersion },
          instanceOpts: [
            {
              args: ['--setParameter', 'enableTestCommands=1'],
            },
          ],
          replSet: {
            count: 1,
            name: 'team-foundation-test-rs',
            storageEngine: 'wiredTiger',
          },
        });
      }
      connection = mongoose.createConnection(
        fixtureUri ?? replicaSet!.getUri(),
        {
          dbName: databaseName,
          autoIndex: false,
          serverSelectionTimeoutMS: 10_000,
        },
      );
      await connection.asPromise();

      const hello = await iam().admin().command({ hello: 1 });
      const build = await iam().admin().command({ buildInfo: 1 });
      if (!hello.setName || !String(build.version).startsWith('7.'))
        throw new Error(
          'Team transaction test requires a MongoDB 7 replica set',
        );
      if (fixtureUri) {
        const adminDb = connection.useDb('admin', { useCache: true }).db;
        if (!adminDb) throw new Error('MongoDB fixture admin database missing');
        const marker = await adminDb
          .collection<DisposableFixtureMarker>('datn_migration_test_fixture')
          .findOne({ _id: disposableReplicaSetMarker });
        if (!marker)
          throw new Error('Team integration fixture marker is missing');
      }

      for (const name of iamCollectionNames) {
        const definition = IAM_PERSISTENCE.collections.find(
          (item) => item.name === name,
        );
        if (!definition)
          throw new Error(`IAM persistence definition missing: ${name}`);
        const modelName = `${IAM_PERSISTENCE.databaseName}_${name}`;
        const model = connection.model(
          modelName,
          createCollectionSchema(definition),
          name,
        );
        await model.createCollection();
        await model.createIndexes();
      }
      await provisionMutationPrerequisites();
      repository = new MongoTeamFoundationRepository(
        new TeamAuthorizationPolicy(),
        connection,
      );
      await resetData();
    }, 300_000);

    afterAll(async () => {
      if (connection?.readyState === mongoose.ConnectionStates.connected) {
        if (!/^datn90team_[a-f\d]{32}$/.test(databaseName))
          throw new Error('Team integration fixture database identity changed');
        await connection.dropDatabase();
        await connection
          .useDb(AUDIT_DATABASE_NAME)
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .deleteMany({ organizationId: organizationId.toHexString() });
        await connection.close();
      }
      await replicaSet?.stop();
    });

    beforeEach(async () => resetData());

    it('commits Team, idempotency result, and canonical audit event together; retry replays once', async () => {
      const key = `create-${randomUUID()}`;
      const first = await createTeam(key);
      const replay = await createTeam(key);

      expect(first.statusCode).toBe(201);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.team).toEqual(first.team);
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      expect(await iam().collection('team_operations').countDocuments({})).toBe(
        1,
      );

      const events = await audit()
        .find({
          organizationId: organizationId.toHexString(),
          targetResourceId: first.team.id,
        })
        .toArray();
      const operation = await iam()
        .collection<TeamOperationRecord>('team_operations')
        .findOne({ organizationId, actorUserId });
      expect(events).toHaveLength(1);
      expect(events[0].metadata.commandId).toBe(operation?.commandId);
      expect(events[0]).toMatchObject({
        action: 'team.create',
        targetResource: 'TEAM',
        targetResourceId: first.team.id,
        metadata: {
          teamId: first.team.id,
          oldVersion: null,
          newVersion: 1,
          changedFields: ['name', 'code', 'description', 'status'],
        },
      });
      expect(events[0].metadata).not.toHaveProperty('beforeName');
      expect(events[0].metadata).not.toHaveProperty('afterName');
      expect(events[0].metadata).not.toHaveProperty('description');
    });

    it('serializes concurrent requests for an absent idempotency slot', async () => {
      const key = `concurrent-${randomUUID()}`;
      const [left, right] = await Promise.all([
        createTeam(key),
        createTeam(key),
      ]);

      expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
      expect(left.team).toEqual(right.team);
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      expect(await iam().collection('team_operations').countDocuments({})).toBe(
        1,
      );
      expect(
        await audit().countDocuments({
          organizationId: organizationId.toHexString(),
        }),
      ).toBe(1);
    });

    it('writes update, archive, and restore with versioned audit events in one session per command', async () => {
      const created = await createTeam();
      const updated = await repository.update(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        created.team.id,
        { name: 'Operations North', description: 'changed detail' },
        `update-${randomUUID()}`,
        created.etag,
      );
      const archived = await repository.archive(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        created.team.id,
        'Completed',
        `archive-${randomUUID()}`,
        updated.etag,
      );
      const restored = await repository.restore(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        created.team.id,
        'Reopened',
        `restore-${randomUUID()}`,
        archived.etag,
      );

      expect([
        created.team.version,
        updated.team.version,
        archived.team.version,
        restored.team.version,
      ]).toEqual([1, 2, 3, 4]);
      expect(restored.team.status).toBe('ACTIVE');
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      const events = await audit()
        .find({
          organizationId: organizationId.toHexString(),
          targetResourceId: created.team.id,
        })
        .sort({ _id: 1 })
        .toArray();
      expect(events.map((event) => event.action)).toEqual([
        'team.create',
        'team.update',
        'team.archive',
        'team.restore',
      ]);
      expect(events.map((event) => event.metadata.newVersion)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(events[1].metadata.changedFields).toEqual(['name', 'description']);
      expect(events[2].metadata.changedFields).toEqual([
        'status',
        'archivedAt',
        'archivedBy',
        'archivedReason',
      ]);
      expect(events[2].metadata).not.toHaveProperty('reason');
    });

    it('scopes Manager list and detail reads to the Project and denies Member reads without Team proof', async () => {
      const archived = await createTeam();
      const active = await createTeam(`create-${randomUUID()}`, {
        name: 'Quality',
        code: 'QA',
        description: null,
      });
      await repository.archive(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        archived.team.id,
        'Completed',
        `archive-${randomUUID()}`,
        archived.etag,
      );

      const foreignTeamId = new Types.ObjectId();
      await iam().collection('teams').insertOne({
        _id: foreignTeamId,
        organizationId: new Types.ObjectId(),
        projectId: new Types.ObjectId(),
        name: 'Out of scope',
        code: 'OUT',
        description: null,
        status: 'ACTIVE',
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        archivedAt: null,
        archivedBy: null,
        archivedReason: null,
      });

      const firstPage = await repository.list(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        projectId.toHexString(),
        { page: 1, pageSize: 1, status: 'ALL' },
      );
      const secondPage = await repository.list(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        projectId.toHexString(),
        { page: 2, pageSize: 1, status: 'ALL' },
      );
      const archivedPage = await repository.list(
        organizationId.toHexString(),
        actorUserId.toHexString(),
        projectId.toHexString(),
        { page: 1, pageSize: 20, status: 'ARCHIVED' },
      );

      expect(firstPage.pagination).toMatchObject({
        page: 1,
        pageSize: 1,
        totalItems: 2,
        totalPages: 2,
      });
      expect(secondPage.data).toHaveLength(1);
      expect([
        ...firstPage.data.map((row) => row.id),
        ...secondPage.data.map((row) => row.id),
      ]).toEqual(expect.arrayContaining([archived.team.id, active.team.id]));
      expect(
        [...firstPage.data, ...secondPage.data].some(
          (row) => row.id === foreignTeamId.toHexString(),
        ),
      ).toBe(false);
      expect(archivedPage.data.map((row) => row.id)).toEqual([
        archived.team.id,
      ]);
      expect(
        await repository.get(
          organizationId.toHexString(),
          actorUserId.toHexString(),
          archived.team.id,
        ),
      ).toMatchObject({
        id: archived.team.id,
        status: 'ARCHIVED',
        version: 2,
      });

      await iam()
        .collection('roles')
        .updateOne(
          { _id: roleId },
          { $set: { code: 'MEMBER', permissions: ['team.read'] } },
        );
      await iam()
        .collection('role_assignments')
        .updateOne({ _id: roleAssignmentId }, { $set: { roleCode: 'MEMBER' } });
      await expect(
        repository.list(
          organizationId.toHexString(),
          actorUserId.toHexString(),
          projectId.toHexString(),
          { page: 1, pageSize: 20, status: 'ALL' },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        repository.get(
          organizationId.toHexString(),
          actorUserId.toHexString(),
          archived.team.id,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('replays a committed command after an unknown commit acknowledgement', async () => {
      const key = `ambiguous-${randomUUID()}`;
      const startSession = connection!.startSession.bind(connection);
      const startSessionSpy = jest
        .spyOn(connection!, 'startSession')
        .mockImplementation(async (...args) => {
          const session = await startSession(...args);
          const commit = session.withTransaction.bind(session);
          Object.defineProperty(session, 'withTransaction', {
            configurable: true,
            value: async (
              ...transactionArgs: Parameters<ClientSession['withTransaction']>
            ) => {
              await commit(...transactionArgs);
              const error = new Error(
                'Simulated lost acknowledgement after transaction commit',
              ) as Error & { errorLabels: string[] };
              error.errorLabels = ['UnknownTransactionCommitResult'];
              throw error;
            },
          });
          return session;
        });

      try {
        const failure = await createTeam(key).then(
          () => undefined,
          (error: unknown) => error,
        );
        if (!(failure instanceof ServiceUnavailableException)) throw failure;
        expect(failure.getStatus()).toBe(503);
        expect(failure.getResponse()).toMatchObject({ code: 'RETRY_LATER' });
      } finally {
        startSessionSpy.mockRestore();
      }

      const replay = await createTeam(key);
      expect(replay.statusCode).toBe(201);
      expect(replay.replayed).toBe(true);
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      expect(await iam().collection('team_operations').countDocuments({})).toBe(
        1,
      );
      expect(
        await audit().countDocuments({
          organizationId: organizationId.toHexString(),
        }),
      ).toBe(1);
    });

    it('rolls back Team, operation, and authorization fences when audit insert fails', async () => {
      await connection!.useDb(AUDIT_DATABASE_NAME).db!.command({
        collMod: IAM_AUDIT_COLLECTION_NAME,
        validator: { action: 'reject-team-create' },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      try {
        await expect(createTeam()).rejects.toMatchObject({ code: 121 });
        expect(await iam().collection('teams').countDocuments({})).toBe(0);
        expect(
          await iam().collection('team_operations').countDocuments({}),
        ).toBe(0);
        const fencedRows: Array<[string, Types.ObjectId]> = [
          ['users', actorUserId],
          ['organization_memberships', organizationMembershipId],
          ['projects', projectId],
          ['project_memberships', projectMembershipId],
          ['role_assignments', roleAssignmentId],
          ['roles', roleId],
        ];
        for (const [collection, id] of fencedRows) {
          expect(
            await iam().collection(collection).findOne({ _id: id }),
          ).not.toHaveProperty('__v');
        }
      } finally {
        await connection!.useDb(AUDIT_DATABASE_NAME).db!.command({
          collMod: IAM_AUDIT_COLLECTION_NAME,
          validator: {},
          validationLevel: 'strict',
          validationAction: 'error',
        });
      }
    });

    it('fails closed when the Team audit dedupe index is missing', async () => {
      await audit().dropIndex(teamAuditIndexName);
      try {
        await expect(createTeam()).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
        expect(await iam().collection('teams').countDocuments({})).toBe(0);
        expect(
          await iam().collection('team_operations').countDocuments({}),
        ).toBe(0);
        expect(
          await audit().countDocuments({
            organizationId: organizationId.toHexString(),
          }),
        ).toBe(0);
      } finally {
        await audit().createIndex(
          {
            organizationId: 1,
            'metadata.commandId': 1,
            action: 1,
            targetResourceId: 1,
          },
          {
            name: teamAuditIndexName,
            unique: true,
            partialFilterExpression: {
              targetResource: 'TEAM',
              'metadata.commandId': { $exists: true },
            },
          },
        );
      }
    });
  },
);
