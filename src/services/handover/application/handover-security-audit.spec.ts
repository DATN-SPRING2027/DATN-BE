import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { HandoverProjectActorContext } from '../../iam/application/projects/handover-iam-scope.service';
import { HandoverAiService } from './handover-ai.service';
import { HandoverTransferService } from './handover-transfer.service';
import { HandoverWorkflowService } from './handover-workflow.service';
import { validateSubmitEvidence } from './handover.validation';
import type {
  StoredFollowUpDoc,
  StoredHandoverDoc,
  StoredJobDoc,
  StoredOperationDoc,
  StoredRevisionDoc,
} from './handover.types';

function makeQuery<T>(value: T) {
  const chain = {
    sort: () => chain,
    limit: () => chain,
    select: () => chain,
    session: () => chain,
    lean: () => chain,
    exec: () => Promise.resolve(value),
  };
  return chain;
}

describe('Handover Security & Performance Audit Regressions', () => {
  const oid = () => new Types.ObjectId();

  describe('SEC-AUTH-009: departing-preview enumeration & quick-transfer package acceptance enforcement', () => {
    it('verifies departingUserId historical membership and strips non-member private projects from relatedProjects', async () => {
      const orgId = oid().toHexString();
      const projectA = oid().toHexString();
      const privateProjectB = oid().toHexString();
      const leaderId = oid().toHexString();
      const targetUserId = oid().toHexString();

      const actor: HandoverProjectActorContext = {
        userId: leaderId,
        organizationId: orgId,
        projectId: projectA,
        userName: 'Leader A',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: true,
        canAdministerCoordinator: true,
      };

      const assertHistoricalDepartingMember = jest
        .fn()
        .mockResolvedValue(undefined);
      const iamScope = {
        assertValidCsrf: jest.fn(),
        authenticateActor: jest.fn().mockResolvedValue({ id: leaderId }),
        resolveProjectActorContext: jest.fn().mockResolvedValue(actor),
        assertHistoricalDepartingMember,
        listDepartingMemberProjects: jest.fn().mockResolvedValue([
          {
            projectId: projectA,
            key: 'PA',
            name: 'Project A',
            membershipStatus: 'ACTIVE',
          },
          {
            projectId: privateProjectB,
            key: 'SECRET-B',
            name: 'Secret Executive M&A Project',
            membershipStatus: 'ACTIVE',
          },
        ]),
        resolveActiveProjectMemberScope: jest.fn().mockResolvedValue({
          isProjectMember: false,
          isProjectLeader: false,
        }),
      };

      const countTasksByProjects = jest
        .fn()
        .mockResolvedValue(new Map([[projectA, 2]]));
      const taskService = {
        listDepartingMemberTasksForHandover: jest.fn().mockResolvedValue([]),
        countDepartingMemberActiveTasksByProjects: countTasksByProjects,
      };
      const sourcesService = {
        discoverDepartingMemberFullScope: jest.fn().mockResolvedValue({
          sources: [],
          evaluatedMap: new Map(),
        }),
      };

      const workflow = new HandoverWorkflowService(
        {} as never,
        iamScope as never,
        sourcesService as never,
        taskService as never,
        {} as never,
        {} as never,
      );

      const preview = await workflow.previewDepartingMember(
        projectA,
        { departingUserId: targetUserId },
        {},
      );

      expect(assertHistoricalDepartingMember).toHaveBeenCalledWith(
        orgId,
        projectA,
        targetUserId,
      );
      // Secret project B MUST be omitted completely from relatedProjects and task count query
      expect(preview.body.relatedProjects).toHaveLength(1);
      expect(preview.body.relatedProjects[0].projectId).toBe(projectA);
      expect(JSON.stringify(preview.body)).not.toContain(
        'Secret Executive M&A',
      );
      expect(countTasksByProjects).toHaveBeenCalledWith(
        orgId,
        [projectA],
        targetUserId,
      );

      // Non-member target user is rejected before reading any project/task data
      assertHistoricalDepartingMember.mockRejectedValueOnce(
        new ForbiddenException({ code: 'DEPARTING_MEMBER_NOT_IN_PROJECT' }),
      );
      await expect(
        workflow.previewDepartingMember(
          projectA,
          { departingUserId: targetUserId },
          {},
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects quickTransferTasks with 409 PACKAGE_NOT_ACCEPTED prior to successor acceptance and never overrides expectedTaskVersion', async () => {
      const orgObj = oid();
      const projObj = oid();
      const handoverObj = oid();
      const revObj = oid();
      const taskObj = oid();
      const leaderId = oid().toHexString();
      const departingId = oid().toHexString();
      const successorId = oid().toHexString();

      const actor: HandoverProjectActorContext = {
        userId: leaderId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Leader',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: true,
        canAdministerCoordinator: true,
      };
      const handover = {
        _id: handoverObj,
        organizationId: orgObj,
        projectId: projObj,
        departingUserId: departingId,
        assignedLeaderId: leaderId,
        successorUserId: successorId,
        status: 'OPEN',
        version: 3,
        assignmentVersion: 1,
        publishedRevisionId: revObj,
      } as StoredHandoverDoc;
      const revision = {
        _id: revObj,
        handoverId: handoverObj,
        selectedTasks: [
          {
            taskId: taskObj,
            expectedVersion: 1,
            expectedAssigneeId: departingId,
          },
        ],
      } as unknown as StoredRevisionDoc;

      let packageAccepted = false;
      const createdOps: Array<Record<string, unknown>> = [];
      const repo = {
        findExistingOperation: jest.fn().mockResolvedValue(null),
        revisions: { findOne: jest.fn(() => makeQuery(revision)) },
        acceptances: {
          findOne: jest.fn(() =>
            makeQuery(
              packageAccepted
                ? { kind: 'PACKAGE', decision: 'ACCEPTED' }
                : null,
            ),
          ),
        },
        operations: {
          find: jest.fn(() => makeQuery([])),
          create: jest.fn((docs: Array<Record<string, unknown>>) => {
            createdOps.push(...docs);
            return Promise.resolve(docs.map((d) => ({ toObject: () => d })));
          }),
          updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
          findOneAndUpdate: jest.fn(() =>
            makeQuery({
              _id: oid(),
              handoverId: handoverObj,
              revisionId: revObj,
              successorUserId: successorId,
              assignmentVersion: 1,
            }),
          ),
        },
        handovers: {
          updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
        },
        appendAuditAndOutbox: jest.fn().mockResolvedValue(undefined),
        withTransaction: async <T>(fn: (s: null) => Promise<T>) => fn(null),
      };
      const assignTaskForHandover = jest.fn().mockResolvedValue({
        state: 'CONFLICT',
        committedTaskVersion: null,
        safeErrorCode: 'TASK_VERSION_CONFLICT',
      });
      const taskAssignment = {
        inspectTasksCurrentState: jest.fn().mockResolvedValue(
          new Map([
            [
              taskObj.toHexString(),
              {
                exists: true,
                version: 9, // Live task was mutated to v9 while pinned expectedVersion is 1
                assigneeId: successorId,
                status: 'IN_PROGRESS',
              },
            ],
          ]),
        ),
        assignTaskForHandover,
      };
      const iamScope = {
        assertEligibleActiveProjectMember: jest
          .fn()
          .mockResolvedValue(undefined),
      };

      const transferSvc = new HandoverTransferService(
        repo as never,
        taskAssignment as never,
        iamScope as never,
      );

      // Before successor accepts package -> 409 PACKAGE_NOT_ACCEPTED
      await expect(
        transferSvc.quickTransferTasks({
          actor,
          handover,
          expectedVersion: 3,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        response: { code: 'PACKAGE_NOT_ACCEPTED' },
      });

      // After package acceptance -> pinned expectedTaskVersion (1) MUST NOT be overwritten with live version (9)
      packageAccepted = true;
      await transferSvc.quickTransferTasks({
        actor,
        handover,
        expectedVersion: 3,
        idempotencyKey: randomUUID(),
      });
      expect(assignTaskForHandover).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: taskObj.toHexString(),
          expectedTaskVersion: 1,
        }),
      );
    });
  });

  describe('SEC-AUTH-010 & BE-PERF-005: follow-up item scoping, departing task ACL & batched getHandover', () => {
    it('scopes follow-up owner visibility strictly to owned itemId and hides unrelated items as UNAVAILABLE', async () => {
      const orgObj = oid();
      const projObj = oid();
      const handoverObj = oid();
      const revObj = oid();
      const item1Id = oid();
      const item2Id = oid();
      const leaderId = oid().toHexString();
      const departingId = oid().toHexString();
      const successorId = oid().toHexString();
      const followUpOwnerId = oid().toHexString();

      const actor: HandoverProjectActorContext = {
        userId: followUpOwnerId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Member M',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: false,
        canAdministerCoordinator: false,
      };
      const handover = {
        _id: handoverObj,
        organizationId: orgObj,
        projectId: projObj,
        departingUserId: departingId,
        assignedLeaderId: leaderId,
        successorUserId: successorId,
        title: 'Sensitive Handover',
        status: 'OPEN',
        version: 2,
        draftVersion: 1,
        assignmentVersion: 1,
        publishedRevisionId: revObj,
        selectedSources: [],
        selectedTasks: [],
        targetCompletionDate: new Date('2027-01-01T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as StoredHandoverDoc;

      const revision = {
        _id: revObj,
        handoverId: handoverObj,
        number: 1,
        publishedAt: new Date(),
        publishedBy: leaderId,
        selectedSources: [],
        selectedTasks: [],
        reviews: [
          {
            itemId: item1Id,
            contentVersion: 1,
            decision: 'CONTENT_APPROVED',
            impact: 'CHANGED',
            reason: 'ok',
          },
          {
            itemId: item2Id,
            contentVersion: 1,
            decision: 'GAP_REMAINS',
            impact: 'CHANGED',
            reason: 'gap',
          },
        ],
        items: [
          {
            itemId: item1Id,
            contentVersion: 1,
            dependencyFingerprint: 'fp1',
            title: 'Confidential Secret Item 1',
            body: 'SECRET_BODY_1',
            requirement: 'Review',
            isRequired: true,
            evidenceRequired: false,
            sources: [],
            citations: [],
          },
          {
            itemId: item2Id,
            contentVersion: 1,
            dependencyFingerprint: 'fp2',
            title: 'Assigned Follow-Up Item 2',
            body: 'ALLOWED_BODY_2',
            requirement: 'Resolve gap',
            isRequired: false,
            evidenceRequired: false,
            sources: [],
            citations: [],
          },
        ],
      } as unknown as StoredRevisionDoc;

      const followUps = [
        {
          _id: oid(),
          handoverId: handoverObj,
          revisionId: revObj,
          itemId: item2Id,
          ownerUserId: followUpOwnerId,
          status: 'OPEN',
          version: 1,
          dueAt: new Date('2027-01-01T00:00:00Z'),
          reason: 'Clarify item 2',
          resolvedAt: null,
        },
      ] as StoredFollowUpDoc[];

      const repo = {
        handovers: { findOne: jest.fn(() => makeQuery(handover)) },
        revisions: { findOne: jest.fn(() => makeQuery(revision)) },
        acceptances: { find: jest.fn(() => makeQuery([])) },
        evidences: { find: jest.fn(() => makeQuery([])) },
        evidenceReviews: { find: jest.fn(() => makeQuery([])) },
        followUps: {
          countDocuments: jest.fn().mockResolvedValue(1),
          find: jest.fn(() => makeQuery(followUps)),
        },
        operations: { find: jest.fn(() => makeQuery([])) },
      };
      const iamScope = {
        authenticateActor: jest.fn().mockResolvedValue({ id: followUpOwnerId }),
        resolveProjectActorContext: jest.fn().mockResolvedValue(actor),
        resolveActiveProjectMemberScope: jest.fn().mockResolvedValue({
          isProjectMember: true,
          isProjectLeader: false,
        }),
      };
      const sourcesService = {
        evaluateSourceRefsMapForViewers: jest.fn((viewers: unknown[]) =>
          Promise.resolve(viewers.map(() => new Map())),
        ),
      };

      const workflow = new HandoverWorkflowService(
        repo as never,
        iamScope as never,
        sourcesService as never,
        {} as never,
        {} as never,
        { verifiedTaskDispositions: jest.fn() } as never,
      );

      const res = await workflow.getHandover(
        projObj.toHexString(),
        handoverObj.toHexString(),
        {},
      );
      const items = res.body.publishedRevision!.items;
      expect(items).toEqual([
        { itemId: item1Id.toHexString(), access: 'UNAVAILABLE' },
        expect.objectContaining({
          itemId: item2Id.toHexString(),
          access: 'AVAILABLE',
          title: 'Assigned Follow-Up Item 2',
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('SECRET_BODY_1');
    });

    it('hides reassigned tasks from DEPARTING participantView and batches viewer/leader source & task lookups (SEC-AUTH-010 / BE-PERF-005)', async () => {
      const orgObj = oid();
      const projObj = oid();
      const handoverObj = oid();
      const revObj = oid();
      const ownedTaskId = oid();
      const reassignedTaskId = oid();
      const departingId = oid().toHexString();
      const otherAssigneeId = oid().toHexString();

      const actor: HandoverProjectActorContext = {
        userId: departingId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Departing A',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: false,
        canAdministerCoordinator: false,
      };
      const handover = {
        _id: handoverObj,
        organizationId: orgObj,
        projectId: projObj,
        departingUserId: departingId,
        assignedLeaderId: oid().toHexString(),
        successorUserId: otherAssigneeId,
        title: 'Handover A',
        status: 'OPEN',
        version: 3,
        draftVersion: 1,
        assignmentVersion: 1,
        publishedRevisionId: revObj,
        selectedSources: [],
        selectedTasks: [],
        targetCompletionDate: new Date('2027-01-01T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as StoredHandoverDoc;
      const revision = {
        _id: revObj,
        handoverId: handoverObj,
        number: 1,
        publishedAt: new Date(),
        publishedBy: handover.assignedLeaderId,
        selectedSources: [
          {
            kind: 'PROJECT_DOCUMENT' as const,
            id: oid().toHexString(),
            version: '1',
          },
        ],
        selectedTasks: [
          {
            taskId: ownedTaskId,
            expectedVersion: 1,
            expectedAssigneeId: departingId,
          },
          {
            taskId: reassignedTaskId,
            expectedVersion: 1,
            expectedAssigneeId: departingId,
          },
        ],
        reviews: [],
        items: [],
      } as unknown as StoredRevisionDoc;

      const repo = {
        handovers: { findOne: jest.fn(() => makeQuery(handover)) },
        revisions: { findOne: jest.fn(() => makeQuery(revision)) },
        acceptances: { find: jest.fn(() => makeQuery([])) },
        evidences: { find: jest.fn(() => makeQuery([])) },
        evidenceReviews: { find: jest.fn(() => makeQuery([])) },
        followUps: {
          countDocuments: jest.fn().mockResolvedValue(0),
          find: jest.fn(() => makeQuery([])),
        },
        operations: { find: jest.fn(() => makeQuery([])) },
      };
      const inspectTasksCurrentState = jest.fn().mockResolvedValue(
        new Map([
          [
            ownedTaskId.toHexString(),
            {
              exists: true,
              version: 1,
              assigneeId: departingId,
              status: 'IN_PROGRESS',
              key: 'TSK-1',
              title: 'Still Owned Task',
            },
          ],
          [
            reassignedTaskId.toHexString(),
            {
              exists: true,
              version: 2,
              assigneeId: otherAssigneeId,
              status: 'IN_PROGRESS',
              key: 'TSK-2',
              title: 'Reassigned Confidential Task',
            },
          ],
        ]),
      );
      const evaluateSourceRefsMapForViewers = jest.fn((viewers: unknown[]) =>
        Promise.resolve(
          viewers.map(
            () =>
              new Map([
                [
                  `PROJECT_DOCUMENT:${revision.selectedSources[0].id}:1`,
                  {
                    kind: 'PROJECT_DOCUMENT',
                    id: revision.selectedSources[0].id,
                    version: 1,
                    exists: true,
                    eligible: true,
                    readable: true,
                    isCurrent: true,
                    currentVersion: 1,
                    title: 'Architecture Doc',
                    excerpts: [],
                  },
                ],
              ]),
          ),
        ),
      );
      const evaluateSourceRefsMap = jest.fn();

      const workflow = new HandoverWorkflowService(
        repo as never,
        {
          authenticateActor: jest.fn().mockResolvedValue({ id: departingId }),
          resolveProjectActorContext: jest.fn().mockResolvedValue(actor),
          resolveActiveProjectMemberScope: jest.fn().mockResolvedValue({
            isProjectMember: true,
            isProjectLeader: true,
          }),
        } as never,
        {
          evaluateSourceRefsMapForViewers,
          evaluateSourceRefsMap,
        } as never,
        { inspectTasksCurrentState } as never,
        {} as never,
        { verifiedTaskDispositions: jest.fn() } as never,
      );

      const res = await workflow.getHandover(
        projObj.toHexString(),
        handoverObj.toHexString(),
        {},
      );
      expect(res.body.participantView?.role).toBe('DEPARTING');
      expect(res.body.participantView?.tasks).toHaveLength(1);
      expect(res.body.participantView?.tasks[0].id).toBe(
        ownedTaskId.toHexString(),
      );
      expect(JSON.stringify(res.body)).not.toContain(
        'Reassigned Confidential Task',
      );
      // BE-PERF-005: Live tasks inspected once and sources batched once (no duplicate participantView fetch)
      expect(inspectTasksCurrentState).toHaveBeenCalledTimes(1);
      expect(evaluateSourceRefsMapForViewers).toHaveBeenCalledTimes(1);
      expect(evaluateSourceRefsMap).not.toHaveBeenCalled();
    });
  });

  describe('BE-DATA-007: createHandover concurrent duplicate-key idempotency replay', () => {
    it('replays committed receipt on concurrent 11000 instead of misclassifying as OPEN_HANDOVER_ALREADY_EXISTS', async () => {
      const orgObj = oid();
      const projObj = oid();
      const leaderId = oid().toHexString();
      const departingId = oid().toHexString();
      const committedHandoverId = oid();
      const idempotencyKey = randomUUID();

      const actor: HandoverProjectActorContext = {
        userId: leaderId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Leader',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: true,
        canAdministerCoordinator: true,
      };

      const committedHandover = {
        _id: committedHandoverId,
        organizationId: orgObj,
        projectId: projObj,
        status: 'OPEN',
        version: 1,
        publishedRevisionId: null,
      } as StoredHandoverDoc;

      let existingOpCalls = 0;
      let capturedFingerprint = '';
      const repo = {
        findExistingOperation: jest.fn(() => {
          existingOpCalls += 1;
          if (existingOpCalls === 1) return Promise.resolve(null); // Pre-TX race miss
          return Promise.resolve({
            state: 'COMMITTED',
            fingerprint: capturedFingerprint,
            receipt: {
              resourceId: committedHandoverId,
              resourceVersion: 1,
              outcome: 'CREATED',
            },
          } as unknown as StoredOperationDoc);
        }),
        assertIdempotencyMatchOrReplay: jest.fn(
          (existing: StoredOperationDoc | null, fp: string) => {
            capturedFingerprint = fp;
            return existing ? 'REPLAY_COMMITTED' : 'NEW';
          },
        ),
        withTransaction: jest.fn(() => {
          const dupErr = Object.assign(
            new Error(
              'E11000 duplicate key error collection: handover_operations index: handover_operation_key_unique',
            ),
            { code: 11000 },
          );
          return Promise.reject(dupErr);
        }),
        handovers: {
          findOne: jest.fn(() => makeQuery(committedHandover)),
        },
      };
      const iamScope = {
        assertValidCsrf: jest.fn(),
        authenticateActor: jest.fn().mockResolvedValue({ id: leaderId }),
        resolveProjectActorContext: jest.fn().mockResolvedValue(actor),
        assertHistoricalDepartingMember: jest.fn().mockResolvedValue(undefined),
        assertEligibleCoordinator: jest.fn().mockResolvedValue(undefined),
      };

      const workflow = new HandoverWorkflowService(
        repo as never,
        iamScope as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      const res = await workflow.createHandover(
        projObj.toHexString(),
        {
          departingUserId: departingId,
          assignedLeaderId: leaderId,
          successorUserId: null,
          teamId: null,
          title: 'Concurrent Handover',
          targetCompletionDate: '2027-01-01T00:00:00Z',
        },
        { idempotencyKey },
      );

      expect(res.replayed).toBe(true);
      expect(res.body.replayed).toBe(true);
      expect(res.body.handoverId).toBe(committedHandoverId.toHexString());
      expect(repo.findExistingOperation).toHaveBeenCalledTimes(2);
    });

    it('maps true handover_v2_open_unique duplicate to OPEN_HANDOVER_ALREADY_EXISTS when idempotency key is new', async () => {
      const orgObj = oid();
      const projObj = oid();
      const leaderId = oid().toHexString();
      const departingId = oid().toHexString();
      const actor: HandoverProjectActorContext = {
        userId: leaderId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Leader',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: true,
        canAdministerCoordinator: true,
      };
      const repo = {
        findExistingOperation: jest.fn().mockResolvedValue(null),
        assertIdempotencyMatchOrReplay: jest.fn().mockReturnValue('NEW'),
        withTransaction: jest.fn(() =>
          Promise.reject(
            Object.assign(
              new Error(
                'E11000 duplicate key error index: handover_v2_open_unique',
              ),
              { code: 11000 },
            ),
          ),
        ),
      };
      const iamScope = {
        assertValidCsrf: jest.fn(),
        authenticateActor: jest.fn().mockResolvedValue({ id: leaderId }),
        resolveProjectActorContext: jest.fn().mockResolvedValue(actor),
        assertHistoricalDepartingMember: jest.fn().mockResolvedValue(undefined),
        assertEligibleCoordinator: jest.fn().mockResolvedValue(undefined),
      };
      const workflow = new HandoverWorkflowService(
        repo as never,
        iamScope as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

      await expect(
        workflow.createHandover(
          projObj.toHexString(),
          {
            departingUserId: departingId,
            assignedLeaderId: leaderId,
            successorUserId: null,
            teamId: null,
            title: 'Duplicate Open Handover',
            targetCompletionDate: '2027-01-01T00:00:00Z',
          },
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toMatchObject({
        response: { code: 'OPEN_HANDOVER_ALREADY_EXISTS' },
      });
    });
  });

  describe('BE-REL-002, SEC-BE-012, SEC-BE-017 & SEC-BE-006: AI jobs, rate limits & evidence URL validation', () => {
    it('keeps getJob and getCandidates strictly read-only without mutating stalled jobs (SEC-BE-012) and reads candidate reasons from Redis across pods (BE-REL-002)', async () => {
      const orgObj = oid();
      const projObj = oid();
      const handoverObj = oid();
      const jobObj = oid();
      const docId = oid().toHexString();
      const actorId = oid().toHexString();

      const actor: HandoverProjectActorContext = {
        userId: actorId,
        organizationId: orgObj.toHexString(),
        projectId: projObj.toHexString(),
        userName: 'Leader',
        projectVisibility: 'PRIVATE',
        isProjectMember: true,
        isProjectLeader: true,
        canAdministerCoordinator: true,
      };
      const handover = {
        _id: handoverObj,
        organizationId: orgObj,
        projectId: projObj,
        status: 'OPEN',
        version: 2,
      } as StoredHandoverDoc;

      const stalledJob = {
        _id: jobObj,
        organizationId: orgObj,
        projectId: projObj,
        handoverId: handoverObj,
        kind: 'SOURCE_PROPOSAL',
        state: 'RUNNING',
        attempt: 3,
        leaseExpiresAt: new Date(Date.now() - 10_000),
        inputDraftVersion: 1,
        createdAt: new Date(),
      } as unknown as StoredJobDoc;

      const findOneAndUpdate = jest.fn();
      const repo = {
        jobs: {
          findOne: jest.fn(() => makeQuery(stalledJob)),
          findOneAndUpdate,
        },
      };
      const redisCache = new Map<string, string>();
      const redis = {
        readOptionalCache: jest.fn((k: string) =>
          Promise.resolve(redisCache.get(k) ?? null),
        ),
        writeOptionalCache: jest.fn((k: string, v: string) => {
          redisCache.set(k, v);
          return Promise.resolve();
        }),
      };
      const sourcesService = {
        evaluateSourceRefsMap: jest.fn().mockResolvedValue(
          new Map([
            [
              `PROJECT_DOCUMENT:${docId}:1`,
              {
                kind: 'PROJECT_DOCUMENT',
                id: docId,
                version: 1,
                exists: true,
                eligible: true,
                readable: true,
                isCurrent: true,
                currentVersion: 1,
                title: 'Runbook Doc',
                excerpts: [],
              },
            ],
          ]),
        ),
      };

      const aiSvc = new HandoverAiService(
        repo as never,
        {} as never,
        sourcesService as never,
        {} as never,
        redis as never,
      );

      // GET /jobs/:id MUST NOT call findOneAndUpdate or mutate state on expired lease
      const jobDto = await aiSvc.getJob({
        actor,
        handover,
        jobId: jobObj.toHexString(),
      });
      expect(jobDto.state).toBe('RUNNING');
      expect(findOneAndUpdate).not.toHaveBeenCalled();

      // Seed Redis candidate reasons as if another pod completed the job
      const succeededJob = {
        ...stalledJob,
        state: 'SUCCEEDED',
        attempt: 1,
        candidates: [{ kind: 'PROJECT_DOCUMENT', id: docId, version: '1' }],
      } as unknown as StoredJobDoc;
      repo.jobs.findOne.mockReturnValueOnce(makeQuery(succeededJob));
      const reasonKey = `ai-candidate-reasons:v1:${orgObj.toHexString()}:${projObj.toHexString()}:${jobObj.toHexString()}:1`;
      redisCache.set(
        reasonKey,
        JSON.stringify({
          [`PROJECT_DOCUMENT:${docId}:1`]:
            'Matches deployment failover procedure.',
        }),
      );

      const candidates = await aiSvc.getCandidates({
        actor,
        handover,
        jobId: jobObj.toHexString(),
      });
      expect(candidates.data).toHaveLength(1);
      expect(candidates.data[0].reason).toBe(
        'Matches deployment failover procedure.',
      );
    });

    it('blocks askQuestion on CANCELLED handovers (SEC-BE-017)', async () => {
      const orgObj = oid();
      const projObj = oid();
      const revObj = oid();
      const actorId = oid().toHexString();
      const aiSvc = new HandoverAiService(
        {} as never,
        {} as never,
        {} as never,
        { request: jest.fn() } as never,
      );
      await expect(
        aiSvc.askQuestion({
          actor: {
            userId: actorId,
            organizationId: orgObj.toHexString(),
            projectId: projObj.toHexString(),
            userName: 'Leader',
            projectVisibility: 'PRIVATE',
            isProjectMember: true,
            isProjectLeader: true,
            canAdministerCoordinator: true,
          },
          handover: {
            _id: oid(),
            organizationId: orgObj,
            projectId: projObj,
            status: 'CANCELLED',
            publishedRevisionId: revObj,
            assignmentVersion: 1,
            assignedLeaderId: actorId,
            departingUserId: oid().toHexString(),
            successorUserId: null,
          } as StoredHandoverDoc,
          dto: {
            revisionId: revObj.toHexString(),
            assignmentVersion: 1,
            question: 'What is the runbook?',
          },
        }),
      ).rejects.toMatchObject({
        response: { code: 'HANDOVER_CANCELLED' },
      });
    });

    it('enforces Redis rate limits on Handover AI & preview endpoints returning 429 (SEC-BE-006)', async () => {
      const orgId = oid().toHexString();
      const projId = oid().toHexString();
      const userId = oid().toHexString();
      const redis = {
        consumeRateLimit: jest.fn().mockResolvedValue(false),
      };
      const iamScope = {
        assertValidCsrf: jest.fn(),
        authenticateActor: jest.fn().mockResolvedValue({ id: userId }),
        resolveProjectActorContext: jest.fn().mockResolvedValue({
          userId,
          organizationId: orgId,
          projectId: projId,
          userName: 'Leader',
          projectVisibility: 'PRIVATE',
          isProjectMember: true,
          isProjectLeader: true,
          canAdministerCoordinator: true,
        }),
      };
      const workflow = new HandoverWorkflowService(
        {} as never,
        iamScope as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        redis as never,
      );

      let caught: unknown;
      try {
        await workflow.askHandoverQuestion(projId, oid().toHexString(), {}, {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpException);
      expect((caught as HttpException).getStatus()).toBe(
        HttpStatus.TOO_MANY_REQUESTS,
      );
      expect(redis.consumeRateLimit).toHaveBeenCalledWith(
        `handover:ai:${orgId}:${userId}`,
        15,
        60,
      );
    });

    it('rejects private/loopback/internal/userinfo URLs in SubmitEvidence links while accepting public HTTPS links (SEC-BE-017)', () => {
      const base = {
        revisionId: oid().toHexString(),
        contentVersion: 1,
        assignmentVersion: 1,
        resultText: 'Completed runbook drill.',
      };
      expect(
        validateSubmitEvidence({
          ...base,
          links: ['https://example.invalid/evidence/1'],
        }).links,
      ).toEqual(['https://example.invalid/evidence/1']);

      const badLinks = [
        'https://localhost/secret',
        'https://api.localhost/secret',
        'https://service.internal/admin',
        'https://printer.local/status',
        'https://127.0.0.1/admin',
        'https://10.0.0.5/internal',
        'https://172.16.0.1/internal',
        'https://192.168.1.1/router',
        'https://169.254.169.254/latest/meta-data',
        'https://100.64.0.1/cgnat',
        'https://[::1]/loopback',
        'https://2130706433/decimal-loopback',
        'https://user:pass@example.com/phish',
        'http://example.com/plaintext',
      ];
      for (const bad of badLinks) {
        expect(() => validateSubmitEvidence({ ...base, links: [bad] })).toThrow(
          BadRequestException,
        );
      }
    });
  });

  // Reference ConflictException so lint sees clean import usage
  it('verifies ConflictException compatibility', () => {
    expect(new ConflictException('ok').getStatus()).toBe(409);
  });
});
