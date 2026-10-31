import { Mongoose, Types } from 'mongoose';
import { createCollectionSchema } from './mongodb.schemas';
import { CAPTURE_PERSISTENCE } from '../persistence';

describe('Private Task Note assessment persistence', () => {
  const createdAt = new Date('2026-10-29T00:00:00.000Z');
  const expiresAt = new Date('2026-10-30T00:00:00.000Z');
  const Model = new Mongoose().model(
    'AssessmentDraft',
    createCollectionSchema(
      CAPTURE_PERSISTENCE.collections.find(
        (c) => c.name === 'work_note_agent_drafts',
      )!,
    ),
  );
  const assessment = () => ({
    schemaVersion: 'task-note-assessment/v1',
    id: 'b3e837e9-c421-4b81-89e7-323c16c2736c',
    revision: 1,
    sourceRevision: 1,
    answers: [],
    trace: [],
    reviewerSemanticAssessment: 'NOT_ESTABLISHED',
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const row = (state: object = {}) => ({
    _id: 'private-draft',
    workflow: 'TASK_NOTE',
    organizationId: new Types.ObjectId(),
    projectId: new Types.ObjectId(),
    ownerUserId: new Types.ObjectId(),
    taskId: new Types.ObjectId(),
    revision: 1,
    baseNoteVersion: 0,
    state,
    createdAt,
    expiresAt,
  });
  it('keeps old drafts without assessment valid and allows versioned private state', () => {
    expect(new Model(row()).validateSync()).toBeUndefined();
    expect(
      new Model(row({ assessment: assessment() })).validateSync(),
    ).toBeUndefined();
  });
  it('rejects an unsupported assessment schema and shared-workflow assessment', () => {
    expect(
      new Model(
        row({ assessment: { ...assessment(), schemaVersion: 'unknown' } }),
      ).validateSync()?.errors.state,
    ).toBeDefined();
    expect(
      new Model({
        ...row({ assessment: assessment() }),
        workflow: 'PROJECT_DOCUMENT',
        taskId: undefined,
      }).validateSync()?.errors.state,
    ).toBeDefined();
  });
  it('caps private assessment and draft expiry at the original absolute 24-hour deadline', () => {
    expect(
      new Model(
        row({
          assessment: {
            ...assessment(),
            expiresAt: '2026-10-30T00:00:01.000Z',
          },
        }),
      ).validateSync()?.errors.state,
    ).toBeDefined();
    expect(
      new Model({
        ...row(),
        expiresAt: new Date('2026-10-30T00:00:01.000Z'),
      }).validateSync()?.errors.expiresAt,
    ).toBeDefined();
  });
  it('does not admit raw content in metadata-only assessment traces', () => {
    expect(
      new Model(
        row({
          assessment: {
            ...assessment(),
            trace: [
              {
                phase: 'analyzed',
                reasonCode: 'READY',
                at: createdAt.toISOString(),
                rawContent: 'private source',
              },
            ],
          },
        }),
      ).validateSync()?.errors.state,
    ).toBeDefined();
  });
  it('accepts only provisional analyzing revision0 and bounded metadata feedback', () => {
    expect(
      new Model(
        row({
          assessment: { ...assessment(), state: 'analyzing', revision: 0 },
        }),
      ).validateSync(),
    ).toBeUndefined();
    expect(
      new Model(
        row({
          assessment: { ...assessment(), state: 'ready_to_edit', revision: 0 },
        }),
      ).validateSync()?.errors.state,
    ).toBeDefined();
    expect(
      new Model(
        row({
          assessment: {
            ...assessment(),
            feedback: [
              { category: 'FALSE_SUFFICIENT', at: createdAt.toISOString() },
            ],
          },
        }),
      ).validateSync(),
    ).toBeUndefined();
    expect(
      new Model(
        row({
          assessment: {
            ...assessment(),
            feedback: [
              { category: 'SEMANTIC_SUCCESS', at: createdAt.toISOString() },
            ],
          },
        }),
      ).validateSync()?.errors.state,
    ).toBeDefined();
  });
});
