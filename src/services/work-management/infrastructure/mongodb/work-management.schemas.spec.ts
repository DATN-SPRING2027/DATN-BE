import {
  workItemCommentSchema,
  workItemEventSchema,
  workItemSchema,
} from './work-management.schemas';

describe('native Continuum Work MongoDB schemas', () => {
  it('requires project scope and a valid state for every Work Item', () => {
    expect(workItemSchema.get('strict')).toBe(true);
    expect(workItemSchema.get('collection')).toBe('work_items');

    for (const path of [
      'organizationId',
      'projectId',
      'title',
      'status',
      'priority',
      'createdBy',
    ]) {
      expect(workItemSchema.path(path).isRequired).toBe(true);
    }

    expect(workItemSchema.path('status').options.enum).toEqual([
      'TODO',
      'IN_PROGRESS',
      'DONE',
    ]);
    expect(workItemSchema.path('priority').options.enum).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'URGENT',
    ]);
  });

  it('scopes comments to a project and Work Item with a required author', () => {
    expect(workItemCommentSchema.get('strict')).toBe(true);
    expect(workItemCommentSchema.get('collection')).toBe('work_item_comments');

    for (const path of [
      'organizationId',
      'projectId',
      'workItemId',
      'authorId',
      'body',
    ]) {
      expect(workItemCommentSchema.path(path).isRequired).toBe(true);
    }
  });

  it('stores immutable actor-attributed activity events', () => {
    expect(workItemEventSchema.get('strict')).toBe(true);
    expect(workItemEventSchema.get('collection')).toBe('work_item_events');

    for (const path of [
      'organizationId',
      'projectId',
      'workItemId',
      'actorUserId',
      'eventType',
      'occurredAt',
    ]) {
      expect(workItemEventSchema.path(path).isRequired).toBe(true);
      expect(workItemEventSchema.path(path).options.immutable).toBe(true);
    }
    expect(workItemEventSchema.path('eventType').options.enum).toEqual([
      'CREATED',
      'UPDATED',
      'COMMENT_ADDED',
      'ARCHIVED',
    ]);
  });
});
