import { Types } from 'mongoose';
import { HandoverCaptureSourceService } from './handover-capture-source.service';

describe('Handover Task Note immutable pinning (R2-BE03)', () => {
  it.each([false, true])(
    'never assigns an invented version to repeated live edits (has snapshot=%s)',
    async (withHistory) => {
      const base = new Date('2026-10-01T00:00:00Z');
      const note = {
        _id: new Types.ObjectId(),
        status: 'CONFIRMED',
        title: 'Original',
        whatDone: 'Original',
        howSolved: '',
        whyThisWay: '',
        blocker: '',
        unfinished: '',
        nextStep: '',
        authorConfirmedAt: base,
        createdAt: base,
        updatedAt: base,
      };
      const history = withHistory ? [{ ...note, versionNumber: 1 }] : [];
      const db = {
        collection: () => ({
          findOne: () => Promise.resolve(note),
          find: () => ({ toArray: () => Promise.resolve(history) }),
        }),
      };
      const svc = new HandoverCaptureSourceService({ db } as never);
      const viewer = {
        organizationId: new Types.ObjectId().toHexString(),
        projectId: new Types.ObjectId().toHexString(),
        userId: new Types.ObjectId().toHexString(),
        isProjectMember: true,
        isProjectLeader: true,
      };
      const read = (version: number) =>
        svc.evaluateSource(viewer, {
          kind: 'TASK_NOTE',
          id: note._id.toHexString(),
          version,
        });
      expect((await read(1)).readable).toBe(true);
      for (const edit of ['EDIT_2', 'EDIT_3']) {
        note.whatDone = edit;
        note.updatedAt = new Date(note.updatedAt.getTime() + 1000);
        note.authorConfirmedAt = note.updatedAt;
        const result = await read(2);
        expect(result.readable).toBe(false);
        expect(result.excerpts).toEqual([]);
        const pinned = await read(1);
        expect(pinned.readable).toBe(withHistory);
        expect(pinned.isCurrent).toBe(false);
        expect(JSON.stringify(pinned)).not.toContain(edit);
      }
    },
  );

  it('detects a change in fields beyond the original four-field snapshot comparison', async () => {
    const note = {
      _id: new Types.ObjectId(),
      status: 'CONFIRMED',
      title: 'Snapshot',
      whatDone: 'Done',
      howSolved: '',
      whyThisWay: '',
      blocker: 'NEW_BLOCKER',
    };
    const history = [{ ...note, blocker: 'OLD_BLOCKER', versionNumber: 1 }];
    const db = {
      collection: () => ({
        findOne: () => Promise.resolve(note),
        find: () => ({ toArray: () => Promise.resolve(history) }),
      }),
    };
    const svc = new HandoverCaptureSourceService({ db } as never);
    const result = await svc.evaluateSource(
      {
        organizationId: new Types.ObjectId().toHexString(),
        projectId: new Types.ObjectId().toHexString(),
        userId: new Types.ObjectId().toHexString(),
        isProjectMember: true,
        isProjectLeader: true,
      },
      { kind: 'TASK_NOTE', id: note._id.toHexString(), version: 1 },
    );
    expect(result.readable).toBe(true);
    expect(result.isCurrent).toBe(false);
    expect(JSON.stringify(result)).toContain('OLD_BLOCKER');
    expect(JSON.stringify(result)).not.toContain('NEW_BLOCKER');
  });

  it('extracts excerpts from v2 contentMarkdown for TASK_NOTE and WORK_REPORT and detects v2 live divergence', async () => {
    const viewer = {
      organizationId: new Types.ObjectId().toHexString(),
      projectId: new Types.ObjectId().toHexString(),
      userId: new Types.ObjectId().toHexString(),
      isProjectMember: true,
      isProjectLeader: true,
    };
    const note = {
      _id: new Types.ObjectId(),
      status: 'CONFIRMED',
      title: 'Redis Fence v2',
      contentSchemaVersion: 2,
      contentMarkdown: '## Root cause\n\nImplemented monotonic userFence.',
      currentVersionNumber: 1,
    };
    const noteSnapshots = [
      {
        workNoteId: note._id,
        versionNumber: 1,
        title: 'Redis Fence v2',
        contentSchemaVersion: 2,
        contentMarkdown: '## Root cause\n\nImplemented monotonic userFence.',
      },
    ];
    const report = {
      _id: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(viewer.userId),
      reportScope: 'MEMBER',
      status: 'APPROVED',
      periodStart: new Date('2026-10-20T00:00:00Z'),
      title: 'Sprint 4 Handover Report',
      contentSchemaVersion: 2,
      currentVersionNumber: 1,
      contentMarkdown:
        '## Handover Summary\n\nToken rotation migrated cleanly.',
      reviewHistory: [{ action: 'APPROVED' }],
    };
    const db = {
      collection: (name: string) => ({
        findOne: () => Promise.resolve(name === 'work_reports' ? report : note),
        find: () => ({ toArray: () => Promise.resolve(noteSnapshots) }),
      }),
    };
    const svc = new HandoverCaptureSourceService({ db } as never);

    const evaluatedNote = await svc.evaluateSource(viewer, {
      kind: 'TASK_NOTE',
      id: note._id.toHexString(),
      version: 1,
    });
    expect(evaluatedNote.readable).toBe(true);
    expect(evaluatedNote.isCurrent).toBe(true);
    expect(evaluatedNote.excerpts.map((e) => e.content).join(' ')).toContain(
      'Implemented monotonic userFence.',
    );

    note.contentMarkdown = 'Unversioned live edit';
    const afterLiveEdit = await svc.evaluateSource(viewer, {
      kind: 'TASK_NOTE',
      id: note._id.toHexString(),
      version: 1,
    });
    expect(afterLiveEdit.readable).toBe(true);
    expect(afterLiveEdit.isCurrent).toBe(false);

    const evaluatedReport = await svc.evaluateSource(viewer, {
      kind: 'WORK_REPORT',
      id: report._id.toHexString(),
      version: 1,
    });
    expect(evaluatedReport.readable).toBe(true);
    expect(evaluatedReport.title).toBe('Sprint 4 Handover Report');
    expect(evaluatedReport.excerpts.map((e) => e.content).join(' ')).toContain(
      'Token rotation migrated cleanly.',
    );
  });

  it('uses Capture-persisted Work Report version instead of reviewHistory approval count', async () => {
    const viewer = {
      organizationId: new Types.ObjectId().toHexString(),
      projectId: new Types.ObjectId().toHexString(),
      userId: new Types.ObjectId().toHexString(),
      isProjectMember: true,
      isProjectLeader: true,
    };
    const reportV3 = {
      _id: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(viewer.userId),
      reportScope: 'MEMBER',
      status: 'APPROVED',
      periodStart: new Date('2026-10-20T00:00:00Z'),
      title: 'Sprint 4 Handover Report v3',
      contentSchemaVersion: 2,
      currentVersionNumber: 3,
      contentMarkdown:
        '## Handover Summary v3\n\nApproved after three draft revisions.',
      reviewHistory: [{ action: 'APPROVED' }],
    };
    const reportSnapshots = [
      {
        reportId: reportV3._id,
        versionNumber: 1,
        title: 'Sprint 4 Handover Report v1',
        contentMarkdown: 'Draft v1',
      },
      {
        reportId: reportV3._id,
        versionNumber: 2,
        title: 'Sprint 4 Handover Report v2',
        contentMarkdown: 'Draft v2',
      },
      {
        reportId: reportV3._id,
        versionNumber: 3,
        title: 'Sprint 4 Handover Report v3',
        contentMarkdown:
          '## Handover Summary v3\n\nApproved after three draft revisions.',
      },
    ];
    const db = {
      collection: (name: string) => ({
        findOne: () =>
          Promise.resolve(name === 'work_reports' ? reportV3 : null),
        find: () => ({
          limit: () => ({
            toArray: () =>
              Promise.resolve(name === 'work_reports' ? [reportV3] : []),
          }),
          toArray: () =>
            Promise.resolve(
              name === 'work_report_versions' ? reportSnapshots : [],
            ),
        }),
      }),
    };
    const svc = new HandoverCaptureSourceService({ db } as never);

    const rejectedV1 = await svc.evaluateSource(viewer, {
      kind: 'WORK_REPORT',
      id: reportV3._id.toHexString(),
      version: 1,
    });
    expect(rejectedV1.exists).toBe(true);
    expect(rejectedV1.eligible).toBe(false);
    expect(rejectedV1.readable).toBe(false);
    expect(rejectedV1.currentVersion).toBe(3);
    expect(rejectedV1.excerpts).toEqual([]);

    const acceptedV3 = await svc.evaluateSource(viewer, {
      kind: 'WORK_REPORT',
      id: reportV3._id.toHexString(),
      version: 3,
    });
    expect(acceptedV3.eligible).toBe(true);
    expect(acceptedV3.readable).toBe(true);
    expect(acceptedV3.isCurrent).toBe(true);
    expect(acceptedV3.version).toBe(3);
    expect(acceptedV3.currentVersion).toBe(3);
    expect(acceptedV3.title).toBe('Sprint 4 Handover Report v3');
    expect(acceptedV3.excerpts.map((e) => e.content).join(' ')).toContain(
      'Approved after three draft revisions.',
    );

    const candidates = await svc.discoverCandidateSources(
      viewer,
      viewer.userId,
      '',
      10,
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        kind: 'WORK_REPORT',
        id: reportV3._id.toHexString(),
        version: 3,
        currentVersion: 3,
      }),
    ]);
  });

  it('keeps a legacy pin unavailable when backfill reuses its version number', async () => {
    const viewer = {
      organizationId: new Types.ObjectId().toHexString(),
      projectId: new Types.ObjectId().toHexString(),
      userId: new Types.ObjectId().toHexString(),
      isProjectMember: true,
      isProjectLeader: true,
    };
    const report = {
      _id: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(viewer.userId),
      status: 'APPROVED',
      accomplishments: 'Original approved content',
      reviewHistory: [{ action: 'APPROVED' }],
    };
    const snapshots: Record<string, unknown>[] = [];
    const db = {
      collection: () => ({
        findOne: () => Promise.resolve(report),
        find: () => ({ toArray: () => Promise.resolve(snapshots) }),
      }),
    };
    const svc = new HandoverCaptureSourceService({ db } as never);
    const readPin = (version: number) =>
      svc.evaluateSource(viewer, {
        kind: 'WORK_REPORT',
        id: report._id.toHexString(),
        version,
      });

    expect((await readPin(1)).excerpts[0]?.content).toBe(
      'Original approved content',
    );
    report.accomplishments = 'Newly reapproved content';
    report.reviewHistory.push({ action: 'APPROVED' });
    expect((await readPin(1)).readable).toBe(false);
    expect((await readPin(2)).readable).toBe(true);

    // The editor backfill creates its first snapshot without using approval count.
    const contentMarkdown = '## Accomplishments\nNewly reapproved content';
    Object.assign(report, {
      contentSchemaVersion: 2,
      currentVersionNumber: 1,
      title: 'Backfilled report',
      contentMarkdown,
    });
    snapshots.push({
      reportId: report._id,
      versionNumber: 1,
      title: 'Backfilled report',
      contentMarkdown,
    });

    expect(await readPin(1)).toMatchObject({
      eligible: false,
      readable: false,
      isCurrent: false,
      excerpts: [],
    });
  });

  it('never serves a newer unapproved snapshot read after an approved Work Report', async () => {
    const viewer = {
      organizationId: new Types.ObjectId().toHexString(),
      projectId: new Types.ObjectId().toHexString(),
      userId: new Types.ObjectId().toHexString(),
      isProjectMember: true,
      isProjectLeader: true,
    };
    const approved = {
      _id: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(viewer.userId),
      status: 'APPROVED',
      title: 'Approved v2',
      contentSchemaVersion: 2,
      currentVersionNumber: 2,
      contentMarkdown: 'Approved v2 content',
      reviewHistory: [{ action: 'APPROVED' }],
    };
    const snapshots = [
      {
        reportId: approved._id,
        versionNumber: 2,
        title: approved.title,
        contentMarkdown: approved.contentMarkdown,
      },
      {
        reportId: approved._id,
        versionNumber: 3,
        title: 'Unapproved v3',
        contentMarkdown: 'Unapproved v3 content',
        canonicalResult: { status: 'CHANGES_REQUESTED' },
      },
    ];
    const db = {
      collection: () => ({
        findOne: () => Promise.resolve(approved),
        find: () => ({ toArray: () => Promise.resolve(snapshots) }),
      }),
    };
    const svc = new HandoverCaptureSourceService({ db } as never);
    const readPin = (version: number) =>
      svc.evaluateSource(viewer, {
        kind: 'WORK_REPORT',
        id: approved._id.toHexString(),
        version,
      });

    expect(await readPin(3)).toMatchObject({
      eligible: false,
      readable: false,
      currentVersion: 2,
      excerpts: [],
    });
    expect(await readPin(2)).toMatchObject({
      eligible: true,
      readable: true,
      isCurrent: true,
      excerpts: [expect.objectContaining({ content: 'Approved v2 content' })],
    });
  });
});
