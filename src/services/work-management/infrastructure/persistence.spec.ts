import { WORK_MANAGEMENT_PERSISTENCE } from './persistence';

describe('WORK_MANAGEMENT_PERSISTENCE', () => {
  it('keeps native Work data in its own logical database', () => {
    expect(WORK_MANAGEMENT_PERSISTENCE.databaseName).toBe('continuum_work');
  });

  it('declares only native Work collections with scoped indexes', () => {
    expect(
      WORK_MANAGEMENT_PERSISTENCE.collections.map(({ name }) => name),
    ).toEqual(['work_items', 'work_item_comments', 'work_item_events']);

    for (const collection of WORK_MANAGEMENT_PERSISTENCE.collections) {
      for (const index of collection.indexes ?? []) {
        expect(Object.keys(index.fields).slice(0, 2)).toEqual([
          'organizationId',
          'projectId',
        ]);
      }
    }
  });

  it('keeps comments and events addressable by Work Item and time', () => {
    const comments = WORK_MANAGEMENT_PERSISTENCE.collections.find(
      ({ name }) => name === 'work_item_comments',
    );
    const events = WORK_MANAGEMENT_PERSISTENCE.collections.find(
      ({ name }) => name === 'work_item_events',
    );

    expect(comments?.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: {
            organizationId: 1,
            projectId: 1,
            workItemId: 1,
            createdAt: -1,
          },
        }),
      ]),
    );
    expect(events?.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: {
            organizationId: 1,
            projectId: 1,
            workItemId: 1,
            occurredAt: -1,
          },
        }),
      ]),
    );
  });
});
