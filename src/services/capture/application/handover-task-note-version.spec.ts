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
});
