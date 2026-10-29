import { Types } from 'mongoose';
import type { HandoverProjectActorContext } from '../../iam/application/projects/handover-iam-scope.service';
import type { EvaluatedHandoverSource } from '../../capture/application/handover-capture-source.service';
import { HandoverAiService } from './handover-ai.service';
import {
  computeSourceSelectionFingerprint,
  sourceRefKey,
} from './handover.domain';
import type {
  SourceRefDto,
  StoredHandoverDoc,
  StoredJobDoc,
} from './handover.types';

const oid = () => new Types.ObjectId();
function query<T>(value: T) {
  const chain = {
    session: () => chain,
    lean: () => chain,
    exec: () => Promise.resolve(value),
  };
  return chain;
}

function fixture() {
  const orgId = oid(),
    projectId = oid(),
    handoverId = oid(),
    revisionId = oid();
  const leaderId = oid().toHexString();
  const actor: HandoverProjectActorContext = {
    organizationId: orgId.toHexString(),
    projectId: projectId.toHexString(),
    userId: leaderId,
    userName: 'Leader',
    projectVisibility: 'PRIVATE',
    isProjectMember: true,
    isProjectLeader: true,
    canAdministerCoordinator: true,
  };
  const ref: SourceRefDto = {
    kind: 'PROJECT_DOCUMENT',
    id: oid().toHexString(),
    version: '1',
  };
  const ev: EvaluatedHandoverSource = {
    ...ref,
    version: 1,
    exists: true,
    eligible: true,
    readable: true,
    isCurrent: true,
    currentVersion: 1,
    title: 'Authorized runbook',
    excerpts: [
      {
        locatorKind: 'SECTION',
        locatorValue: 'runbook',
        heading: 'Runbook',
        content: 'Authorized steps',
      },
    ],
  };
  const handover: StoredHandoverDoc = {
    _id: handoverId,
    schemaVersion: 2,
    organizationId: orgId,
    projectId,
    departingUserId: oid().toHexString(),
    assignedLeaderId: leaderId,
    successorUserId: null,
    assignmentVersion: 1,
    version: 1,
    draftVersion: 0,
    title: 'Handover',
    targetCompletionDate: new Date(),
    status: 'OPEN',
    publishedRevisionId: revisionId,
    selectedSources: [ref],
    selectedTasks: [],
    createdBy: leaderId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const job: StoredJobDoc = {
    _id: oid(),
    schemaVersion: 2,
    organizationId: orgId,
    projectId,
    handoverId,
    initiatedBy: leaderId,
    commandId: oid(),
    kind: 'GENERATION',
    state: 'RUNNING',
    inputDraftVersion: 0,
    sourceFingerprint: computeSourceSelectionFingerprint([ref]),
    selectedSources: [ref],
    attempt: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const repo = {
    revisions: {
      findOne: jest.fn(() =>
        query({ _id: revisionId, selectedSources: [ref] }),
      ),
    },
    handovers: {
      findOne: jest.fn(() => query(handover)),
      updateOne: jest.fn(() => Promise.resolve({ matchedCount: 1 })),
    },
    jobs: {
      findOne: jest.fn(() => query(job)),
      updateOne: jest.fn(
        (_filter: unknown, update: { $set?: Partial<StoredJobDoc> }) => {
          Object.assign(job, update.$set);
          return Promise.resolve({ matchedCount: 1 });
        },
      ),
    },
    draftItems: {
      deleteMany: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve([])),
    },
    appendAuditAndOutbox: jest.fn(() => Promise.resolve()),
    withTransaction: <T>(fn: (session: null) => Promise<T>) => fn(null),
  };
  const iam = {
    assertEligibleCoordinator: jest.fn(() => Promise.resolve()),
    resolveActiveProjectMemberScope: jest.fn(() =>
      Promise.resolve({
        isProjectMember: true,
        isProjectLeader: true,
      }),
    ),
  };
  const sources = {
    evaluateSourceRefsMap: jest.fn(() =>
      Promise.resolve(new Map([[sourceRefKey(ref), ev]])),
    ),
  };
  const citation = {
    source: { ...ref, version: 1 },
    locator: { kind: 'SECTION', value: 'runbook' },
  };
  const ai = {
    request: jest.fn(() =>
      Promise.resolve({
        body: {
          task: 'QUESTION_ANSWER',
          answerStatus: 'ANSWERED',
          message: 'PRIVATE_UNCITED_MESSAGE',
          sections: [{ text: 'Authorized steps', citations: [citation] }],
          items: [
            {
              title: 'Runbook',
              body: 'Authorized steps',
              requirement: 'Understand',
              sources: [{ ...ref, version: 1 }],
              citations: [citation],
            },
          ],
          coverage: {
            requestedSources: 1,
            includedSources: [citation.source],
            skippedSources: [],
            truncatedSources: [citation.source],
            totalEvidenceUnits: 25,
            truncated: true,
          },
        },
      }),
    ),
  };
  const service = new HandoverAiService(
    repo as never,
    iam as never,
    sources as never,
    ai as never,
  );
  const internal = service as unknown as {
    claimRunnableJob: (
      id: Types.ObjectId,
      owner: string,
    ) => Promise<StoredJobDoc>;
    runBackgroundJob: (id: Types.ObjectId) => Promise<void>;
  };
  jest.spyOn(internal, 'claimRunnableJob').mockImplementation((_id, owner) => {
    job.leaseOwner = owner;
    return Promise.resolve(job);
  });
  return {
    service,
    internal,
    actor,
    ref,
    ev,
    handover,
    job,
    repo,
    iam,
    sources,
    ai,
  };
}

describe('Handover AI live authorization boundary (review round 2)', () => {
  it('discards all output if an uncited LLM input loses access while another citation remains valid', async () => {
    const f = fixture();
    const extra = { ...f.ref, id: oid().toHexString() };
    f.repo.revisions.findOne.mockReturnValue(
      query({
        _id: f.handover.publishedRevisionId!,
        selectedSources: [f.ref, extra],
      }),
    );
    f.sources.evaluateSourceRefsMap
      .mockResolvedValueOnce(
        new Map([
          [sourceRefKey(f.ref), f.ev],
          [sourceRefKey(extra), { ...f.ev, id: extra.id }],
        ]),
      )
      .mockResolvedValueOnce(
        new Map([
          [sourceRefKey(f.ref), f.ev],
          [sourceRefKey(extra), { ...f.ev, id: extra.id, readable: false }],
        ]),
      );
    const result = await f.service.askQuestion({
      actor: f.actor,
      handover: f.handover,
      dto: {
        revisionId: f.handover.publishedRevisionId!.toHexString(),
        assignmentVersion: 1,
        question: 'How?',
      },
    });
    expect(result.answerStatus).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.sections).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UNCITED_MESSAGE');
  });

  it('does not return an in-flight answer after project membership is revoked', async () => {
    const f = fixture();
    f.iam.resolveActiveProjectMemberScope.mockResolvedValue({
      isProjectMember: false,
      isProjectLeader: false,
    });
    await expect(
      f.service.askQuestion({
        actor: f.actor,
        handover: f.handover,
        dto: {
          revisionId: f.handover.publishedRevisionId!.toHexString(),
          assignmentVersion: 1,
          question: 'How?',
        },
      }),
    ).rejects.toMatchObject({ response: { code: 'HANDOVER_NOT_FOUND' } });
  });

  it.each([false, true])(
    'never forwards ungrounded message; revoked=%s',
    async (revoked) => {
      const f = fixture();
      f.sources.evaluateSourceRefsMap
        .mockResolvedValueOnce(new Map([[sourceRefKey(f.ref), f.ev]]))
        .mockResolvedValueOnce(
          new Map([[sourceRefKey(f.ref), { ...f.ev, readable: !revoked }]]),
        );
      const result = await f.service.askQuestion({
        actor: f.actor,
        handover: f.handover,
        dto: {
          revisionId: f.handover.publishedRevisionId!.toHexString(),
          assignmentVersion: 1,
          question: 'How?',
        },
      });
      expect(JSON.stringify(result)).not.toContain('PRIVATE_UNCITED_MESSAGE');
      expect(result.answerStatus).toBe(
        revoked ? 'INSUFFICIENT_EVIDENCE' : 'ANSWERED',
      );
      expect(result.sections).toHaveLength(revoked ? 0 : 1);
      expect(result).toHaveProperty('warnings', ['AI_EVIDENCE_INCOMPLETE']);
    },
  );

  it.each(['revoked', 'version', 'content', 'unchanged'] as const)(
    'rechecks sources after generation before draft replacement: %s',
    async (change) => {
      const f = fixture();
      const changed = { ...f.ev };
      if (change === 'revoked') changed.readable = false;
      if (change === 'version') {
        changed.currentVersion = 2;
        changed.isCurrent = false;
      }
      if (change === 'content')
        changed.excerpts = [
          { ...f.ev.excerpts[0], content: 'Edited while LLM ran' },
        ];
      f.sources.evaluateSourceRefsMap
        .mockResolvedValueOnce(new Map([[sourceRefKey(f.ref), f.ev]]))
        .mockResolvedValueOnce(new Map([[sourceRefKey(f.ref), changed]]));
      await f.internal.runBackgroundJob(f.job._id);
      expect(f.sources.evaluateSourceRefsMap).toHaveBeenCalledTimes(2);
      expect(f.repo.draftItems.create).toHaveBeenCalledTimes(
        change === 'unchanged' ? 1 : 0,
      );
      expect(f.job.state).toBe(
        change === 'unchanged'
          ? 'SUCCEEDED'
          : change === 'revoked'
            ? 'FAILED'
            : 'SUPERSEDED',
      );
      if (change === 'unchanged')
        expect(f.job.safeErrorCode).toBe('AI_EVIDENCE_INCOMPLETE');
      if (change === 'unchanged') {
        const reloadedService = new HandoverAiService(
          f.repo as never,
          f.iam as never,
          f.sources as never,
          undefined,
        );
        const dto = await reloadedService.getJob({
          handover: f.handover,
          jobId: f.job._id.toHexString(),
        });
        expect(dto.warnings).toEqual(['AI_EVIDENCE_INCOMPLETE']);
      }
    },
  );
});
