import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type ClientSession, type Connection } from 'mongoose';
import type { Document } from 'mongodb';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TeamAuthorizationPolicy } from '../../application/teams/team-authorization.policy';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoTeamFoundationRepository } from './team-foundation.repository';

const integration =
  process.env.TEAM_FOUNDATION_MONGODB_INTEGRATION === 'true'
    ? describe
    : describe.skip;

const mongoVersion = '7.0.45';
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

interface DisposableFixtureMarker extends Document {
  _id: string;
}

integration(
  'Team repository read scope and closed mutation gate on disposable MongoDB 7 replica set',
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
      delete (repository as unknown as { ensureMutationReady?: unknown })
        .ensureMutationReady;
      for (const name of iamCollectionNames)
        await iam().collection(name).deleteMany({});
      const operationCollection = await iam()
        .listCollections({ name: 'team_operations' })
        .toArray();
      if (operationCollection.length > 0)
        await iam().dropCollection('team_operations');
      await seedAuthorization();
    }

    async function enableIsolatedIdempotencyMutationTest(
      includeTtlIndex = true,
    ) {
      const operations = await iam().createCollection('team_operations');
      await operations.createIndex(
        { organizationId: 1, actorUserId: 1, keyHash: 1 },
        { name: 'test_operation_key', unique: true },
      );
      if (includeTtlIndex)
        await operations.createIndex(
          { expiresAt: 1 },
          { name: 'test_operation_expiry', expireAfterSeconds: 0 },
        );
      (
        repository as unknown as {
          ensureMutationReady: () => Promise<unknown>;
        }
      ).ensureMutationReady = jest.fn().mockResolvedValue({ operations });
      return operations;
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
        await connection.close();
      }
      await replicaSet?.stop();
    });

    beforeEach(async () => resetData());

    it('keeps repeated and concurrent mutations fail-closed until evidence is approved', async () => {
      const operations = await iam().createCollection('team_operations');
      await operations.createIndex(
        { organizationId: 1, actorUserId: 1, keyHash: 1 },
        { name: 'test_operation_key', unique: true },
      );
      await operations.createIndex(
        { expiresAt: 1 },
        { name: 'test_operation_expiry', expireAfterSeconds: 0 },
      );

      await expect(createTeam('repeat-key')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(createTeam('repeat-key')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const concurrent = await Promise.allSettled([
        createTeam('concurrent-key'),
        createTeam('concurrent-key'),
      ]);

      expect(concurrent.every((result) => result.status === 'rejected')).toBe(
        true,
      );
      expect(
        concurrent.every(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof ServiceUnavailableException,
        ),
      ).toBe(true);
      expect(await iam().collection('teams').countDocuments({})).toBe(0);
      expect(
        await iam().listCollections({ name: 'team_operations' }).toArray(),
      ).toHaveLength(1);
      expect(await operations.countDocuments({})).toBe(0);
    });

    it('replays an identical command and rejects key reuse with a changed payload', async () => {
      await enableIsolatedIdempotencyMutationTest();
      const key = `repeat-${randomUUID()}`;
      const first = await createTeam(key);
      const replay = await createTeam(key);

      expect(first.statusCode).toBe(201);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.team).toEqual(first.team);

      const reusedKey = await createTeam(key, {
        name: 'Quality',
        code: 'QA',
        description: 'different payload',
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(reusedKey).toBeInstanceOf(ConflictException);
      expect((reusedKey as ConflictException).getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      expect(await iam().collection('team_operations').countDocuments({})).toBe(
        1,
      );
    });

    it('serializes concurrent requests for one absent idempotency slot', async () => {
      await enableIsolatedIdempotencyMutationTest();
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
    });

    it('replaces an expired committed idempotency slot with compare-and-set', async () => {
      const operations = await enableIsolatedIdempotencyMutationTest(false);
      const key = `expired-${randomUUID()}`;
      await createTeam(key);

      const original = await operations.findOne({
        organizationId,
        actorUserId,
      });
      if (!original)
        throw new Error('Committed idempotency slot was not stored');
      if (typeof original.commandId !== 'string')
        throw new Error('Committed idempotency slot has no command ID');
      const originalCommandId = original.commandId;
      await operations.updateOne(
        { _id: original._id },
        { $set: { expiresAt: new Date(Date.now() - 1_000) } },
      );

      const replacement = await createTeam(key, {
        name: 'Quality',
        code: 'QA',
        description: null,
      });
      const stored = await operations.findOne({ _id: original._id });

      expect(replacement.replayed).toBe(false);
      expect(replacement.team.name).toBe('Quality');
      expect(stored?.status).toBe('COMMITTED');
      expect(stored?.commandId).not.toBe(originalCommandId);
      expect(await iam().collection('teams').countDocuments({})).toBe(2);
      expect(await operations.countDocuments({})).toBe(1);
    });

    it('rolls back Team and idempotency slot when command-result persistence fails', async () => {
      const operations = await enableIsolatedIdempotencyMutationTest();
      const updateResult = jest
        .spyOn(operations, 'updateOne')
        .mockRejectedValueOnce(
          new Error('Simulated command-result write failure'),
        );

      try {
        await expect(
          createTeam(`result-failure-${randomUUID()}`),
        ).rejects.toThrow('Simulated command-result write failure');
      } finally {
        updateResult.mockRestore();
      }

      expect(await iam().collection('teams').countDocuments({})).toBe(0);
      expect(await operations.countDocuments({})).toBe(0);
    });

    it('rolls back the command-result slot when the Team write conflicts', async () => {
      await enableIsolatedIdempotencyMutationTest();
      await createTeam('first-code-key');

      await expect(createTeam('duplicate-code-key')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(await iam().collection('teams').countDocuments({})).toBe(1);
      expect(await iam().collection('team_operations').countDocuments({})).toBe(
        1,
      );
    });

    it('replays after an unknown commit acknowledgement on the isolated replica set', async () => {
      await enableIsolatedIdempotencyMutationTest();
      const key = `ambiguous-${randomUUID()}`;
      const startSession = connection!.startSession.bind(connection);
      const startSessionSpy = jest
        .spyOn(connection!, 'startSession')
        .mockImplementation(async (...args) => {
          const session = await startSession(...args);
          const withTransaction = session.withTransaction.bind(session);
          Object.defineProperty(session, 'withTransaction', {
            configurable: true,
            value: async (
              ...transactionArgs: Parameters<ClientSession['withTransaction']>
            ) => {
              await withTransaction(...transactionArgs);
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
        expect(failure).toBeInstanceOf(ServiceUnavailableException);
        expect((failure as ServiceUnavailableException).getStatus()).toBe(503);
        expect(
          (failure as ServiceUnavailableException).getResponse(),
        ).toMatchObject({ code: 'RETRY_LATER' });
        expect(await iam().collection('teams').countDocuments({})).toBe(1);
        const committedSlot = await iam()
          .collection('team_operations')
          .findOne({ organizationId, actorUserId });
        expect(committedSlot?.status).toBe('COMMITTED');
        expect(
          await iam().collection('team_operations').countDocuments({}),
        ).toBe(1);
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
    });

    it('scopes Manager list and detail reads to the Project and denies Member reads without Team proof', async () => {
      const archivedTeamId = new Types.ObjectId();
      const activeTeamId = new Types.ObjectId();
      const foreignTeamId = new Types.ObjectId();
      const createdAt = new Date('2026-10-15T00:00:00.000Z');
      const updatedAt = new Date('2026-10-15T01:00:00.000Z');
      await iam()
        .collection('teams')
        .insertMany([
          {
            _id: archivedTeamId,
            organizationId,
            projectId,
            name: 'Operations',
            code: 'OPS',
            description: 'internal detail',
            status: 'ARCHIVED',
            version: 2,
            createdAt,
            updatedAt,
            archivedAt: updatedAt,
            archivedBy: actorUserId,
            archivedReason: 'Completed',
          },
          {
            _id: activeTeamId,
            organizationId,
            projectId,
            name: 'Quality',
            code: 'QA',
            description: null,
            status: 'ACTIVE',
            version: 1,
            createdAt: new Date(createdAt.getTime() + 1),
            updatedAt: createdAt,
            archivedAt: null,
            archivedBy: null,
            archivedReason: null,
          },
          {
            _id: foreignTeamId,
            organizationId: new Types.ObjectId(),
            projectId: new Types.ObjectId(),
            name: 'Out of scope',
            code: 'OUT',
            description: null,
            status: 'ACTIVE',
            version: 1,
            createdAt,
            updatedAt,
            archivedAt: null,
            archivedBy: null,
            archivedReason: null,
          },
        ]);

      const archivedTeam = archivedTeamId.toHexString();
      const activeTeam = activeTeamId.toHexString();
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
      ]).toEqual(expect.arrayContaining([archivedTeam, activeTeam]));
      expect(
        [...firstPage.data, ...secondPage.data].some(
          (row) => row.id === foreignTeamId.toHexString(),
        ),
      ).toBe(false);
      expect(archivedPage.data.map((row) => row.id)).toEqual([archivedTeam]);
      expect(
        await repository.get(
          organizationId.toHexString(),
          actorUserId.toHexString(),
          archivedTeam,
        ),
      ).toMatchObject({
        id: archivedTeam,
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
          archivedTeam,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  },
);
