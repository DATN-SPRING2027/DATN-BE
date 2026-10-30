import { CAPTURE_PERSISTENCE } from '../persistence';
import {
  createCollectionSchema,
  WORK_REPORT_CADENCE_FREQUENCIES,
  WORK_REPORT_SCOPES,
} from './mongodb.schemas';
import {
  createCollectionSchema as createNotificationCollectionSchema,
  NOTIFICATION_MVP_TYPES,
  NOTIFICATION_TARGET_KINDS,
} from '../../../notification/infrastructure/mongodb/mongodb.schemas';
import { NOTIFICATION_PERSISTENCE } from '../../../notification/infrastructure/persistence';
import { Mongoose, Types } from 'mongoose';

describe('Work Notes persistence contract', () => {
  const collections = new Map(
    CAPTURE_PERSISTENCE.collections.map((definition) => [
      definition.name,
      definition,
    ]),
  );

  it('owns the document, immutable document version, report and settings collections', () => {
    expect([...collections.keys()]).toEqual(
      expect.arrayContaining([
        'project_documents',
        'project_document_versions',
        'work_reports',
        'work_report_settings',
      ]),
    );
  });

  it('prevents duplicate work report obligations within each reporting scope', () => {
    const indexes = collections.get('work_reports')?.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          JSON.stringify(index.fields) ===
            JSON.stringify({
              projectId: 1,
              memberUserId: 1,
              reportScope: 1,
              periodStart: 1,
            }),
      ),
    ).toBe(true);
  });

  it('keeps document versions unique and separate from mutable document metadata', () => {
    const indexes = collections.get('project_document_versions')?.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          JSON.stringify(index.fields) ===
            JSON.stringify({ documentId: 1, versionNumber: 1 }),
      ),
    ).toBe(true);
    expect(
      createCollectionSchema(
        collections.get('project_document_versions')!,
      ).path('content'),
    ).toBeDefined();
    expect(
      createCollectionSchema(
        collections.get('project_document_versions')!,
      ).path('file.key'),
    ).toBeDefined();
  });

  it('stores Task Notes with a Task association in the existing Work Notes collection', () => {
    const definition = collections.get('work_notes');
    expect(definition?.indexes).toContainEqual(
      expect.objectContaining({
        fields: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
      }),
    );
    const schema = createCollectionSchema(definition!);
    expect(schema.path('taskId')).toBeDefined();
    expect(schema.path('taskId')?.options.required).toBe(true);
    expect(schema.path('type')).toBeDefined();
  });

  it('keeps Project Documents project-scoped without a Task association and tracks latest approved version', () => {
    const documentDefinition = collections.get('project_documents')!;
    const versionDefinition = collections.get('project_document_versions')!;
    const documentSchema = createCollectionSchema(documentDefinition);
    const versionSchema = createCollectionSchema(versionDefinition);
    expect(documentSchema.path('taskId')).toBeUndefined();
    expect(versionSchema.path('taskId')).toBeUndefined();
    expect(documentSchema.path('latestApprovedVersionNumber')).toBeDefined();
    expect(
      (documentDefinition.indexes ?? []).some(
        (index) => 'taskId' in index.fields,
      ),
    ).toBe(false);
  });

  it('accepts a file-only document draft while upload and submission remain separate steps', () => {
    const schema = createCollectionSchema(
      collections.get('project_document_versions')!,
    );
    const Version = new Mongoose().model('FileOnlyDocumentVersion', schema);
    const version = new Version({
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      documentId: new Types.ObjectId(),
      versionNumber: 1,
      title: 'Database design',
      documentType: 'DATABASE_DESIGN',
      content: '',
      status: 'DRAFT',
      editedByUserId: new Types.ObjectId(),
    });
    expect(version.validateSync()).toBeUndefined();
    version.set('file', {
      key: 'work-notes/test-file',
      name: 'database-design.pdf',
      contentType: 'application/pdf',
      size: 128,
    });
    expect(version.validateSync()).toBeUndefined();
  });

  it('normalizes 2-tier (MEMBER & LEADER) work reports with 1-7 day cadences, scoped indexes, and typed review history', () => {
    expect(WORK_REPORT_SCOPES).toEqual(['MEMBER', 'LEADER']);
    expect(WORK_REPORT_CADENCE_FREQUENCIES).toEqual([
      'DAILY',
      'EVERY_2_DAYS',
      'EVERY_3_DAYS',
      'EVERY_4_DAYS',
      'EVERY_5_DAYS',
      'EVERY_6_DAYS',
      'WEEKLY',
    ]);

    const reportDefinition = collections.get('work_reports')!;
    const indexes = reportDefinition.indexes ?? [];
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fields: {
            organizationId: 1,
            projectId: 1,
            reportScope: 1,
            status: 1,
            periodStart: -1,
          },
          options: { name: 'work_reports_project_scope_status_period' },
        }),
        expect.objectContaining({
          fields: {
            organizationId: 1,
            projectId: 1,
            reportScope: 1,
            memberUserId: 1,
            periodStart: -1,
          },
          options: { name: 'work_reports_project_scope_member_period' },
        }),
      ]),
    );

    const schema = createCollectionSchema(reportDefinition);
    const ReportModel = new Mongoose().model('NormalizedWorkReport', schema);
    const now = new Date('2026-10-30T00:00:00.000Z');
    const report = new ReportModel({
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(),
      reportScope: 'LEADER',
      frequency: 'EVERY_4_DAYS',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 4 * 86_400_000),
      dueAt: new Date(now.getTime() + 4 * 86_400_000),
      status: 'APPROVED',
      reviewHistory: [
        {
          action: 'APPROVED',
          reviewerId: new Types.ObjectId().toHexString(),
          reviewerRole: 'MANAGER',
          comment: 'Clear sprint deliverables and blocker mitigation.',
          at: now,
        },
      ],
    });
    expect(report.validateSync()).toBeUndefined();

    const invalidReviewReport = new ReportModel({
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      memberUserId: new Types.ObjectId(),
      reportScope: 'MEMBER',
      frequency: 'EVERY_2_DAYS',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 2 * 86_400_000),
      dueAt: new Date(now.getTime() + 2 * 86_400_000),
      status: 'PENDING_REVIEW',
      reviewHistory: [
        {
          action: 'INVALID_ACTION',
          reviewerId: new Types.ObjectId().toHexString(),
          at: now,
        },
      ],
    });
    expect(invalidReviewReport.validateSync()).toBeDefined();
  });

  it('scopes work_report_settings uniquely by (projectId, reportScope, effectiveAt) and supports scheduled next cadence', () => {
    const settingsDefinition = collections.get('work_report_settings')!;
    const indexes = settingsDefinition.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          index.options?.name ===
            'work_report_settings_project_scope_effective_unique' &&
          JSON.stringify(index.fields) ===
            JSON.stringify({
              projectId: 1,
              reportScope: 1,
              effectiveAt: 1,
            }),
      ),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          index.options?.name ===
            'work_report_settings_project_scope_history' &&
          JSON.stringify(index.fields) ===
            JSON.stringify({
              organizationId: 1,
              projectId: 1,
              reportScope: 1,
              effectiveAt: -1,
            }),
      ),
    ).toBe(true);

    const schema = createCollectionSchema(settingsDefinition);
    const SettingsModel = new Mongoose().model(
      'NormalizedWorkReportSettings',
      schema,
    );
    const effectiveAt = new Date('2026-10-26T00:00:00.000Z');
    const nextEffectiveAt = new Date('2026-11-02T00:00:00.000Z');
    const actorId = new Types.ObjectId();

    const leaderSetting = new SettingsModel({
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      reportScope: 'LEADER',
      frequency: 'WEEKLY',
      effectiveAt,
      nextFrequency: 'EVERY_3_DAYS',
      nextEffectiveAt,
      createdByUserId: actorId,
      updatedByUserId: actorId,
      history: [
        {
          frequency: 'WEEKLY',
          effectiveAt,
          updatedBy: actorId.toHexString(),
        },
      ],
    });
    expect(leaderSetting.validateSync()).toBeUndefined();
  });

  it('registers additive WORK_REPORT notification types in continuum_notification schema', () => {
    expect(NOTIFICATION_MVP_TYPES).toEqual(
      expect.arrayContaining([
        'WORK_REPORT_SUBMITTED',
        'WORK_REPORT_APPROVED',
        'WORK_REPORT_CHANGES_REQUESTED',
        'WORK_REPORT_REJECTED',
        'WORK_REPORT_OVERDUE',
        'WORK_REPORT_FREQUENCY_CHANGED',
      ]),
    );
    expect(NOTIFICATION_TARGET_KINDS).toContain('PROJECT');

    const notificationDef = NOTIFICATION_PERSISTENCE.collections.find(
      (item) => item.name === 'notifications',
    )!;
    const schema = createNotificationCollectionSchema(notificationDef);
    const NotificationModel = new Mongoose().model(
      'WorkReportNotificationRecord',
      schema,
    );
    const record = new NotificationModel({
      recipientId: new Types.ObjectId().toHexString(),
      organizationId: new Types.ObjectId().toHexString(),
      projectId: new Types.ObjectId().toHexString(),
      reportId: new Types.ObjectId().toHexString(),
      type: 'WORK_REPORT_SUBMITTED',
      title: 'Leader work report submitted',
      message: 'A Project Leader submitted a periodic work report for review.',
      target: {
        kind: 'PROJECT',
        url: '/projects/507f1f77bcf86cd799439011/work-reports',
        organizationId: '507f1f77bcf86cd799439012',
        projectId: '507f1f77bcf86cd799439011',
        reportId: '507f1f77bcf86cd799439013',
      },
      eventKey: 'work-report-submitted:507f1f77bcf86cd799439013',
    });
    expect(record.validateSync()).toBeUndefined();
  });
});
