export const WORK_NOTE_DATABASE_NAME = 'continuum_capture';

export const WORK_NOTE_WORKFLOW_INDEXES = Object.freeze({
  work_notes: [
    {
      key: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
      name: 'work_notes_project_task_created_at',
    },
  ],
  project_documents: [
    {
      key: { organizationId: 1, projectId: 1, status: 1, updatedAt: -1 },
      name: 'project_documents_project_status_updated_at',
    },
  ],
  project_document_versions: [
    {
      key: { documentId: 1, versionNumber: 1 },
      name: 'project_document_versions_document_version_unique',
      unique: true,
    },
    {
      key: { organizationId: 1, projectId: 1, status: 1, updatedAt: -1 },
      name: 'project_document_versions_project_status_updated_at',
    },
  ],
  work_reports: [
    {
      key: { projectId: 1, memberUserId: 1, periodStart: 1 },
      name: 'work_reports_member_period_unique',
      unique: true,
    },
    {
      key: { organizationId: 1, projectId: 1, status: 1, periodStart: -1 },
      name: 'work_reports_project_status_period',
    },
    {
      key: { memberUserId: 1, projectId: 1, periodStart: -1 },
      name: 'work_reports_member_period',
    },
    {
      key: { status: 1, dueAt: 1 },
      name: 'work_reports_status_due_at',
    },
  ],
  work_report_settings: [
    {
      key: { projectId: 1, effectiveAt: 1 },
      name: 'work_report_settings_project_effective_unique',
      unique: true,
    },
    {
      key: { organizationId: 1, projectId: 1, effectiveAt: -1 },
      name: 'work_report_settings_project_history',
    },
  ],
});

export function validateWorkNoteDatabaseName(databaseName) {
  if (databaseName !== WORK_NOTE_DATABASE_NAME) {
    throw new Error(
      `Work Note workflow indexes only target ${WORK_NOTE_DATABASE_NAME}`,
    );
  }
  return databaseName;
}

export function buildWorkNoteWorkflowIndexPlan(databaseName) {
  validateWorkNoteDatabaseName(databaseName);
  return Object.entries(WORK_NOTE_WORKFLOW_INDEXES).flatMap(
    ([collection, indexes]) =>
      indexes.map(({ key, name, unique = false }) => ({
        databaseName,
        collection,
        key,
        name,
        unique,
      })),
  );
}
