import { randomUUID } from 'node:crypto';
import mongoose, { Types, type Connection } from 'mongoose';
import { SERVICE_DATABASES } from '../../../../common/mongodb/database-names';
import {
  TASK_COLLECTION,
  TASK_DATABASE_NAME,
  TASK_EVENT_COLLECTION,
  type TaskCreationEventDocument,
  type TaskDocument,
} from './task-contract';
import {
  TASK_DISPOSABLE_FIXTURE_MARKER,
  initializeTaskDisposableDatabase,
} from './initialize-task-disposable-database';
import { TaskDataRepository } from './task-data.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;
const MAX_PAGE_SIZE = 100;

integration(
  'D-03 Task data foundation on a marked MongoDB 7 replica set',
  () => {
    const databaseName = `datn95task_${randomUUID().replaceAll('-', '')}`;
    const projectId = new Types.ObjectId();
    const otherProjectId = new Types.ObjectId();
    const actorId = new Types.ObjectId();
    let connection: Connection | undefined;
    let repository: TaskDataRepository;
    let restrictedConnection: Connection | undefined;
    let restrictedUser: string | undefined;

    function rawTask(overrides: Record<string, unknown> = {}) {
      const now = new Date('2026-10-14T00:00:00.000Z');
      return {
        _id: new Types.ObjectId(),
        projectId,
        title: 'fixture',
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
        version: 1,
        ...overrides,
      };
    }

    async function create(title: string, owner = projectId) {
      return repository.create(
        { projectId: owner, actorId, requestId: 'd03-test-01' },
        { title },
      );
    }

    async function counts() {
      return {
        tasks: await connection!
          .db!.collection(TASK_COLLECTION)
          .countDocuments(),
        events: await connection!
          .db!.collection(TASK_EVENT_COLLECTION)
          .countDocuments(),
      };
    }

    beforeAll(async () => {
      const uri = process.env.MONGODB_URI;
      if (
        !uri ||
        !/^mongodb:\/\/(?:[^@/]+@)?(?:127\.0\.0\.1|localhost):\d+\//.test(uri)
      )
        throw new Error(
          'D-03 integration requires an explicit loopback MongoDB fixture URI',
        );
      connection = mongoose.createConnection(uri, {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      });
      await connection.asPromise();
      const db = connection.db!;
      const hello = await db.admin().command({ hello: 1 });
      const build = await db.admin().command({ buildInfo: 1 });
      const marker = await db.client
        .db('admin')
        .collection<{ _id: string }>('datn_migration_test_fixture')
        .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
      if (!hello.setName || !String(build.version).startsWith('7.') || !marker)
        throw new Error(
          'D-03 requires its marked, disposable MongoDB 7 replica set',
        );
      await initializeTaskDisposableDatabase(db);
      await initializeTaskDisposableDatabase(db);
      repository = new TaskDataRepository(db);
    }, 30_000);

    afterEach(async () => {
      if (connection?.readyState === mongoose.ConnectionStates.connected) {
        await connection.db!.collection(TASK_COLLECTION).deleteMany({});
        await connection.db!.collection(TASK_EVENT_COLLECTION).deleteMany({});
      }
    });

    afterAll(async () => {
      await restrictedConnection?.close();
      if (restrictedUser && connection?.db) {
        await connection.db
          .command({ dropUser: restrictedUser })
          .catch(() => undefined);
      }
      if (connection?.readyState === mongoose.ConnectionStates.connected) {
        const marker = await connection
          .db!.client.db('admin')
          .collection<{ _id: string }>('datn_migration_test_fixture')
          .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
        if (
          connection.name !== databaseName ||
          !/^datn95task_[a-f\d]{32}$/.test(databaseName) ||
          !marker
        )
          throw new Error(
            'Refusing to drop a database without the D-03 fixture identity',
          );
        await connection.dropDatabase();
      }
      await connection?.close();
    });

    it('O1 repeats initialization and creates only the owned collections and indexes', async () => {
      const collections = await connection!
        .db!.listCollections({}, { nameOnly: true })
        .toArray();
      expect(collections.map(({ name }) => name).sort()).toEqual(
        [TASK_COLLECTION, TASK_EVENT_COLLECTION].sort(),
      );
      const taskIndexes = await connection!
        .db!.collection(TASK_COLLECTION)
        .indexes();
      const eventIndexes = await connection!
        .db!.collection(TASK_EVENT_COLLECTION)
        .indexes();
      expect(
        taskIndexes.map(({ name, key, unique }) => ({ name, key, unique })),
      ).toEqual([
        { name: '_id_', key: { _id: 1 }, unique: undefined },
        {
          name: 'task_project_cursor',
          key: { projectId: 1, _id: 1 },
          unique: undefined,
        },
      ]);
      expect(
        eventIndexes.map(({ name, key, unique }) => ({ name, key, unique })),
      ).toEqual([
        { name: '_id_', key: { _id: 1 }, unique: undefined },
        {
          name: 'task_event_task_version_unique',
          key: { taskId: 1, taskVersion: 1 },
          unique: true,
        },
      ]);
      expect(
        () => new TaskDataRepository(connection!.useDb('continuum_db').db!),
      ).toThrow('Task persistence database name is not permitted');
    });

    it('DATN-373 O0/O2 persists one Task and a creation event with required identity links', async () => {
      const result = await create('  Task name  ');
      expect(result.state).toBe('COMMITTED');
      if (result.state !== 'COMMITTED') return;
      expect(result.task.title).toBe('  Task name  ');
      expect(result.task.version).toBe(1);
      expect(result.task.updatedAt).toEqual(result.task.createdAt);
      expect(
        await repository.getById(String(projectId), String(result.task._id)),
      ).toEqual(result.task);
      const events = await repository.listHistory(
        String(projectId),
        String(result.task._id),
      );
      expect(events).toHaveLength(1);
      expect(events[0]._id).toBeInstanceOf(Types.ObjectId);
      expect(events[0].taskId).toEqual(result.task._id);
      expect(events[0].projectId).toEqual(result.task.projectId);
      expect(events[0]).toMatchObject({
        taskId: result.task._id,
        projectId,
        actorType: 'USER',
        actorId,
        source: 'HUMAN',
        taskVersion: 1,
        occurredAt: result.task.createdAt,
      });
      expect(events[0].operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(events[0].correlationId).toBe('d03-test-01');
    });

    it('O3 rejects missing, null, wrong-type, extra-field and spoofed caller data', async () => {
      const required = [
        '_id',
        'projectId',
        'title',
        'createdBy',
        'createdAt',
        'updatedAt',
        'version',
      ];
      for (const field of required) {
        const missing = rawTask();
        delete (missing as Record<string, unknown>)[field];
        if (field === '_id') {
          const generated = await connection!.db!.command({
            insert: TASK_COLLECTION,
            documents: [missing],
          });
          expect((generated as unknown as { n?: number }).n).toBe(1);
          continue;
        }
        const response = await connection!.db!.command({
          insert: TASK_COLLECTION,
          documents: [missing],
        });
        const writeErrors = response.writeErrors as unknown[] | undefined;
        const firstWriteError = writeErrors?.[0] as
          { code?: number } | undefined;
        expect(firstWriteError?.code).toBe(121);
        await expect(
          connection!
            .db!.collection(TASK_COLLECTION)
            .insertOne(rawTask({ [field]: null })),
        ).rejects.toMatchObject({ code: 121 });
      }
      await expect(
        connection!
          .db!.collection(TASK_COLLECTION)
          .insertOne(rawTask({ projectId: 'not-an-object-id' })),
      ).rejects.toMatchObject({ code: 121 });
      await expect(
        connection!
          .db!.collection(TASK_COLLECTION)
          .insertOne(rawTask({ unexpected: true })),
      ).rejects.toMatchObject({ code: 121 });
      const before = await counts();
      expect(
        await repository.create(
          { projectId, actorId },
          { title: 'spoof', createdBy: new Types.ObjectId() },
        ),
      ).toEqual({ state: 'REJECTED', reason: 'INVALID_INPUT' });
      expect(await counts()).toEqual(before);
    });

    it('O4 applies the approved title predicate at the database boundary without normalization', async () => {
      await expect(
        connection!
          .db!.collection(TASK_COLLECTION)
          .insertOne(rawTask({ title: ' \t\n' })),
      ).rejects.toMatchObject({ code: 121 });
      const zeroWidth = await create('\u200b');
      expect(zeroWidth.state).toBe('COMMITTED');
      const large = 'x'.repeat(50_000);
      const largeResult = await create(large);
      expect(largeResult.state).toBe('COMMITTED');
      if (largeResult.state === 'COMMITTED')
        expect(largeResult.task.title).toBe(large);
    });

    it('O5 allows duplicate titles and preserves existing rows when Task identity collides', async () => {
      const first = await create('same title');
      const second = await create('same title');
      expect(first.state).toBe('COMMITTED');
      expect(second.state).toBe('COMMITTED');
      if (first.state !== 'COMMITTED') return;
      const before = await counts();
      const firstTask = first.task as unknown as { _id: Types.ObjectId };
      class DuplicateIdentityRepository extends TaskDataRepository {
        protected override allocateIds() {
          return {
            taskId: firstTask._id,
            eventId: new Types.ObjectId(),
            operationId: randomUUID(),
          };
        }
      }
      const collision = await new DuplicateIdentityRepository(
        connection!.db!,
      ).create({ projectId, actorId }, { title: 'new title' });
      expect(collision.state).toBe('ABORTED');
      expect(await counts()).toEqual(before);
    });

    it('O6 scopes every read to one Project and verifies the Task before history', async () => {
      const result = await create('private task');
      expect(result.state).toBe('COMMITTED');
      if (result.state !== 'COMMITTED') return;
      expect(
        await repository.getById(
          String(otherProjectId),
          String(result.task._id),
        ),
      ).toBeNull();
      expect(
        await repository.listByProject(String(otherProjectId), { limit: 10 }),
      ).toEqual([]);
      expect(
        await repository.listHistory(
          String(otherProjectId),
          String(result.task._id),
        ),
      ).toEqual([]);
      expect(
        await repository.getById(
          [String(projectId)] as unknown as string,
          String(result.task._id),
        ),
      ).toBeNull();
    });

    it('O7 enforces one version-1 event and stores provenance without content snapshots', async () => {
      const result = await create('sensitive title content');
      expect(result.state).toBe('COMMITTED');
      if (result.state !== 'COMMITTED') return;
      const event = await connection!
        .db!.collection<TaskCreationEventDocument>(TASK_EVENT_COLLECTION)
        .findOne({ taskId: result.task._id });
      expect(event).not.toBeNull();
      expect(JSON.stringify(event)).not.toContain('sensitive title content');
      expect(Object.keys(event!).sort()).toEqual(
        [
          '_id',
          'taskId',
          'projectId',
          'eventName',
          'actorType',
          'actorId',
          'source',
          'changedFields',
          'taskVersion',
          'occurredAt',
          'operationId',
          'correlationId',
        ].sort(),
      );
      await expect(
        connection!.db!.collection(TASK_EVENT_COLLECTION).insertOne({
          ...event,
          _id: new Types.ObjectId(),
        }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('O8 keeps the provisional Task invisible until its event and transaction commit', async () => {
      let markInserted!: () => void;
      let releaseInsert!: () => void;
      const inserted = new Promise<void>((resolve) => (markInserted = resolve));
      const released = new Promise<void>(
        (resolve) => (releaseInsert = resolve),
      );
      class PausingRepository extends TaskDataRepository {
        protected override async insertCreationEvent(
          session: mongoose.mongo.ClientSession,
          event: TaskCreationEventDocument,
        ) {
          await super.insertCreationEvent(session, event);
          markInserted();
          await released;
        }
      }
      const pending = new PausingRepository(connection!.db!).create(
        { projectId, actorId },
        { title: 'atomic pair' },
      );
      await inserted;
      expect(await counts()).toEqual({ tasks: 0, events: 0 });
      releaseInsert();
      expect((await pending).state).toBe('COMMITTED');
      expect(await counts()).toEqual({ tasks: 1, events: 1 });
    });

    it('O9 aborts Task failure, event failure, and explicit abort after both writes', async () => {
      class TaskFailureRepository extends TaskDataRepository {
        protected override insertTask(): Promise<void> {
          return Promise.reject(new Error('forced task insert failure'));
        }
      }
      class EventFailureRepository extends TaskDataRepository {
        protected override insertCreationEvent(): Promise<void> {
          return Promise.reject(new Error('forced event insert failure'));
        }
      }
      class AbortAfterEventRepository extends TaskDataRepository {
        protected override async insertCreationEvent(
          session: mongoose.mongo.ClientSession,
          event: TaskCreationEventDocument,
        ) {
          await super.insertCreationEvent(session, event);
          await session.abortTransaction();
          throw new Error('forced abort after both writes');
        }
      }
      const before = await counts();
      expect(
        await new TaskFailureRepository(connection!.db!).create(
          { projectId, actorId },
          { title: 'task failure' },
        ),
      ).toMatchObject({ state: 'ABORTED' });
      expect(
        await new EventFailureRepository(connection!.db!).create(
          { projectId, actorId },
          { title: 'event failure' },
        ),
      ).toMatchObject({ state: 'ABORTED' });
      expect(
        await new AbortAfterEventRepository(connection!.db!).create(
          { projectId, actorId },
          { title: 'abort after event' },
        ),
      ).toMatchObject({ state: 'ABORTED' });
      expect(await counts()).toEqual(before);
    });

    it('O10 retries a labelled transient failure and reconciles a lost commit reply', async () => {
      await connection!.db!.admin().command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: {
          failCommands: ['insert'],
          errorCode: 112,
          errorLabels: ['TransientTransactionError'],
        },
      });
      let insertAttempts = 0;
      class CountingRepository extends TaskDataRepository {
        protected override async insertTask(
          session: mongoose.mongo.ClientSession,
          task: TaskDocument,
        ) {
          insertAttempts += 1;
          await super.insertTask(session, task);
        }
      }
      let transientResult;
      try {
        transientResult = await new CountingRepository(connection!.db!).create(
          { projectId, actorId },
          { title: 'transient retry' },
        );
      } finally {
        await connection!.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: 'off',
        });
      }
      expect(transientResult?.state).toBe('COMMITTED');
      expect(insertAttempts).toBeGreaterThanOrEqual(2);
      expect(await counts()).toEqual({ tasks: 1, events: 1 });

      class LostCommitReplyRepository extends TaskDataRepository {
        protected override async executeTransaction(
          session: mongoose.mongo.ClientSession,
          callback: (session: mongoose.mongo.ClientSession) => Promise<void>,
        ) {
          await super.executeTransaction(session, callback);
          const error = new mongoose.mongo.MongoError(
            'simulated lost commit reply',
          );
          error.addErrorLabel('UnknownTransactionCommitResult');
          throw error;
        }
      }
      const reconciled = await new LostCommitReplyRepository(
        connection!.db!,
      ).create(
        { projectId, actorId },
        { title: 'committed before lost reply' },
      );
      expect(reconciled.state).toBe('COMMITTED');
      if (reconciled.state === 'COMMITTED')
        expect(reconciled.reconciled).toBe(true);
      expect(await counts()).toEqual({ tasks: 2, events: 2 });

      class UnobservedCommitRepository extends TaskDataRepository {
        protected override async executeTransaction(
          session: mongoose.mongo.ClientSession,
          callback: (session: mongoose.mongo.ClientSession) => Promise<void>,
        ) {
          await session.withTransaction(
            async (transactionSession) => {
              await callback(transactionSession);
              await transactionSession.abortTransaction();
            },
            {
              readPreference: 'primary',
              readConcern: { level: 'snapshot' },
              writeConcern: { w: 'majority' },
            },
          );
          const error = new mongoose.mongo.MongoError(
            'simulated unknown commit result',
          );
          error.addErrorLabel('UnknownTransactionCommitResult');
          throw error;
        }
      }
      expect(
        await new UnobservedCommitRepository(connection!.db!).create(
          { projectId, actorId },
          { title: 'not observed at reconciliation snapshot' },
        ),
      ).toMatchObject({
        state: 'UNCERTAIN',
        reason: 'NO_MATCHING_PAIR_AT_SNAPSHOT',
      });
      expect(await counts()).toEqual({ tasks: 2, events: 2 });
    });

    it('O11 exposes no history mutators and proves restricted database privileges', async () => {
      const db = connection!.db!;
      const username = `task_writer_${randomUUID().replaceAll('-', '')}`;
      const password = randomUUID();
      const role = `task_create_read_${randomUUID().replaceAll('-', '')}`;
      await db.command({
        createRole: role,
        privileges: [TASK_COLLECTION, TASK_EVENT_COLLECTION].map(
          (collection) => ({
            resource: { db: databaseName, collection },
            actions: ['find', 'insert'],
          }),
        ),
        roles: [],
      });
      await db.command({ createUser: username, pwd: password, roles: [role] });
      restrictedUser = username;
      const rootUri = new URL(process.env.MONGODB_URI!);
      rootUri.username = username;
      rootUri.password = password;
      rootUri.pathname = `/${databaseName}`;
      rootUri.searchParams.set('authSource', databaseName);
      restrictedConnection = mongoose.createConnection(rootUri.toString(), {
        dbName: databaseName,
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      });
      await restrictedConnection.asPromise();
      const restrictedRepository = new TaskDataRepository(
        restrictedConnection.db!,
      );
      expect(
        typeof (restrictedRepository as unknown as { update?: unknown }).update,
      ).toBe('undefined');
      expect(
        typeof (restrictedRepository as unknown as { delete?: unknown }).delete,
      ).toBe('undefined');
      const result = await restrictedRepository.create(
        { projectId, actorId },
        { title: 'append-only proof' },
      );
      expect(result.state).toBe('COMMITTED');
      if (result.state !== 'COMMITTED') return;
      const taskCollection =
        restrictedConnection.db!.collection(TASK_COLLECTION);
      const eventCollection = restrictedConnection.db!.collection(
        TASK_EVENT_COLLECTION,
      );
      await expect(
        taskCollection.updateOne(
          { _id: result.task._id },
          { $set: { title: 'changed' } },
        ),
      ).rejects.toMatchObject({ code: 13 });
      await expect(
        taskCollection.deleteOne({ _id: result.task._id }),
      ).rejects.toMatchObject({ code: 13 });
      const event = await eventCollection.findOne({ taskId: result.task._id });
      await expect(
        eventCollection.updateOne(
          { _id: event!._id },
          { $set: { source: 'AGENT' } },
        ),
      ).rejects.toMatchObject({ code: 13 });
      await expect(
        eventCollection.deleteOne({ _id: event!._id }),
      ).rejects.toMatchObject({ code: 13 });
      expect(await eventCollection.findOne({ _id: event!._id })).toEqual(event);
    }, 30_000);

    it('O12 traverses bounded Project cursor pages and accepts the approved compound index', async () => {
      for (let index = 0; index < 8; index += 1)
        await create(
          `page-${index}`,
          index % 2 === 0 ? projectId : otherProjectId,
        );
      const first = await repository.listByProject(String(projectId), {
        limit: 2,
      });
      const second = await repository.listByProject(String(projectId), {
        limit: 2,
        afterId: String(first[1]._id),
      });
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(first.map(({ _id }) => _id.toHexString())).toEqual(
        [...first].map(({ _id }) => _id.toHexString()).sort(),
      );
      expect(
        second.every(({ projectId: owner }) => owner.equals(projectId)),
      ).toBe(true);
      expect(second[0]._id.toHexString() > first[1]._id.toHexString()).toBe(
        true,
      );
      await expect(
        repository.listByProject(String(projectId), {
          limit: MAX_PAGE_SIZE + 1,
        }),
      ).rejects.toThrow('Task page limit is invalid');
      const explain = await connection!
        .db!.collection(TASK_COLLECTION)
        .find({ projectId, _id: { $gt: first[1]._id } })
        .sort({ _id: 1 })
        .limit(2)
        .hint('task_project_cursor')
        .explain('queryPlanner');
      expect(JSON.stringify(explain)).toContain('task_project_cursor');
    });

    it('O13 keeps status, assignment, outbox and runtime activation outside the data slice', async () => {
      const taskCollections = await connection!
        .db!.listCollections({}, { nameOnly: true })
        .toArray();
      expect(taskCollections.map(({ name }) => name).sort()).toEqual(
        [TASK_COLLECTION, TASK_EVENT_COLLECTION].sort(),
      );
      const taskSchema = await connection!.db!.command({
        listCollections: 1,
        filter: { name: TASK_COLLECTION },
        nameOnly: false,
      });
      expect(JSON.stringify(taskSchema)).not.toMatch(
        /status|priority|assignee|teamId|organizationId|outbox|lifecycle/i,
      );
      expect(TASK_DATABASE_NAME).toBe('continuum_task');
      expect(Object.keys(SERVICE_DATABASES)).not.toContain('task');
      expect(Object.values(SERVICE_DATABASES)).not.toContain(
        TASK_DATABASE_NAME,
      );
    });
  },
);
