import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { HandoverWorkflowService } from './handover-workflow.service';
import { sourceRefKey } from './handover.domain';
import type { HandoverProjectActorContext } from '../../iam/application/projects/handover-iam-scope.service';
import type { StoredFollowUpDoc, StoredHandoverDoc } from './handover.types';

function query<T>(value: T) {
  const q = {
    sort: () => q,
    limit: () => q,
    lean: () => q,
    exec: () => Promise.resolve(value),
  };
  return q;
}

function setup(readable: boolean, replay = false, missingItem = false) {
  const oid = () => new Types.ObjectId();
  const actor = {
    userId: oid().toHexString(),
    organizationId: oid().toHexString(),
    projectId: oid().toHexString(),
    userName: 'Leader',
    projectVisibility: 'PRIVATE',
    isProjectMember: true,
    isProjectLeader: true,
    canAdministerCoordinator: true,
  } satisfies HandoverProjectActorContext;
  const handover = {
    _id: oid(),
    organizationId: new Types.ObjectId(actor.organizationId),
    projectId: new Types.ObjectId(actor.projectId),
    version: 7,
    status: 'COMPLETED',
    successorUserId: oid().toHexString(),
    assignedLeaderId: actor.userId,
    departingUserId: oid().toHexString(),
    publishedRevisionId: oid(),
  } as StoredHandoverDoc;
  const doc = {
    _id: oid(),
    handoverId: handover._id,
    revisionId: oid(),
    itemId: oid(),
    ownerUserId: actor.userId,
    dueAt: new Date(),
    reason: 'PRIVATE_FOLLOW_UP_REASON',
    status: 'OPEN',
    version: 1,
    resolvedAt: null,
  } as StoredFollowUpDoc;
  const ref = {
    kind: 'PROJECT_DOCUMENT' as const,
    id: oid().toHexString(),
    version: '1',
  };
  const revision = {
    _id: doc.revisionId,
    handoverId: handover._id,
    items: missingItem
      ? []
      : [
          {
            itemId: doc.itemId,
            sources: [],
            citations: [
              { source: ref, locator: { kind: 'SECTION', value: 'private' } },
            ],
          },
        ],
  };
  const repo = {
    revisions: { findOne: jest.fn(() => query(revision)) },
    followUps: {
      countDocuments: jest.fn(() => Promise.resolve(1)),
      find: jest.fn(() => query([doc])),
      findOne: jest.fn(() => query(doc)),
      findOneAndUpdate: jest.fn(() =>
        query({ ...doc, status: 'RESOLVED', version: 2 }),
      ),
    },
    findExistingOperation: jest.fn(() =>
      Promise.resolve(
        replay
          ? { receipt: { followUpId: doc._id, resourceVersion: 2 } }
          : null,
      ),
    ),
    assertIdempotencyMatchOrReplay: jest.fn(() =>
      replay ? 'REPLAY_COMMITTED' : 'PROCEED',
    ),
    createOrClaimCommandOperation: jest.fn(() => Promise.resolve()),
    appendAuditAndOutbox: jest.fn(() => Promise.resolve()),
    withTransaction: <T>(fn: (s: null) => Promise<T>) => fn(null),
  };
  const sources = {
    evaluateSourceRefsMap: jest.fn(() =>
      Promise.resolve(
        new Map([
          [
            sourceRefKey(ref),
            {
              eligible: true,
              readable,
              isCurrent: false,
            },
          ],
        ]),
      ),
    ),
  };
  const service = new HandoverWorkflowService(
    repo as never,
    {} as never,
    sources as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const internal = service as unknown as {
    resolveActor: () => Promise<HandoverProjectActorContext>;
    loadHandoverOrNotFound: () => Promise<StoredHandoverDoc>;
  };
  jest.spyOn(internal, 'resolveActor').mockResolvedValue(actor);
  jest.spyOn(internal, 'loadHandoverOrNotFound').mockResolvedValue(handover);
  return { service, actor, handover, doc, repo, sources };
}

describe('Follow-up live dependency ACL (R2-BE02)', () => {
  it.each([false, true])(
    'filters list by historical citation-only dependency, readable=%s',
    async (readable) => {
      const f = setup(readable);
      const result = await f.service.listHandoverFollowUps(
        f.actor.projectId,
        f.handover._id.toHexString(),
        {},
        {},
      );
      expect(f.sources.evaluateSourceRefsMap).toHaveBeenCalledTimes(1);
      expect(f.repo.revisions.findOne).toHaveBeenCalledWith({
        _id: f.doc.revisionId,
        handoverId: f.handover._id,
      });
      expect(result.body.data).toHaveLength(readable ? 1 : 0);
      if (!readable)
        expect(JSON.stringify(result)).not.toContain(
          'PRIVATE_FOLLOW_UP_REASON',
        );
    },
  );

  it('fails closed when the historical item is missing', async () => {
    const f = setup(true, false, true);
    const result = await f.service.listHandoverFollowUps(
      f.actor.projectId,
      f.handover._id.toHexString(),
      {},
      {},
    );
    expect(result.body.data).toEqual([]);
  });

  it.each([false, true])(
    'checks dependency ACL before resolution or receipt replay, replay=%s',
    async (replay) => {
      const f = setup(false, replay);
      await expect(
        f.service.resolveHandoverFollowUp(
          f.actor.projectId,
          f.handover._id.toHexString(),
          f.doc._id.toHexString(),
          { resolutionNote: 'Done', references: [] },
          {
            idempotencyKey: randomUUID(),
            ifMatch: `"handover-followup:${f.doc._id.toHexString()}:1"`,
          },
        ),
      ).rejects.toMatchObject({
        response: { code: 'ITEM_DEPENDENCY_UNAVAILABLE' },
      });
      expect(f.repo.followUps.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('keeps historical readable follow-up resolution available after completion', async () => {
    const f = setup(true);
    const result = await f.service.resolveHandoverFollowUp(
      f.actor.projectId,
      f.handover._id.toHexString(),
      f.doc._id.toHexString(),
      { resolutionNote: 'Done', references: [] },
      {
        idempotencyKey: randomUUID(),
        ifMatch: `"handover-followup:${f.doc._id.toHexString()}:1"`,
      },
    );
    expect(result.body.status).toBe('RESOLVED');
    expect(result.etag).toBe(
      `"handover-followup:${f.doc._id.toHexString()}:2"`,
    );
  });

  it('does not leak reason through an optional-exception receipt replay', async () => {
    const f = setup(false, true);
    await expect(
      f.service.acceptOptionalHandoverGap(
        f.actor.projectId,
        f.handover._id.toHexString(),
        f.doc.itemId.toHexString(),
        {
          revisionId: f.doc.revisionId.toHexString(),
          contentVersion: 1,
          ownerUserId: f.actor.userId,
          dueAt: '2027-01-01T00:00:00Z',
          reason: 'Original reason',
        },
        {
          idempotencyKey: randomUUID(),
          ifMatch: `"handover:${f.handover._id.toHexString()}:7"`,
        },
      ),
    ).rejects.toMatchObject({
      response: { code: 'ITEM_DEPENDENCY_UNAVAILABLE' },
    });
  });
});
