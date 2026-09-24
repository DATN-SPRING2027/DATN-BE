import { Schema } from 'mongoose';
import { WORK_MANAGEMENT_PERSISTENCE } from '../persistence';

const objectId = { type: Schema.Types.ObjectId, required: true };
const immutableObjectId = {
  type: Schema.Types.ObjectId,
  required: true,
  immutable: true,
};

function withCollectionIndexes(schema: Schema, collectionName: string): Schema {
  const collection = WORK_MANAGEMENT_PERSISTENCE.collections.find(
    ({ name }) => name === collectionName,
  );

  if (!collection) {
    throw new Error(`Unknown Continuum Work collection: ${collectionName}`);
  }

  for (const index of collection.indexes ?? []) {
    schema.index(index.fields, index.options);
  }

  return schema;
}

export const workItemSchema = withCollectionIndexes(
  new Schema(
    {
      organizationId: objectId,
      projectId: objectId,
      title: { type: String, required: true, trim: true, maxlength: 200 },
      description: { type: String, default: '', maxlength: 20000 },
      status: {
        type: String,
        enum: ['TODO', 'IN_PROGRESS', 'DONE'],
        default: 'TODO',
        required: true,
      },
      priority: {
        type: String,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        default: 'MEDIUM',
        required: true,
      },
      assigneeId: { type: Schema.Types.ObjectId, default: null },
      dueDate: { type: Date, default: null },
      labels: { type: [String], default: [] },
      createdBy: objectId,
      archivedAt: { type: Date, default: null },
    },
    {
      collection: 'work_items',
      timestamps: true,
      strict: true,
      optimisticConcurrency: true,
      versionKey: 'revision',
    },
  ),
  'work_items',
);

export const workItemCommentSchema = withCollectionIndexes(
  new Schema(
    {
      organizationId: objectId,
      projectId: objectId,
      workItemId: objectId,
      authorId: objectId,
      body: { type: String, required: true, trim: true, maxlength: 10000 },
      editedAt: { type: Date, default: null },
    },
    {
      collection: 'work_item_comments',
      timestamps: true,
      strict: true,
      versionKey: false,
    },
  ),
  'work_item_comments',
);

export const workItemEventSchema = withCollectionIndexes(
  new Schema(
    {
      organizationId: immutableObjectId,
      projectId: immutableObjectId,
      workItemId: immutableObjectId,
      actorUserId: immutableObjectId,
      eventType: {
        type: String,
        enum: ['CREATED', 'UPDATED', 'COMMENT_ADDED', 'ARCHIVED'],
        required: true,
        immutable: true,
      },
      changes: { type: Schema.Types.Mixed, default: null, immutable: true },
      occurredAt: {
        type: Date,
        required: true,
        default: Date.now,
        immutable: true,
      },
    },
    {
      collection: 'work_item_events',
      strict: true,
      versionKey: false,
    },
  ),
  'work_item_events',
);
