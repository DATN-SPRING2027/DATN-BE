import { Types } from 'mongoose';
import { HandoverTaskAssignmentService } from './handover-task-assignment.service';

describe('HandoverTaskAssignmentService (C02 / A10 / A11 / A15)', () => {
  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');
  const leaderId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d31');
  const departingA = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d32');
  const successorB = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d33');
  const memberC = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d39');
  const handoverId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d50');
  const revisionId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d51');
  const task1Id = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d61');
  const doneTaskId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d62');

  function createHarness() {
    const tasks = new Map<string, Record<string, unknown>>([
      [
        task1Id.toHexString(),
        {
          _id: task1Id,
          organizationId: orgId,
          projectId,
          title: 'Maintain retry queue',
          status: 'IN_PROGRESS',
          assigneeId: departingA,
          version: 3,
          completedAt: null,
        },
      ],
      [
        doneTaskId.toHexString(),
        {
          _id: doneTaskId,
          organizationId: orgId,
          projectId,
          title: 'Shipped Q2 migration',
          status: 'DONE',
          assigneeId: departingA,
          version: 2,
          completedAt: new Date(),
        },
      ],
    ]);
    const operations = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];

    const idStr = (val: unknown): string => {
      if (val instanceof Types.ObjectId) return val.toHexString();
      if (typeof val === 'string') return val;
      return '';
    };

    const session = {
      withTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      endSession: () => Promise.resolve(undefined),
    };

    const db = {
      collection: (name: string) => {
        if (name === 'tasks') {
          return {
            findOne: jest.fn((filter: Record<string, unknown>) => {
              const row = tasks.get(idStr(filter._id)) ?? null;
              if (!row) return Promise.resolve(null);
              if (
                filter.projectId &&
                idStr(row.projectId) !== idStr(filter.projectId)
              )
                return Promise.resolve(null);
              return Promise.resolve({ ...row });
            }),
            updateOne: jest.fn(
              (
                filter: Record<string, unknown>,
                update: Record<string, unknown>,
              ) => {
                const row = tasks.get(idStr(filter._id));
                if (!row || row.version !== filter.version) {
                  return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
                }
                const set = (update.$set ?? {}) as Record<string, unknown>;
                const inc = (update.$inc ?? {}) as Record<string, number>;
                tasks.set(idStr(filter._id), {
                  ...row,
                  ...set,
                  version: Number(row.version) + Number(inc.version ?? 0),
                });
                return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
              },
            ),
          };
        }
        if (name === 'task_operations') {
          return {
            findOne: jest.fn((filter: Record<string, unknown>) => {
              const key = `${idStr(filter.actorId)}:${idStr(filter.projectId)}:${idStr(filter.operationId)}`;
              return Promise.resolve(operations.get(key) ?? null);
            }),
            updateOne: jest.fn(
              (
                filter: Record<string, unknown>,
                update: Record<string, unknown>,
              ) => {
                const key = `${idStr(filter.actorId)}:${idStr(filter.projectId)}:${idStr(filter.operationId)}`;
                const existing = operations.get(key) ?? {};
                operations.set(key, {
                  ...existing,
                  ...filter,
                  ...((update.$setOnInsert ?? {}) as Record<string, unknown>),
                  ...((update.$set ?? {}) as Record<string, unknown>),
                });
                return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
              },
            ),
          };
        }
        if (name === 'task_events') {
          return {
            insertOne: jest.fn((doc: Record<string, unknown>) => {
              events.push(doc);
              return Promise.resolve({ insertedId: doc._id });
            }),
          };
        }
        throw new Error(`Unexpected collection ${name}`);
      },
    };

    const repo = { db };
    const conn = { startSession: () => Promise.resolve(session) };
    const svc = new HandoverTaskAssignmentService(repo as never, conn as never);
    return { svc, tasks, operations, events, idStr };
  }

  it('commits assignment atomically with receipt + event and replays idempotently on retry', async () => {
    const { svc, tasks, events, idStr } = createHarness();
    const input = {
      organizationId: orgId.toHexString(),
      projectId: projectId.toHexString(),
      actorId: leaderId.toHexString(),
      intentId: '4f00d15e-8123-4abc-9def-001122334455',
      handoverId: handoverId.toHexString(),
      revisionId: revisionId.toHexString(),
      assignmentVersion: 1,
      taskId: task1Id.toHexString(),
      expectedTaskVersion: 3,
      targetAssigneeId: successorB.toHexString(),
    };

    const first = await svc.assignTaskForHandover(input);
    expect(first).toEqual({
      state: 'CONFIRMED',
      committedTaskVersion: 4,
      safeErrorCode: null,
      replayed: false,
    });
    expect(idStr(tasks.get(task1Id.toHexString())?.assigneeId)).toBe(
      successorB.toHexString(),
    );
    expect(events).toHaveLength(1);

    // Retry with identical intentId replays durable receipt even though task.version is now 4!
    const replay = await svc.assignTaskForHandover(input);
    expect(replay).toEqual({
      state: 'CONFIRMED',
      committedTaskVersion: 4,
      safeErrorCode: null,
      replayed: true,
    });
    expect(events).toHaveLength(1);
  });

  it('Scenario A10: reconcile after lost response + legitimate reassignment to C reports CONFLICT and never overwrites C', async () => {
    const { svc, tasks, idStr } = createHarness();
    const intentId = '7a10a100-8123-4abc-9def-001122334455';

    // Original dispatch succeeded to B (v3 -> v4), suppose response was lost before Handover recorded it
    await svc.assignTaskForHandover({
      organizationId: orgId.toHexString(),
      projectId: projectId.toHexString(),
      actorId: leaderId.toHexString(),
      intentId,
      handoverId: handoverId.toHexString(),
      revisionId: revisionId.toHexString(),
      assignmentVersion: 1,
      taskId: task1Id.toHexString(),
      expectedTaskVersion: 3,
      targetAssigneeId: successorB.toHexString(),
    });

    // Meanwhile, someone legitimately reassigned task1 from B to C (v4 -> v5)
    tasks.set(task1Id.toHexString(), {
      ...tasks.get(task1Id.toHexString())!,
      assigneeId: memberC,
      version: 5,
    });

    // Reconcile inspects receipt + current task state: MUST NOT overwrite C and MUST NOT claim CONFIRMED!
    const reconciled = await svc.reconcileTaskForHandover({
      organizationId: orgId.toHexString(),
      projectId: projectId.toHexString(),
      actorId: leaderId.toHexString(),
      intentId,
      handoverId: handoverId.toHexString(),
      revisionId: revisionId.toHexString(),
      assignmentVersion: 1,
      taskId: task1Id.toHexString(),
      expectedTaskVersion: 3,
      targetAssigneeId: successorB.toHexString(),
    });

    expect(reconciled.state).toBe('CONFLICT');
    expect(reconciled.safeErrorCode).toBe('TASK_REASSIGNED_AFTER_DISPATCH');
    expect(idStr(tasks.get(task1Id.toHexString())?.assigneeId)).toBe(
      memberC.toHexString(),
    );
    expect(tasks.get(task1Id.toHexString())?.version).toBe(5);
  });

  it('rejects DONE/CANCELLED tasks without mutating their assignee or version', async () => {
    const { svc, tasks, idStr } = createHarness();
    const res = await svc.assignTaskForHandover({
      organizationId: orgId.toHexString(),
      projectId: projectId.toHexString(),
      actorId: leaderId.toHexString(),
      intentId: '99999999-8123-4abc-9def-001122334455',
      handoverId: handoverId.toHexString(),
      revisionId: revisionId.toHexString(),
      assignmentVersion: 1,
      taskId: doneTaskId.toHexString(),
      expectedTaskVersion: 2,
      targetAssigneeId: successorB.toHexString(),
    });

    expect(res.state).toBe('FAILED');
    expect(res.safeErrorCode).toBe('TASK_TERMINAL_STATE');
    expect(idStr(tasks.get(doneTaskId.toHexString())?.assigneeId)).toBe(
      departingA.toHexString(),
    );
  });
});
