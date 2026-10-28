import { createCollectionSchema } from './mongodb.schemas';
import { CAPTURE_PERSISTENCE } from '../persistence';
import { Mongoose, Types } from 'mongoose';
describe('WorkNote Agent owned persistence', () => {
  it('requires a Task only for Task Notes and keeps Document/Report revision histories durable', () => {
    const model = new Mongoose().model(
      'WorkflowDraft',
      createCollectionSchema(
        CAPTURE_PERSISTENCE.collections.find(
          (c) => c.name === 'work_note_agent_drafts',
        )!,
      ),
    );
    const common = {
      _id: 'fixture',
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      ownerUserId: new Types.ObjectId(),
      revision: 1,
      baseNoteVersion: 0,
      state: {},
      expiresAt: new Date(),
    };
    expect(
      new model({ ...common, workflow: 'TASK_NOTE' }).validateSync()?.errors
        .taskId,
    ).toBeDefined();
    expect(
      new model({ ...common, workflow: 'WORK_REPORT' }).validateSync()?.errors
        .resourceId,
    ).toBeDefined();
    expect(
      new model({
        ...common,
        workflow: 'PROJECT_DOCUMENT',
        context: { documentType: 'OTHER' },
      }).validateSync(),
    ).toBeUndefined();
    for (const name of [
      'work_report_versions',
      'project_document_editor_versions',
    ]) {
      const definition = CAPTURE_PERSISTENCE.collections.find(
        (c) => c.name === name,
      )!;
      expect(definition).toBeDefined();
      expect(
        createCollectionSchema(definition)
          .indexes()
          .some(([, o]) => o.expireAfterSeconds !== undefined),
      ).toBe(false);
    }
    expect(
      new model({
        ...common,
        workflow: 'PROJECT_DOCUMENT',
        noteId: new Types.ObjectId(),
      }).validateSync()?.errors.noteId,
    ).toBeDefined();
    expect(
      new model({
        ...common,
        workflow: 'TASK_NOTE',
        taskId: new Types.ObjectId(),
        resourceId: new Types.ObjectId(),
      }).validateSync()?.errors.resourceId,
    ).toBeDefined();
  });
  it('requires canonical body and version instead of accepting an empty version-2 record', () => {
    const schema = createCollectionSchema(
      CAPTURE_PERSISTENCE.collections.find((c) => c.name === 'work_notes')!,
    );
    const Model = new Mongoose().model('CanonicalAgentTest', schema);
    const row = {
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      taskId: new Types.ObjectId(),
      authorUserId: new Types.ObjectId(),
      title: 'Note',
      status: 'CONFIRMED',
      contentSchemaVersion: 2,
      currentVersionNumber: 1,
    };
    expect(new Model(row).validateSync()?.errors.contentMarkdown).toBeDefined();
    expect(
      new Model({
        ...row,
        contentMarkdown: 'Body',
        currentVersionNumber: undefined,
      }).validateSync()?.errors.currentVersionNumber,
    ).toBeDefined();
  });
  it('keeps transient draft/operations on exact expiry TTL and durable versions without TTL', () => {
    for (const name of [
      'work_note_agent_drafts',
      'work_note_agent_operations',
    ]) {
      const definition = CAPTURE_PERSISTENCE.collections.find(
        (c) => c.name === name,
      )!;
      expect(definition).toBeDefined();
      expect(createCollectionSchema(definition).indexes()).toEqual(
        expect.arrayContaining([
          [
            { expiresAt: 1 },
            expect.objectContaining({ expireAfterSeconds: 0 }),
          ],
        ]),
      );
    }
    const note = createCollectionSchema(
      CAPTURE_PERSISTENCE.collections.find((c) => c.name === 'work_notes')!,
    );
    expect(note.path('contentMarkdown')).toBeDefined();
    expect(note.path('currentVersionNumber')).toBeDefined();
    expect(
      note.indexes().some(([, o]) => o.expireAfterSeconds !== undefined),
    ).toBe(false);
  });
});
