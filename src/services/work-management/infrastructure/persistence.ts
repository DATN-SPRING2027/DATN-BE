interface WorkCollectionDefinition {
  name: string;
  indexes: Array<{
    fields: Record<string, 1 | -1>;
    options: { name: string };
  }>;
}

interface WorkPersistenceDefinition {
  databaseName: string;
  collections: WorkCollectionDefinition[];
}

const index = (fields: Record<string, 1 | -1>, name: string) => ({
  fields,
  options: { name },
});

export const WORK_MANAGEMENT_PERSISTENCE: WorkPersistenceDefinition = {
  databaseName: 'continuum_work',
  collections: [
    {
      name: 'work_items',
      indexes: [
        index(
          { organizationId: 1, projectId: 1, archivedAt: 1, updatedAt: -1 },
          'work_item_project_archive_updated',
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            status: 1,
            archivedAt: 1,
            updatedAt: -1,
          },
          'work_item_project_status_archive_updated',
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            assigneeId: 1,
            archivedAt: 1,
            updatedAt: -1,
          },
          'work_item_project_assignee_archive_updated',
        ),
        index(
          { organizationId: 1, projectId: 1, dueDate: 1 },
          'work_item_project_due_date',
        ),
      ],
    },
    {
      name: 'work_item_comments',
      indexes: [
        index(
          {
            organizationId: 1,
            projectId: 1,
            workItemId: 1,
            createdAt: -1,
          },
          'work_comment_project_item_created',
        ),
      ],
    },
    {
      name: 'work_item_events',
      indexes: [
        index(
          {
            organizationId: 1,
            projectId: 1,
            workItemId: 1,
            occurredAt: -1,
          },
          'work_event_project_item_occurred',
        ),
      ],
    },
  ],
};
