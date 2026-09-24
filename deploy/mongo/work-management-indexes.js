const workDatabase = db.getSiblingDB('continuum_work');

const indexes = [
  {
    collection: 'work_items',
    definitions: [
      {
        fields: { organizationId: 1, projectId: 1, archivedAt: 1, updatedAt: -1 },
        name: 'work_item_project_archive_updated',
      },
      {
        fields: {
          organizationId: 1,
          projectId: 1,
          status: 1,
          archivedAt: 1,
          updatedAt: -1,
        },
        name: 'work_item_project_status_archive_updated',
      },
      {
        fields: {
          organizationId: 1,
          projectId: 1,
          assigneeId: 1,
          archivedAt: 1,
          updatedAt: -1,
        },
        name: 'work_item_project_assignee_archive_updated',
      },
      {
        fields: { organizationId: 1, projectId: 1, dueDate: 1 },
        name: 'work_item_project_due_date',
      },
    ],
  },
  {
    collection: 'work_item_comments',
    definitions: [
      {
        fields: {
          organizationId: 1,
          projectId: 1,
          workItemId: 1,
          createdAt: -1,
        },
        name: 'work_comment_project_item_created',
      },
    ],
  },
  {
    collection: 'work_item_events',
    definitions: [
      {
        fields: {
          organizationId: 1,
          projectId: 1,
          workItemId: 1,
          occurredAt: -1,
        },
        name: 'work_event_project_item_occurred',
      },
    ],
  },
];

for (const collectionIndexes of indexes) {
  const collection = workDatabase.getCollection(collectionIndexes.collection);
  for (const definition of collectionIndexes.definitions) {
    collection.createIndex(definition.fields, { name: definition.name });
  }
}
