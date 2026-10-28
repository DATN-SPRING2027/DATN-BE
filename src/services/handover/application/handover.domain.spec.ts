import { Types } from 'mongoose';
import type { EvaluatedHandoverSource } from '../../capture/application/handover-capture-source.service';
import {
  computeDependencyFingerprint,
  deriveTaskIntentId,
  evaluateCarriedItemAcceptances,
  evaluateCompletionReadiness,
  projectRevisionItemForViewer,
  resolveItemBindingState,
  sourceRefKey,
} from './handover.domain';
import type {
  StoredAcceptanceDoc,
  StoredHandoverDoc,
  StoredHandoverItemSnapshot,
  StoredRevisionDoc,
} from './handover.types';

describe('Handover Domain Invariants (A04, A05, A06, A07, A08, A11, A13, A15)', () => {
  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');
  const handoverId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d30');
  const rev1Id = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d40');
  const rev2Id = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d41');
  const item1Id = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d51');
  const item2Id = new Types.ObjectId('a51a2b3c4d5e6f7a8b9c0d52');
  const leaderD = '111111111111111111111111';
  const departingA = '222222222222222222222222';
  const succB1 = '333333333333333333333333';

  const sourceDoc = {
    kind: 'PROJECT_DOCUMENT' as const,
    id: '444444444444444444444444',
    version: '1',
  };

  function makeItem(
    id: Types.ObjectId,
    overrides: Partial<StoredHandoverItemSnapshot> = {},
  ): StoredHandoverItemSnapshot {
    const base = {
      itemId: id,
      contentVersion: 1,
      title: 'Runbook section',
      body: 'Sensitive deployment instructions',
      requirement: 'Demonstrate rollback procedure',
      isRequired: true,
      evidenceRequired: false,
      sources: [sourceDoc],
      citations: [
        {
          source: sourceDoc,
          locator: { kind: 'SECTION' as const, value: 'sec-1' },
        },
      ],
      ...overrides,
    };
    return {
      ...base,
      dependencyFingerprint:
        overrides.dependencyFingerprint ??
        computeDependencyFingerprint({
          sources: base.sources,
          citations: base.citations,
          isRequired: base.isRequired,
          evidenceRequired: base.evidenceRequired,
        }),
    };
  }

  it('projects UnavailableItem with ONLY { itemId, access: UNAVAILABLE } when source ACL fails (A04 / A13)', () => {
    const item = makeItem(item1Id);
    const unreadableMap = new Map<string, EvaluatedHandoverSource>([
      [
        sourceRefKey(sourceDoc),
        {
          kind: 'PROJECT_DOCUMENT',
          id: sourceDoc.id,
          version: 1,
          exists: true,
          eligible: true,
          readable: false,
          isCurrent: true,
          currentVersion: 1,
          title: 'Secret doc',
          excerpts: [],
        },
      ],
    ]);

    const projected = projectRevisionItemForViewer({
      item,
      contentReviewDecision: 'CONTENT_APPROVED',
      bindingState: {
        latestItemAcceptance: null,
        latestEvidence: null,
        latestEvidenceReview: null,
        hasAcceptedOptionalException: false,
      },
      viewerSourceMap: unreadableMap,
    });

    expect(projected).toEqual({
      itemId: item1Id.toHexString(),
      access: 'UNAVAILABLE',
    });
    expect(Object.keys(projected)).toEqual(['itemId', 'access']);
  });

  it('carries UNCHANGED item acceptance across revisions with provenance, never carries CHANGED items or B1->B2->B1 epochs (A05 / A06)', () => {
    const itemUnchanged = makeItem(item1Id, { contentVersion: 1 });
    const itemChanged = makeItem(item2Id, {
      contentVersion: 2,
      body: 'Updated runbook steps',
    });
    const prevItemChanged = makeItem(item2Id, { contentVersion: 1 });

    const prevRev: StoredRevisionDoc = {
      _id: rev1Id,
      schemaVersion: 2,
      organizationId: orgId,
      projectId,
      handoverId,
      number: 1,
      draftVersion: 1,
      assignmentVersion: 1,
      successorUserId: succB1,
      items: [itemUnchanged, prevItemChanged],
      selectedSources: [sourceDoc],
      selectedTasks: [],
      reviews: [
        {
          itemId: item1Id,
          contentVersion: 1,
          decision: 'CONTENT_APPROVED',
          impact: 'CHANGED',
          reason: 'Initial',
        },
        {
          itemId: item2Id,
          contentVersion: 1,
          decision: 'CONTENT_APPROVED',
          impact: 'CHANGED',
          reason: 'Initial',
        },
      ],
      gaps: [],
      publishedBy: leaderD,
      publishedAt: new Date(),
      sourceFingerprint: 'a'.repeat(64),
      reviewNote: 'Rev 1',
      createdAt: new Date(),
    };

    const acc1Id = new Types.ObjectId();
    const acc2Id = new Types.ObjectId();
    const prevAcceptances: StoredAcceptanceDoc[] = [
      {
        _id: acc1Id,
        schemaVersion: 2,
        organizationId: orgId,
        projectId,
        handoverId,
        revisionId: rev1Id,
        successorUserId: succB1,
        assignmentVersion: 1,
        kind: 'ITEM',
        itemId: item1Id,
        contentVersion: 1,
        dependencyFingerprint: itemUnchanged.dependencyFingerprint,
        decision: 'UNDERSTOOD',
        note: 'Clear',
        commandId: new Types.ObjectId(),
        sequence: 1,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
      {
        _id: acc2Id,
        schemaVersion: 2,
        organizationId: orgId,
        projectId,
        handoverId,
        revisionId: rev1Id,
        successorUserId: succB1,
        assignmentVersion: 1,
        kind: 'ITEM',
        itemId: item2Id,
        contentVersion: 1,
        dependencyFingerprint: prevItemChanged.dependencyFingerprint,
        decision: 'UNDERSTOOD',
        note: 'Clear',
        commandId: new Types.ObjectId(),
        sequence: 2,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
    ];

    const readableMap = new Map<string, EvaluatedHandoverSource>([
      [
        sourceRefKey(sourceDoc),
        {
          kind: 'PROJECT_DOCUMENT',
          id: sourceDoc.id,
          version: 1,
          exists: true,
          eligible: true,
          readable: true,
          isCurrent: true,
          currentVersion: 1,
          title: 'Doc',
          excerpts: [],
        },
      ],
    ]);

    const carriedSameEpoch = evaluateCarriedItemAcceptances({
      previousRevision: prevRev,
      newItems: [itemUnchanged, itemChanged],
      reviews: [
        {
          itemId: item1Id.toHexString(),
          contentVersion: 1,
          decision: 'CONTENT_APPROVED',
          impact: 'UNCHANGED',
        },
        {
          itemId: item2Id.toHexString(),
          contentVersion: 2,
          decision: 'CONTENT_APPROVED',
          impact: 'CHANGED',
        },
      ],
      successorUserId: succB1,
      assignmentVersion: 1,
      previousAcceptances: prevAcceptances,
      successorSourceMap: readableMap,
    });

    expect(carriedSameEpoch).toHaveLength(1);
    expect(carriedSameEpoch[0].item.itemId.toHexString()).toBe(
      item1Id.toHexString(),
    );
    expect(carriedSameEpoch[0].carriedFromAcceptanceId.toHexString()).toBe(
      acc1Id.toHexString(),
    );

    // B1 -> B2 -> B1 (assignmentVersion is now 3): MUST NOT carry old B1 epoch=1 acceptance!
    const carriedAfterReassign = evaluateCarriedItemAcceptances({
      previousRevision: prevRev,
      newItems: [itemUnchanged, itemChanged],
      reviews: [
        {
          itemId: item1Id.toHexString(),
          contentVersion: 1,
          decision: 'CONTENT_APPROVED',
          impact: 'UNCHANGED',
        },
      ],
      successorUserId: succB1,
      assignmentVersion: 3,
      previousAcceptances: prevAcceptances,
      successorSourceMap: readableMap,
    });
    expect(carriedAfterReassign).toHaveLength(0);

    // Also verify resolveItemBindingState ignores epoch 1 when current assignmentVersion is 3
    const bindingAtEpoch3 = resolveItemBindingState({
      revisionId: rev1Id.toHexString(),
      successorUserId: succB1,
      assignmentVersion: 3,
      item: itemUnchanged,
      acceptances: prevAcceptances,
      evidences: [],
      evidenceReviews: [],
      followUps: [],
    });
    expect(bindingAtEpoch3.latestItemAcceptance).toBeNull();
  });

  it('enforces completion guards: blocks unresolved required items or unexcepted optional gaps, allows TODO/IN_PROGRESS tasks once transfer is CONFIRMED (A07, A08, A11, A15)', () => {
    const reqItem = makeItem(item1Id, { isRequired: true });
    const optItem = makeItem(item2Id, { isRequired: false });
    const task1Id = new Types.ObjectId('b51a2b3c4d5e6f7a8b9c0d61');

    const handover: StoredHandoverDoc = {
      _id: handoverId,
      schemaVersion: 2,
      organizationId: orgId,
      projectId,
      departingUserId: departingA,
      assignedLeaderId: leaderD,
      successorUserId: succB1,
      title: 'Handover',
      targetCompletionDate: new Date(),
      status: 'OPEN',
      version: 4,
      draftVersion: 1,
      assignmentVersion: 1,
      publishedRevisionId: rev2Id,
      selectedSources: [sourceDoc],
      selectedTasks: [
        { taskId: task1Id, expectedVersion: 1, expectedAssigneeId: departingA },
      ],
      createdBy: leaderD,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const currentRevision: StoredRevisionDoc = {
      _id: rev2Id,
      schemaVersion: 2,
      organizationId: orgId,
      projectId,
      handoverId,
      number: 1,
      draftVersion: 1,
      assignmentVersion: 1,
      successorUserId: succB1,
      items: [reqItem, optItem],
      selectedSources: [sourceDoc],
      selectedTasks: handover.selectedTasks,
      reviews: [
        {
          itemId: item1Id,
          contentVersion: 1,
          decision: 'CONTENT_APPROVED',
          impact: 'CHANGED',
          reason: 'Approved',
        },
        {
          itemId: item2Id,
          contentVersion: 1,
          decision: 'GAP_REMAINS',
          impact: 'CHANGED',
          reason: 'Minor optional appendix missing',
        },
      ],
      gaps: [
        {
          itemId: item2Id,
          ownerUserId: leaderD,
          dueAt: new Date('2026-12-01T00:00:00Z'),
          reason: 'Appendix pending',
        },
      ],
      publishedBy: leaderD,
      publishedAt: new Date(),
      sourceFingerprint: 'b'.repeat(64),
      reviewNote: 'Published',
      createdAt: new Date(),
    };

    const readableMap = new Map<string, EvaluatedHandoverSource>([
      [
        sourceRefKey(sourceDoc),
        {
          kind: 'PROJECT_DOCUMENT',
          id: sourceDoc.id,
          version: 1,
          exists: true,
          eligible: true,
          readable: true,
          isCurrent: true,
          currentVersion: 1,
          title: 'Doc',
          excerpts: [],
        },
      ],
    ]);

    const acceptances: StoredAcceptanceDoc[] = [
      {
        _id: new Types.ObjectId(),
        schemaVersion: 2,
        organizationId: orgId,
        projectId,
        handoverId,
        revisionId: rev2Id,
        successorUserId: succB1,
        assignmentVersion: 1,
        kind: 'PACKAGE',
        decision: 'ACCEPTED',
        note: '',
        commandId: new Types.ObjectId(),
        sequence: 1,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
      {
        _id: new Types.ObjectId(),
        schemaVersion: 2,
        organizationId: orgId,
        projectId,
        handoverId,
        revisionId: rev2Id,
        successorUserId: succB1,
        assignmentVersion: 1,
        kind: 'ITEM',
        itemId: item1Id,
        contentVersion: 1,
        dependencyFingerprint: reqItem.dependencyFingerprint,
        decision: 'UNDERSTOOD',
        note: 'Got it',
        commandId: new Types.ObjectId(),
        sequence: 2,
        occurredAt: new Date(),
        createdAt: new Date(),
      },
    ];

    // Without optional exception or task transfer -> blocked!
    const blocked = evaluateCompletionReadiness({
      handover,
      currentRevision,
      acceptances,
      evidences: [],
      evidenceReviews: [],
      followUps: [],
      transferOperations: [],
      transferChildOperations: [],
      leaderSourceMap: readableMap,
      successorSourceMap: readableMap,
    });
    expect(blocked.canComplete).toBe(false);
    expect(
      blocked.blockers.some(
        (b) => b.code === 'OPTIONAL_ITEM_UNRESOLVED_WITHOUT_EXCEPTION',
      ),
    ).toBe(true);
    expect(
      blocked.blockers.some(
        (b) => b.code === 'SELECTED_TASK_TRANSFER_NOT_CONFIRMED',
      ),
    ).toBe(true);

    // With accepted optional exception + CONFIRMED task transfer -> ready even if task product status is TODO!
    const parentTransferId = new Types.ObjectId();
    const ready = evaluateCompletionReadiness({
      handover,
      currentRevision,
      acceptances,
      evidences: [],
      evidenceReviews: [],
      followUps: [
        {
          _id: new Types.ObjectId(),
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          revisionId: rev2Id,
          itemId: item2Id,
          kind: 'KNOWLEDGE_GAP',
          isRequired: false,
          ownerUserId: leaderD,
          reason: 'Optional background appendix',
          dueAt: new Date('2026-12-01T00:00:00Z'),
          status: 'OPEN',
          version: 1,
          createdBy: leaderD,
          resolvedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      transferOperations: [
        {
          _id: parentTransferId,
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          actorUserId: leaderD,
          namespace: `handover:${handoverId.toHexString()}`,
          key: deriveTaskIntentId(
            parentTransferId.toHexString(),
            handoverId.toHexString(),
          ),
          fingerprint: 'c'.repeat(64),
          kind: 'TASK_TRANSFER',
          state: 'COMMITTED',
          expectedVersion: 4,
          assignmentVersion: 1,
          revisionId: rev2Id,
          successorUserId: succB1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      transferChildOperations: [
        {
          _id: new Types.ObjectId(),
          schemaVersion: 2,
          organizationId: orgId,
          projectId,
          handoverId,
          actorUserId: leaderD,
          namespace: `transfer-child:${parentTransferId.toHexString()}`,
          key: deriveTaskIntentId(
            parentTransferId.toHexString(),
            task1Id.toHexString(),
          ),
          fingerprint: 'd'.repeat(64),
          kind: 'TASK_TRANSFER_CHILD',
          state: 'COMMITTED',
          expectedVersion: 4,
          assignmentVersion: 1,
          revisionId: rev2Id,
          successorUserId: succB1,
          parentOperationId: parentTransferId,
          taskIntent: {
            taskId: task1Id,
            expectedVersion: 1,
            expectedAssigneeId: departingA,
            targetUserId: succB1,
          },
          taskOutcome: {
            state: 'COMMITTED',
            taskVersion: 2,
            assigneeId: succB1,
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      leaderSourceMap: readableMap,
      successorSourceMap: readableMap,
    });

    expect(ready.canComplete).toBe(true);
    expect(ready.requiredPendingCount).toBe(0);
    expect(ready.blockers).toHaveLength(0);
  });
});
