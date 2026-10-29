import { Types } from 'mongoose';
import { HandoverCaptureSourceService } from '../../capture/application/handover-capture-source.service';
import { HandoverLifecycleSourceService } from '../../lifecycle/application/handover-lifecycle-source.service';

describe('Handover Capture & Lifecycle Source Boundary Contracts (C04 / A03 / A04 / A13)', () => {
  const orgId = new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d10');
  const projectId = new Types.ObjectId('751a2b3c4d5e6f7a8b9c0d20');
  const leaderId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d31');
  const departingId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d32');
  const memberBId = new Types.ObjectId('851a2b3c4d5e6f7a8b9c0d33');
  const docId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d41');
  const reportId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d42');
  const noteId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d43');
  const koId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d44');

  it('evaluates Capture sources under strict current ACL without Manager bypass and detects CHANGED versions', async () => {
    const collections: Record<string, Array<Record<string, unknown>>> = {
      project_documents: [
        {
          _id: docId,
          organizationId: orgId,
          projectId,
          title: 'Deployment Architecture',
          status: 'APPROVED',
          currentVersionNumber: 2,
          latestApprovedVersionNumber: 2,
          createdByUserId: departingId,
        },
      ],
      project_document_versions: [
        {
          _id: new Types.ObjectId(),
          organizationId: orgId,
          projectId,
          documentId: docId,
          versionNumber: 1,
          title: 'Deployment Architecture v1',
          content: 'Initial canary rollout rules.',
          status: 'APPROVED',
          editedByUserId: departingId,
        },
        {
          _id: new Types.ObjectId(),
          organizationId: orgId,
          projectId,
          documentId: docId,
          versionNumber: 2,
          title: 'Deployment Architecture v2',
          content: 'Updated canary rollout rules with 15m bake time.',
          status: 'APPROVED',
          editedByUserId: departingId,
        },
      ],
      work_reports: [
        {
          _id: reportId,
          organizationId: orgId,
          projectId,
          memberUserId: departingId,
          reportScope: 'MEMBER',
          status: 'APPROVED',
          accomplishments: 'Completed Q3 payment gateway migration.',
          approach: 'Blue-green cutover.',
          reason: 'Zero downtime SLA.',
          blockers: 'None',
          nextSteps: 'Monitor webhook retries.',
          periodStart: new Date('2026-10-01T00:00:00Z'),
          periodEnd: new Date('2026-10-07T00:00:00Z'),
        },
      ],
      work_notes: [
        {
          _id: noteId,
          organizationId: orgId,
          projectId,
          taskId: new Types.ObjectId(),
          authorUserId: departingId,
          title: 'Webhook retry tuning',
          whatDone: 'Added exponential jitter',
          howSolved: 'Decorrelated jitter backoff',
          whyThisWay: 'Avoid thundering herd',
          status: 'CONFIRMED',
          deletedAt: null,
        },
      ],
      work_note_versions: [],
    };

    const idStr = (val: unknown): string => {
      if (val instanceof Types.ObjectId) return val.toHexString();
      if (typeof val === 'string') return val;
      return '';
    };

    const connection = {
      db: {
        collection: (name: string) => ({
          findOne: jest.fn((filter: Record<string, unknown>) => {
            const rows = collections[name] ?? [];
            return Promise.resolve(
              rows.find((r) => {
                if (filter._id && idStr(r._id) !== idStr(filter._id))
                  return false;
                if (
                  filter.documentId &&
                  idStr(r.documentId) !== idStr(filter.documentId)
                )
                  return false;
                if (
                  filter.versionNumber !== undefined &&
                  r.versionNumber !== filter.versionNumber
                )
                  return false;
                return true;
              }) ?? null,
            );
          }),
          find: jest.fn((filter: Record<string, unknown>) => {
            const rows = (collections[name] ?? []).filter((r) => {
              if (
                filter.organizationId &&
                idStr(r.organizationId) !== idStr(filter.organizationId)
              )
                return false;
              if (
                filter.projectId &&
                idStr(r.projectId) !== idStr(filter.projectId)
              )
                return false;
              if (
                filter.workNoteId &&
                idStr(r.workNoteId) !== idStr(filter.workNoteId)
              )
                return false;
              return true;
            });
            return {
              sort: () => ({
                limit: () => ({ toArray: () => Promise.resolve(rows) }),
              }),
              limit: () => ({ toArray: () => Promise.resolve(rows) }),
              toArray: () => Promise.resolve(rows),
            };
          }),
        }),
      },
    };

    const svc = new HandoverCaptureSourceService(connection as never);

    // 1. Version 1 of Project Document is readable by Member B, but isCurrent=false (sourceState: CHANGED)
    const docV1ForB = await svc.evaluateSource(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: memberBId.toHexString(),
        isProjectMember: true,
        isProjectLeader: false,
      },
      { kind: 'PROJECT_DOCUMENT', id: docId.toHexString(), version: 1 },
    );
    expect(docV1ForB.readable).toBe(true);
    expect(docV1ForB.isCurrent).toBe(false);
    expect(docV1ForB.currentVersion).toBe(2);

    // 2. Member Work Report of departing A is readable by Leader D, NOT readable by Member B (A04)
    const reportForD = await svc.evaluateSource(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: leaderId.toHexString(),
        isProjectMember: true,
        isProjectLeader: true,
      },
      { kind: 'WORK_REPORT', id: reportId.toHexString(), version: 1 },
    );
    expect(reportForD.readable).toBe(true);

    const reportForB = await svc.evaluateSource(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: memberBId.toHexString(),
        isProjectMember: true,
        isProjectLeader: false,
      },
      { kind: 'WORK_REPORT', id: reportId.toHexString(), version: 1 },
    );
    expect(reportForB.readable).toBe(false);

    // 3. Candidate discovery never returns TASK_NOTE (official knowledge only)
    const candidates = await svc.discoverCandidateSources(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: leaderId.toHexString(),
        isProjectMember: true,
        isProjectLeader: true,
      },
      departingId.toHexString(),
      'deployment',
      20,
    );
    expect(candidates.some((c) => c.kind === 'TASK_NOTE')).toBe(false);
    expect(candidates.some((c) => c.kind === 'PROJECT_DOCUMENT')).toBe(true);
  });

  it('enforces Lifecycle KNOWLEDGE_OBJECT VERIFIED state and RESTRICTED confidentiality (A04 / A13)', async () => {
    const koRow = {
      _id: koId,
      organizationId: orgId,
      projectId,
      title: 'Production Incident Escalation Runbook',
      status: 'VERIFIED',
      currentVersionNumber: 1,
      ownerUserId: departingId.toHexString(),
      confidentiality: 'RESTRICTED',
    };
    const verRow = {
      _id: new Types.ObjectId(),
      organizationId: orgId,
      projectId,
      knowledgeObjectId: koId,
      versionNumber: 1,
      title: 'Production Incident Escalation Runbook',
      contentMarkdown: 'Escalate SEV-1 incidents to on-call lead.',
      summary: 'SEV-1 escalation steps',
    };

    const connection = {
      db: {
        collection: (name: string) => ({
          findOne: jest.fn(() =>
            Promise.resolve(name === 'knowledge_objects' ? koRow : verRow),
          ),
          find: jest.fn(() => ({
            sort: () => ({
              limit: () => ({ toArray: () => Promise.resolve([koRow]) }),
            }),
          })),
        }),
      },
    };

    const lifecycleSvc = new HandoverLifecycleSourceService(
      connection as never,
    );

    const forLeader = await lifecycleSvc.evaluateSource(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: leaderId.toHexString(),
        isProjectMember: true,
        isProjectLeader: true,
      },
      { kind: 'KNOWLEDGE_OBJECT', id: koId.toHexString(), version: 1 },
    );
    expect(forLeader.readable).toBe(true);

    const forMemberB = await lifecycleSvc.evaluateSource(
      {
        organizationId: orgId.toHexString(),
        projectId: projectId.toHexString(),
        userId: memberBId.toHexString(),
        isProjectMember: true,
        isProjectLeader: false,
      },
      { kind: 'KNOWLEDGE_OBJECT', id: koId.toHexString(), version: 1 },
    );
    expect(forMemberB.readable).toBe(false);
  });

  it('never leaks newer v2 content when evaluating pinned v1 of TASK_NOTE or WORK_REPORT (F03)', async () => {
    const noteId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d91');
    const reapprovedReportId = new Types.ObjectId('951a2b3c4d5e6f7a8b9c0d92');
    const createdAt = new Date('2026-10-01T00:00:00Z');
    const updatedAt = new Date('2026-10-10T00:00:00Z');

    const noteLiveV2 = {
      _id: noteId,
      organizationId: orgId,
      projectId,
      status: 'CONFIRMED',
      deletedAt: null,
      title: 'Worker Retry Note v2 (MUTATED)',
      whatDone: 'Replaced backoff with fixed circuit breaker in v2',
      howSolved: 'v2 solution',
      whyThisWay: 'v2 reason',
      authorConfirmedAt: createdAt,
      createdAt,
      updatedAt,
    };
    const noteVersions = [
      {
        _id: new Types.ObjectId(),
        workNoteId: noteId,
        versionNumber: 1,
        title: 'Worker Retry Note v1 (PINNED)',
        whatDone: 'Implemented exponential jitter in v1',
        howSolved: 'v1 solution',
        whyThisWay: 'v1 reason',
      },
      {
        _id: new Types.ObjectId(),
        workNoteId: noteId,
        versionNumber: 2,
        title: 'Worker Retry Note v2 (MUTATED)',
        whatDone: 'Replaced backoff with fixed circuit breaker in v2',
        howSolved: 'v2 solution',
        whyThisWay: 'v2 reason',
      },
    ];
    const reportLiveV2 = {
      _id: reapprovedReportId,
      organizationId: orgId,
      projectId,
      memberUserId: departingId,
      reportScope: 'MEMBER',
      status: 'APPROVED',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      accomplishments: 'Updated v2 report accomplishments',
      reviewHistory: [{ action: 'APPROVED' }, { action: 'APPROVED' }],
    };

    const connection = {
      db: {
        collection: (name: string) => ({
          findOne: jest.fn(() => {
            if (name === 'work_notes') return Promise.resolve(noteLiveV2);
            if (name === 'work_reports') return Promise.resolve(reportLiveV2);
            return Promise.resolve(null);
          }),
          find: jest.fn(() => ({
            toArray: () =>
              Promise.resolve(
                name === 'work_note_versions' ? noteVersions : [],
              ),
          })),
        }),
      },
    };

    const svc = new HandoverCaptureSourceService(connection as never);
    const leaderViewer = {
      organizationId: orgId.toHexString(),
      projectId: projectId.toHexString(),
      userId: leaderId.toHexString(),
      isProjectMember: true,
      isProjectLeader: true,
    };

    const pinnedNoteV1 = await svc.evaluateSource(leaderViewer, {
      kind: 'TASK_NOTE',
      id: noteId.toHexString(),
      version: 1,
    });
    expect(pinnedNoteV1.eligible).toBe(true);
    expect(pinnedNoteV1.readable).toBe(true);
    expect(pinnedNoteV1.isCurrent).toBe(false);
    expect(pinnedNoteV1.currentVersion).toBe(2);
    expect(pinnedNoteV1.title).toBe('Worker Retry Note v1 (PINNED)');
    expect(pinnedNoteV1.excerpts[0].content).toBe(
      'Implemented exponential jitter in v1',
    );
    expect(pinnedNoteV1.excerpts.some((e) => e.content.includes('v2'))).toBe(
      false,
    );

    // WORK_REPORT has no historical text snapshots: pinned v1 after re-approval to v2 MUST fail closed as unavailable
    const pinnedReportV1 = await svc.evaluateSource(leaderViewer, {
      kind: 'WORK_REPORT',
      id: reapprovedReportId.toHexString(),
      version: 1,
    });
    expect(pinnedReportV1.exists).toBe(true);
    expect(pinnedReportV1.eligible).toBe(false);
    expect(pinnedReportV1.readable).toBe(false);
    expect(pinnedReportV1.currentVersion).toBe(2);
    expect(pinnedReportV1.excerpts).toEqual([]);
  });
});
