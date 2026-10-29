import { Types } from 'mongoose';
import { HandoverAiService } from './handover-ai.service';
import type { StoredHandoverDoc, StoredJobDoc } from './handover.types';

describe('HandoverAiService durability & crash safety (F04 / F05)', () => {
  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');
  const handoverId = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d50');
  const leaderId = '851a2b3c4d5e6f7a8b9c0d31';
  const departingId = '851a2b3c4d5e6f7a8b9c0d33';

  it('catches DB claim rejections inside scheduleBackgroundJob without leaking unhandledRejection (F04)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const repo = {
      jobs: {
        findOneAndUpdate: jest.fn(() => ({
          lean: () => ({
            exec: () =>
              Promise.reject(new Error('Transient Mongo primary stepdown')),
          }),
        })),
        updateOne: jest.fn(() => Promise.resolve({ matchedCount: 0 })),
        updateMany: jest.fn(() => Promise.resolve({ modifiedCount: 0 })),
        find: jest.fn(() => ({
          sort: () => ({
            limit: () => ({
              select: () => ({
                lean: () => ({ exec: () => Promise.resolve([]) }),
              }),
            }),
          }),
        })),
      },
    };

    const svc = new HandoverAiService(
      repo as never,
      {} as never,
      {} as never,
      undefined,
    );

    try {
      (
        svc as unknown as {
          scheduleBackgroundJob: (id: Types.ObjectId) => void;
        }
      ).scheduleBackgroundJob(new Types.ObjectId());
      await svc.flushPendingJobs();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
      expect(repo.jobs.findOneAndUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await svc.onModuleDestroy();
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('recovers PENDING and lease-expired RUNNING jobs, fences stale leases, fails exhausted leases, and allows retryJob on expired RUNNING leases (F05)', async () => {
    const pendingJobId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d01');
    const expiredRunningId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d02');
    const exhaustedRunningId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d03');
    const manualRetryRunningId = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d04');

    const pastDate = new Date(Date.now() - 120_000);
    const jobsStore = new Map<string, StoredJobDoc>([
      [
        pendingJobId.toHexString(),
        {
          _id: pendingJobId,
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          initiatedBy: leaderId,
          commandId: new Types.ObjectId(),
          kind: 'SOURCE_PROPOSAL',
          state: 'PENDING',
          inputDraftVersion: 0,
          query: 'deployment',
          sourceFingerprint: 'a'.repeat(64),
          selectedSources: [],
          attempt: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        expiredRunningId.toHexString(),
        {
          _id: expiredRunningId,
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          initiatedBy: leaderId,
          commandId: new Types.ObjectId(),
          kind: 'SOURCE_PROPOSAL',
          state: 'RUNNING',
          inputDraftVersion: 0,
          query: 'deployment',
          sourceFingerprint: 'a'.repeat(64),
          selectedSources: [],
          attempt: 1,
          leaseOwner: 'dead-worker-1',
          leaseExpiresAt: pastDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        exhaustedRunningId.toHexString(),
        {
          _id: exhaustedRunningId,
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          initiatedBy: leaderId,
          commandId: new Types.ObjectId(),
          kind: 'SOURCE_PROPOSAL',
          state: 'RUNNING',
          inputDraftVersion: 0,
          query: 'deployment',
          sourceFingerprint: 'a'.repeat(64),
          selectedSources: [],
          attempt: 3,
          leaseOwner: 'dead-worker-2',
          leaseExpiresAt: pastDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        manualRetryRunningId.toHexString(),
        {
          _id: manualRetryRunningId,
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          initiatedBy: leaderId,
          commandId: new Types.ObjectId(),
          kind: 'SOURCE_PROPOSAL',
          state: 'RUNNING',
          inputDraftVersion: 0,
          query: 'deployment',
          sourceFingerprint: 'a'.repeat(64),
          selectedSources: [],
          attempt: 1,
          leaseOwner: 'dead-worker-3',
          leaseExpiresAt: pastDate,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    ]);

    const handoverDoc: StoredHandoverDoc = {
      _id: handoverId,
      schemaVersion: 2,
      organizationId: orgId,
      projectId,
      departingUserId: departingId,
      assignedLeaderId: leaderId,
      successorUserId: null,
      title: 'Handover',
      targetCompletionDate: new Date(),
      status: 'OPEN',
      version: 1,
      draftVersion: 0,
      assignmentVersion: 0,
      publishedRevisionId: null,
      selectedSources: [],
      selectedTasks: [],
      createdBy: leaderId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const matchesFilter = (
      doc: StoredJobDoc,
      filter: Record<string, unknown>,
    ): boolean => {
      if (filter._id && !doc._id.equals(filter._id as Types.ObjectId)) {
        return false;
      }
      if (filter.state && doc.state !== filter.state) {
        return false;
      }
      if (filter.leaseOwner && doc.leaseOwner !== filter.leaseOwner) {
        return false;
      }
      if (filter.leaseExpiresAt) {
        const lte = (filter.leaseExpiresAt as { $lte?: Date }).$lte;
        if (
          lte &&
          (!doc.leaseExpiresAt || doc.leaseExpiresAt.getTime() > lte.getTime())
        ) {
          return false;
        }
      }
      if (filter.attempt) {
        const lt = (filter.attempt as { $lt?: number }).$lt;
        const gte = (filter.attempt as { $gte?: number }).$gte;
        if (lt !== undefined && !(doc.attempt < lt)) return false;
        if (gte !== undefined && !(doc.attempt >= gte)) return false;
      }
      if (Array.isArray(filter.$or)) {
        return filter.$or.some((sub) =>
          matchesFilter(doc, sub as Record<string, unknown>),
        );
      }
      return true;
    };

    const applyUpdate = (
      doc: StoredJobDoc,
      update: Record<string, Record<string, unknown>>,
    ): StoredJobDoc => {
      const next = { ...doc };
      if (update.$set) {
        Object.assign(next, update.$set);
      }
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          (next as unknown as Record<string, number>)[k] =
            ((next as unknown as Record<string, number>)[k] ?? 0) + Number(v);
        }
      }
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete (next as unknown as Record<string, unknown>)[k];
        }
      }
      jobsStore.set(next._id.toHexString(), next);
      return next;
    };

    const repo = {
      withTransaction: async <T>(fn: (s: null) => Promise<T>) => fn(null),
      findExistingOperation: jest.fn(() => Promise.resolve(null)),
      assertIdempotencyMatchOrReplay: jest.fn(() => 'PROCEED'),
      createOrClaimCommandOperation: jest.fn(() => Promise.resolve()),
      appendAuditAndOutbox: jest.fn(() => Promise.resolve()),
      handovers: {
        findOne: jest.fn(() => ({
          lean: () => ({ exec: () => Promise.resolve(handoverDoc) }),
        })),
        updateOne: jest.fn(() => Promise.resolve({ matchedCount: 1 })),
      },
      jobs: {
        findOne: jest.fn((filter: Record<string, unknown>) => ({
          lean: () => ({
            exec: () => {
              const found = [...jobsStore.values()].find((d) =>
                matchesFilter(d, filter),
              );
              return Promise.resolve(found ?? null);
            },
          }),
        })),
        findOneAndUpdate: jest.fn(
          (
            filter: Record<string, unknown>,
            update: Record<string, Record<string, unknown>>,
          ) => ({
            lean: () => ({
              exec: () => {
                const found = [...jobsStore.values()].find((d) =>
                  matchesFilter(d, filter),
                );
                if (!found) return Promise.resolve(null);
                return Promise.resolve(applyUpdate(found, update));
              },
            }),
          }),
        ),
        updateOne: jest.fn(
          (
            filter: Record<string, unknown>,
            update: Record<string, Record<string, unknown>>,
          ) => {
            const found = [...jobsStore.values()].find((d) =>
              matchesFilter(d, filter),
            );
            if (!found) return Promise.resolve({ matchedCount: 0 });
            applyUpdate(found, update);
            return Promise.resolve({ matchedCount: 1 });
          },
        ),
        updateMany: jest.fn(
          (
            filter: Record<string, unknown>,
            update: Record<string, Record<string, unknown>>,
          ) => {
            let count = 0;
            for (const doc of [...jobsStore.values()]) {
              if (matchesFilter(doc, filter)) {
                applyUpdate(doc, update);
                count += 1;
              }
            }
            return Promise.resolve({ modifiedCount: count });
          },
        ),
        find: jest.fn((filter: Record<string, unknown>) => ({
          sort: () => ({
            limit: () => ({
              select: () => ({
                lean: () => ({
                  exec: () =>
                    Promise.resolve(
                      [...jobsStore.values()]
                        .filter((d) => matchesFilter(d, filter))
                        .filter((d) => !d._id.equals(manualRetryRunningId))
                        .map((d) => ({ _id: d._id })),
                    ),
                }),
              }),
            }),
          }),
        })),
      },
    };

    const iamScope = {
      assertEligibleCoordinator: jest.fn(() => Promise.resolve()),
    };
    const sourcesService = {
      discoverOfficialCandidates: jest.fn(() => Promise.resolve([])),
    };
    const aiEngine = {
      request: jest.fn(),
    };

    const svc = new HandoverAiService(
      repo as never,
      iamScope as never,
      sourcesService as never,
      aiEngine as never,
    );

    try {
      // 1. Manual retryJob accepts expired-lease RUNNING job and executes it cleanly
      const retried = await svc.retryJob({
        actor: {
          userId: leaderId,
          userName: 'Leader D',
          organizationId: orgId.toHexString(),
          projectId: projectId.toHexString(),
          projectVisibility: 'PRIVATE',
          isProjectMember: true,
          isProjectLeader: true,
          canAdministerCoordinator: true,
        },
        handover: handoverDoc,
        jobId: manualRetryRunningId.toHexString(),
        dto: { expectedDraftVersion: 0 },
        expectedVersion: 1,
        idempotencyKey: 'retry-expired-running-1',
      });
      expect(retried.job.state).toBe('PENDING');

      // 2. Recovery sweep marks exhausted RUNNING lease as FAILED and reclaims PENDING + expired-lease RUNNING (<3 attempts)
      await svc.recoverStalledJobs();
      await svc.flushPendingJobs();

      expect(jobsStore.get(pendingJobId.toHexString())?.state).toBe(
        'SUCCEEDED',
      );
      expect(jobsStore.get(expiredRunningId.toHexString())?.state).toBe(
        'SUCCEEDED',
      );
      expect(jobsStore.get(expiredRunningId.toHexString())?.attempt).toBe(2);
      expect(jobsStore.get(exhaustedRunningId.toHexString())?.state).toBe(
        'FAILED',
      );
      expect(
        jobsStore.get(exhaustedRunningId.toHexString())?.safeErrorCode,
      ).toBe('WORKER_LEASE_EXPIRED');
      expect(jobsStore.get(manualRetryRunningId.toHexString())?.state).toBe(
        'SUCCEEDED',
      );

      // 3. Simulated zombie worker with stale leaseOwner cannot overwrite SUCCEEDED job
      const zombieWrite = await repo.jobs.updateOne(
        {
          _id: expiredRunningId,
          state: 'RUNNING',
          leaseOwner: 'dead-worker-1',
        },
        { $set: { state: 'FAILED', safeErrorCode: 'ZOMBIE_WRITE' } },
      );
      expect(zombieWrite.matchedCount).toBe(0);
      expect(jobsStore.get(expiredRunningId.toHexString())?.state).toBe(
        'SUCCEEDED',
      );
    } finally {
      await svc.onModuleDestroy();
    }
  });
});
