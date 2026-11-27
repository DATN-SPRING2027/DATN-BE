import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';
import type { ServicePersistenceDefinition } from './mongodb/mongodb.types';
import type { QueueName } from './queues/queue.names';

const index = (
  fields: Record<string, 1 | -1>,
  options?: {
    unique?: boolean;
    expireAfterSeconds?: number;
    name?: string;
    partialFilterExpression?: Record<string, unknown>;
  },
) => ({ fields, options });

export const CAPTURE_PERSISTENCE: ServicePersistenceDefinition = {
  serviceName: 'capture',
  databaseName: SERVICE_DATABASES.capture,
  collections: [
    {
      name: 'work_note_agent_drafts',
      indexes: [
        index(
          {
            organizationId: 1,
            projectId: 1,
            ownerUserId: 1,
            workflow: 1,
            resourceId: 1,
            updatedAt: -1,
          },
          { name: 'agent_drafts_workflow_resume' },
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            ownerUserId: 1,
            taskId: 1,
            noteId: 1,
            updatedAt: -1,
          },
          { name: 'agent_drafts_owned_resume' },
        ),
        index(
          { expiresAt: 1 },
          { name: 'agent_drafts_expiry', expireAfterSeconds: 0 },
        ),
      ],
    },
    {
      name: 'work_note_agent_operations',
      indexes: [
        index(
          { expiresAt: 1 },
          { name: 'agent_operations_expiry', expireAfterSeconds: 0 },
        ),
        index(
          { draftId: 1, ownerUserId: 1 },
          { name: 'agent_operations_draft_cleanup' },
        ),
      ],
    },
    {
      name: 'work_notes',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1, createdAt: 1 }),
        index({ authorUserId: 1, status: 1, createdAt: 1 }),
        index({ projectId: 1, jiraIssueKey: 1 }),
        index(
          { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
          { name: 'work_notes_project_task_created_at' },
        ),
        index(
          { 'provenance.mdFile.key': 1 },
          { name: 'capture_work_notes_md_file_key' },
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            'provenance.review.status': 1,
            updatedAt: -1,
          },
          { name: 'capture_work_notes_org_project_review_updated' },
        ),
      ],
    },
    {
      name: 'work_note_versions',
      indexes: [index({ workNoteId: 1, versionNumber: 1 }, { unique: true })],
    },
    {
      name: 'project_documents',
      indexes: [
        index(
          { organizationId: 1, projectId: 1, status: 1, updatedAt: -1 },
          { name: 'project_documents_project_status_updated_at' },
        ),
      ],
    },
    {
      name: 'project_document_versions',
      indexes: [
        index(
          { documentId: 1, versionNumber: 1 },
          {
            unique: true,
            name: 'project_document_versions_document_version_unique',
          },
        ),
        index(
          { organizationId: 1, projectId: 1, status: 1, updatedAt: -1 },
          { name: 'project_document_versions_project_status_updated_at' },
        ),
        index(
          { organizationId: 1, projectId: 1, 'file.sha256': 1, 'file.size': 1 },
          { name: 'capture_doc_versions_org_project_sha_size' },
        ),
        index({ 'file.key': 1 }, { name: 'capture_doc_versions_file_key' }),
      ],
    },
    {
      name: 'work_reports',
      indexes: [
        index(
          { projectId: 1, memberUserId: 1, reportScope: 1, periodStart: 1 },
          { unique: true, name: 'work_reports_member_scope_period_unique' },
        ),
        index(
          { organizationId: 1, projectId: 1, status: 1, periodStart: -1 },
          { name: 'work_reports_project_status_period' },
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            reportScope: 1,
            status: 1,
            periodStart: -1,
          },
          { name: 'work_reports_project_scope_status_period' },
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            reportScope: 1,
            memberUserId: 1,
            periodStart: -1,
          },
          { name: 'work_reports_project_scope_member_period' },
        ),
        index(
          { memberUserId: 1, projectId: 1, periodStart: -1 },
          { name: 'work_reports_member_period' },
        ),
        index(
          { status: 1, dueAt: 1, _id: 1 },
          { name: 'capture_work_reports_status_due_cursor' },
        ),
        index(
          { 'file.key': 1 },
          {
            name: 'work_reports_file_key',
            partialFilterExpression: { 'file.key': { $type: 'string' } },
          },
        ),
        index(
          { 'provenance.mdFile.key': 1 },
          { name: 'capture_work_reports_md_file_key' },
        ),
      ],
    },
    {
      name: 'work_report_versions',
      indexes: [
        index(
          { reportId: 1, versionNumber: 1 },
          { unique: true, name: 'report_editor_versions_unique' },
        ),
      ],
    },
    {
      name: 'project_document_editor_versions',
      indexes: [
        index(
          { documentId: 1, versionNumber: 1 },
          { unique: true, name: 'document_editor_versions_unique' },
        ),
      ],
    },
    {
      name: 'work_report_settings',
      indexes: [
        index(
          { projectId: 1, reportScope: 1, effectiveAt: 1 },
          {
            unique: true,
            name: 'work_report_settings_project_scope_effective_unique',
          },
        ),
        index(
          { organizationId: 1, projectId: 1, effectiveAt: -1 },
          { name: 'work_report_settings_project_history' },
        ),
        index(
          {
            organizationId: 1,
            projectId: 1,
            reportScope: 1,
            effectiveAt: -1,
          },
          { name: 'work_report_settings_project_scope_history' },
        ),
      ],
    },
    {
      name: 'capture_drafts',
      indexes: [
        index({ userId: 1, contextKey: 1 }, { unique: true }),
        index({ lastSavedAt: 1 }, { expireAfterSeconds: 2_592_000 }),
      ],
    },
    {
      name: 'work_note_templates',
      indexes: [index({ organizationId: 1, roleScope: 1 })],
    },
    {
      name: 'knowledge_requirements',
      indexes: [
        index({ organizationId: 1, projectId: 1, status: 1 }),
        index({ projectId: 1, responsibilityCode: 1 }),
      ],
    },
    {
      name: 'task_clarification_ledger',
      indexes: [
        index(
          {
            organizationId: 1,
            projectId: 1,
            taskId: 1,
            disposition: 1,
            answeredAt: -1,
          },
          { name: 'ledger_task_answered_at' },
        ),
        index(
          { organizationId: 1, projectId: 1, noteId: 1 },
          { name: 'ledger_note_lookup' },
        ),
      ],
    },
    {
      name: 'work_note_assessment_feedback',
      indexes: [
        index(
          {
            promptVersion: 1,
            purpose: 1,
            category: 1,
            recordedAt: -1,
          },
          { name: 'assessment_feedback_version_purpose_category' },
        ),
        index(
          { recordedAt: 1 },
          {
            name: 'assessment_feedback_retention_180d',
            expireAfterSeconds: 15_552_000,
          },
        ),
      ],
    },
    {
      name: 'ai_token_usage_logs',
      indexes: [
        index(
          { organizationId: 1, projectId: 1, occurredAt: -1 },
          { name: 'ai_token_usage_logs_org_project_occurred_at' },
        ),
        index(
          { organizationId: 1, userId: 1, occurredAt: -1 },
          { name: 'ai_token_usage_org_user_occurred_desc' },
        ),
        index(
          { organizationId: 1, taskKind: 1, occurredAt: -1 },
          { name: 'ai_token_usage_logs_org_task_occurred_at' },
        ),
        index(
          { organizationId: 1, dedupeKey: 1, projectId: 1 },
          {
            unique: true,
            name: 'ai_token_usage_org_project_dedupe_unique',
            partialFilterExpression: { dedupeKey: { $type: 'string' } },
          },
        ),
      ],
    },
  ],
};

export const CAPTURE_QUEUES: QueueName[] = [
  'ingestion-queue',
  'jira-sync-queue',
  'dlq-failed-jobs',
];
