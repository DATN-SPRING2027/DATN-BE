import { randomUUID } from 'node:crypto';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  TASK_COLLECTION,
  TASK_EVENT_COLLECTION,
  TASK_OPERATION_COLLECTION,
} from './task-contract';
import {
  TASK_DISPOSABLE_FIXTURE_MARKER,
  initializeTaskDisposableDatabase,
} from './initialize-task-disposable-database';
import { TaskDataRepository } from './task-data.repository';
import { TaskLifecycleCommandService } from '../../runtime/task-lifecycle-command';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('D-08 lifecycle command on a marked MongoDB 7 replica set', () => {
  const databaseName = `datn95task_${randomUUID().replaceAll('-', '')}`;
  const projectId = new Types.ObjectId();
  const actorId = new Types.ObjectId();
  const fixedNow = new Date('2026-10-19T10:00:00.000Z');
  let connection: Connection | undefined;
  let repository: TaskDataRepository;

  function rawTask(overrides: Record<string, unknown> = {}) {
    const createdAt = new Date('2026-10-19T09:00:00.000Z');
    return {
      _id: new Types.ObjectId(),
      projectId,
      title: 'lifecycle fixture',
      createdBy: actorId,
      createdAt,
      updatedAt: createdAt,
      status: 'TODO',
      assigneeId: actorId,
      completedAt: null,
      version: 1,
      ...overrides,
    };
  }

  function context(overrides: Record<string, unknown> = {}) {
    return {
      actorId: actorId.toHexString(),
      projectId: projectId.toHexString(),
      projectRole: 'TEAM_LEADER',
      projectMembershipStatus: 'ACTIVE',
      organizationMembershipStatus: 'ACTIVE',
      source: 'INTERNAL_SERVICE',
      requestId: 'd08-lifecycle-integration',
      ...overrides,
    };
  }

  function command(
    taskId: Types.ObjectId,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      taskId: taskId.toHexString(),
      targetStatus: 'IN_PROGRESS',
      expectedVersion: 1,
      operationId: randomUUID(),
      ...overrides,
    };
  }

  function lifecycleService(
    persistence: TaskDataRepository = repository,
  ): TaskLifecycleCommandService {
    return new TaskLifecycleCommandService(persistence, () => fixedNow);
  }

  async function counts() {
    return {
      tasks: await connection!.db!.collection(TASK_COLLECTION).countDocuments(),
      events: await connection!
        .db!.collection(TASK_EVENT_COLLECTION)
        .countDocuments(),
      operations: await connection!
        .db!.collection(TASK_OPERATION_COLLECTION)
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
        'D-08 integration requires an explicit loopback MongoDB fixture URI',
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
        'D-08 requires its marked, disposable MongoDB 7 replica set',
      );
    await initializeTaskDisposableDatabase(db);
    repository = new TaskDataRepository(db);
  }, 30_000);

  afterEach(async () => {
    if (connection?.readyState === mongoose.ConnectionStates.connected) {
      await connection.db!.collection(TASK_COLLECTION).deleteMany({});
      await connection.db!.collection(TASK_EVENT_COLLECTION).deleteMany({});
      await connection.db!.collection(TASK_OPERATION_COLLECTION).deleteMany({});
    }
  });

  afterAll(async () => {
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
          'Refusing to drop a database without the D-08 fixture identity',
        );
      await connection.dropDatabase();
    }
    await connection?.close();
  });

  it('atomically commits status, version, event and operation, then replays once', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    const service = lifecycleService();
    const request = command(task._id);

    const committed = await service.execute(context(), request);

    expect(committed).toMatchObject({
      kind: 'COMMITTED',
      status: 'IN_PROGRESS',
      version: 2,
      replayed: false,
    });
    const storedTask = await repository.getById(
      projectId.toHexString(),
      task._id.toHexString(),
    );
    expect(storedTask).toMatchObject({
      status: 'IN_PROGRESS',
      version: 2,
      completedAt: null,
      updatedAt: fixedNow,
    });
    const history = await repository.listHistory(
      projectId.toHexString(),
      task._id.toHexString(),
      { page: 1, limit: 20 },
    );
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      eventType: 'TASK_STATUS_TRANSITIONED',
      actorId,
      source: 'INTERNAL_SERVICE',
      operationId: request.operationId,
      correlationId: 'd08-lifecycle-integration',
      timestamp: fixedNow,
      version: 2,
      changedFields: ['status'],
      delta: {
        type: 'STATUS_TRANSITION',
        fromStatus: 'TODO',
        toStatus: 'IN_PROGRESS',
      },
    });
    expect(Object.keys(history.events[0]).sort()).toEqual(
      [
        '_id',
        'taskId',
        'projectId',
        'actorId',
        'actorType',
        'source',
        'eventType',
        'operationId',
        'correlationId',
        'timestamp',
        'version',
        'changedFields',
        'delta',
      ].sort(),
    );
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
    const storedOperation = await connection!
      .db!.collection(TASK_OPERATION_COLLECTION)
      .findOne({ operationId: request.operationId });
    expect(storedOperation?.expiresAt).toEqual(
      new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000),
    );

    const replayed = await service.execute(context(), request);
    expect(replayed).toMatchObject({
      kind: 'COMMITTED',
      version: 2,
      replayed: true,
    });
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
  });

  it('rejects forbidden and stale transitions without changing Task or history', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    const service = lifecycleService();
    const forbidden = command(task._id, {
      targetStatus: 'BLOCKED',
      reason: 'direct block',
    });

    await expect(service.execute(context(), forbidden)).resolves.toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_NOT_ALLOWED',
    });
    await expect(service.execute(context(), forbidden)).resolves.toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_TRANSITION_NOT_ALLOWED',
      replayed: true,
    });
    await expect(
      service.execute(context(), command(task._id, { expectedVersion: 2 })),
    ).resolves.toMatchObject({
      kind: 'REJECTED',
      code: 'TASK_VERSION_CONFLICT',
      currentVersion: 1,
    });
    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({
      status: 'TODO',
      version: 1,
      completedAt: null,
    });
    expect(await counts()).toEqual({ tasks: 1, events: 0, operations: 2 });
  });

  it.each(['TEAM_LEADER', 'ADMIN'] as const)(
    'rejects START without an assignee for %s without changing Task or history',
    async (projectRole) => {
      const task = rawTask({ assigneeId: null });
      await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
      const request = command(task._id);

      await expect(
        lifecycleService().execute(context({ projectRole }), request),
      ).resolves.toMatchObject({
        kind: 'REJECTED',
        code: 'TASK_TRANSITION_FORBIDDEN',
      });
      expect(
        await repository.getById(
          projectId.toHexString(),
          task._id.toHexString(),
        ),
      ).toMatchObject({
        status: 'TODO',
        assigneeId: null,
        version: 1,
        completedAt: null,
      });
      expect(await counts()).toEqual({ tasks: 1, events: 0, operations: 1 });
    },
  );

  it('rejects a changed payload when an operation ID has already been used', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    const service = lifecycleService();
    const request = command(task._id);

    await expect(service.execute(context(), request)).resolves.toMatchObject({
      kind: 'COMMITTED',
      status: 'IN_PROGRESS',
    });
    await expect(
      service.execute(
        context(),
        command(task._id, {
          operationId: request.operationId,
          targetStatus: 'CANCELLED',
          reason: 'cancel request',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'REJECTED',
      code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      replayed: false,
    });

    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
  });

  it('sets completion time on DONE and clears it on an approved REOPEN', async () => {
    const task = rawTask({ status: 'IN_PROGRESS', version: 4 });
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    const service = lifecycleService();

    await expect(
      service.execute(
        context(),
        command(task._id, { targetStatus: 'DONE', expectedVersion: 4 }),
      ),
    ).resolves.toMatchObject({
      kind: 'COMMITTED',
      status: 'DONE',
      version: 5,
      completedAt: fixedNow,
    });
    await expect(
      service.execute(
        context(),
        command(task._id, {
          targetStatus: 'IN_PROGRESS',
          expectedVersion: 5,
          reason: 'resume after done',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'COMMITTED',
      status: 'IN_PROGRESS',
      version: 6,
      completedAt: null,
    });

    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({
      status: 'IN_PROGRESS',
      version: 6,
      completedAt: null,
    });
    expect(
      await repository.listHistory(
        projectId.toHexString(),
        task._id.toHexString(),
        { page: 1, limit: 20 },
      ),
    ).toMatchObject({ events: [{ version: 5 }, { version: 6 }], total: 2 });
  });

  it('allows only one concurrent transition at the same expectedVersion', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    const service = lifecycleService();

    const results = await Promise.all([
      service.execute(context(), command(task._id)),
      service.execute(
        context(),
        command(task._id, {
          targetStatus: 'CANCELLED',
          reason: 'cancel request',
        }),
      ),
    ]);

    expect(results.filter(({ kind }) => kind === 'COMMITTED')).toHaveLength(1);
    expect(results.filter(({ kind }) => kind === 'REJECTED')).toHaveLength(1);
    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({
      version: 2,
    });
    expect((await counts()).events).toBe(1);
  });

  it('reports an identical concurrent operation in progress', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    let markEntered!: () => void;
    let releaseTransaction!: () => void;
    const entered = new Promise<void>((resolve) => (markEntered = resolve));
    const released = new Promise<void>(
      (resolve) => (releaseTransaction = resolve),
    );
    class PausingRepository extends TaskDataRepository {
      private paused = false;

      protected override async executeTransaction(
        session: mongoose.mongo.ClientSession,
        callback: (session: mongoose.mongo.ClientSession) => Promise<void>,
      ): Promise<void> {
        if (!this.paused) {
          this.paused = true;
          markEntered();
          await released;
        }
        await super.executeTransaction(session, callback);
      }
    }
    const service = lifecycleService(new PausingRepository(connection!.db!));
    const request = command(task._id);

    const first = service.execute(context(), request);
    await entered;
    await expect(service.execute(context(), request)).resolves.toMatchObject({
      kind: 'IN_PROGRESS',
    });
    releaseTransaction();
    await expect(first).resolves.toMatchObject({ kind: 'COMMITTED' });
    expect((await counts()).events).toBe(1);
  });

  it('reconciles a committed transition after losing the commit acknowledgement', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    class LostCommitReplyRepository extends TaskDataRepository {
      protected override async executeTransaction(
        session: mongoose.mongo.ClientSession,
        callback: (session: mongoose.mongo.ClientSession) => Promise<void>,
      ): Promise<void> {
        await super.executeTransaction(session, callback);
        const error = new mongoose.mongo.MongoError(
          'simulated lost lifecycle commit reply',
        );
        error.addErrorLabel('UnknownTransactionCommitResult');
        throw error;
      }
    }
    const service = lifecycleService(
      new LostCommitReplyRepository(connection!.db!),
    );

    await expect(
      service.execute(context(), command(task._id)),
    ).resolves.toMatchObject({
      kind: 'COMMITTED',
      replayed: true,
      reconciled: true,
    });
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
  });

  it('keeps an unresolved commit result uncertain when reconciliation finds no terminal operation', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    class UnresolvedCommitRepository extends TaskDataRepository {
      protected override executeTransaction(): Promise<void> {
        const error = new mongoose.mongo.MongoError(
          'simulated unknown lifecycle commit result',
        );
        error.addErrorLabel('UnknownTransactionCommitResult');
        return Promise.reject(error);
      }
    }
    const request = command(task._id);

    await expect(
      lifecycleService(new UnresolvedCommitRepository(connection!.db!)).execute(
        context(),
        request,
      ),
    ).resolves.toMatchObject({
      kind: 'UNCERTAIN',
      operationId: request.operationId,
    });
    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({ status: 'TODO', version: 1, completedAt: null });
    expect(await counts()).toEqual({ tasks: 1, events: 0, operations: 1 });

    const retryService = new TaskLifecycleCommandService(
      repository,
      () => new Date(fixedNow.getTime() + 60_001),
    );
    await expect(
      retryService.execute(context(), request),
    ).resolves.toMatchObject({
      kind: 'COMMITTED',
      version: 2,
      replayed: false,
    });
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
  });

  it('aborts Task changes when the transition history write fails', async () => {
    const task = rawTask();
    await connection!.db!.collection(TASK_COLLECTION).insertOne(task);
    class EventFailureRepository extends TaskDataRepository {
      protected override insertStatusTransitionEvent(): Promise<void> {
        return Promise.reject(new Error('forced lifecycle history failure'));
      }
    }
    const failedService = new TaskLifecycleCommandService(
      new EventFailureRepository(connection!.db!),
      () => fixedNow,
    );
    const retryService = new TaskLifecycleCommandService(
      repository,
      () => new Date(fixedNow.getTime() + 2),
    );
    const request = command(task._id);

    await expect(
      failedService.execute(context(), request),
    ).resolves.toMatchObject({
      kind: 'ABORTED',
    });
    expect(
      await repository.getById(projectId.toHexString(), task._id.toHexString()),
    ).toMatchObject({
      status: 'TODO',
      version: 1,
      completedAt: null,
    });
    expect(
      await connection!.db!.collection(TASK_EVENT_COLLECTION).countDocuments(),
    ).toBe(0);

    await expect(
      retryService.execute(context(), request),
    ).resolves.toMatchObject({
      kind: 'COMMITTED',
      version: 2,
    });
    expect(await counts()).toEqual({ tasks: 1, events: 1, operations: 1 });
  });
});
