import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import type { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import type { WorkNotesActor } from './work-notes.types';
import { WorkNotesService } from './work-notes.service';
import type { AuditService } from '../infrastructure/audit/audit.service';
import type { OutboxService } from '../infrastructure/outbox/outbox.service';

describe('Capture Work Notes Mongo workflows', () => {
  jest.setTimeout(120_000);

  let replicaSet: MongoMemoryReplSet;
  let connection: Connection;
  let service: WorkNotesService;
  let currentActor: WorkNotesActor;
  let authorization: Pick<
    WorkNotesAuthorizationService,
    'resolveProject' | 'resolveTask' | 'listActiveMembers'
  >;
  const organizationId = new Types.ObjectId().toHexString();
  const projectId = new Types.ObjectId().toHexString();
  const taskId = new Types.ObjectId().toHexString();
  const memberId = new Types.ObjectId().toHexString();
  const leaderId = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: {
        count: 1,
        name: 'test-rs-capture-work-notes',
        storageEngine: 'wiredTiger',
      },
    });
    connection = mongoose.createConnection(replicaSet.getUri(), {
      dbName: `capture_work_notes_${new Types.ObjectId().toHexString()}`,
      autoIndex: false,
      serverSelectionTimeoutMS: 10_000,
    });
    await connection.asPromise();
    for (const collection of [
      'work_notes',
      'project_documents',
      'project_document_versions',
      'work_reports',
      'work_report_settings',
      'outbox_events',
    ]) {
      await connection.createCollection(collection);
    }
    await connection
      .collection('project_document_versions')
      .createIndex({ documentId: 1, versionNumber: 1 }, { unique: true });
    await connection
      .collection('work_reports')
      .createIndex(
        { projectId: 1, memberUserId: 1, periodStart: 1 },
        { unique: true },
      );
    await connection
      .collection('work_report_settings')
      .createIndex({ projectId: 1, effectiveAt: 1 }, { unique: true });
  });

  beforeEach(async () => {
    await connection.dropDatabase();
    for (const collection of [
      'work_notes',
      'project_documents',
      'project_document_versions',
      'work_reports',
      'work_report_settings',
      'outbox_events',
    ]) {
      await connection.createCollection(collection);
    }
    await connection
      .collection('project_document_versions')
      .createIndex({ documentId: 1, versionNumber: 1 }, { unique: true });
    await connection
      .collection('work_reports')
      .createIndex(
        { projectId: 1, memberUserId: 1, periodStart: 1 },
        { unique: true },
      );
    await connection
      .collection('work_report_settings')
      .createIndex({ projectId: 1, effectiveAt: 1 }, { unique: true });
    currentActor = {
      userId: memberId,
      userName: 'Mina Member',
      organizationId,
      projectId,
      canReview: false,
      canConfigure: false,
    };
    authorization = {
      resolveProject: jest.fn(() => Promise.resolve(currentActor)),
      resolveTask: jest.fn(() => Promise.resolve(currentActor)),
      listActiveMembers: jest.fn(() =>
        Promise.resolve([{ userId: memberId, fullName: 'Mina Member' }]),
      ),
    };
    const outbox = {
      append: async (
        event: {
          eventName: string;
          aggregateType: string;
          aggregateId: string;
          payload: Record<string, unknown>;
        },
        session?: mongoose.ClientSession,
      ) => {
        await connection
          .collection('outbox_events')
          .insertOne(
            { ...event, status: 'PENDING', occurredAt: new Date() },
            session ? { session } : undefined,
          );
      },
    };
    service = new WorkNotesService(
      authorization as WorkNotesAuthorizationService,
      connection,
      outbox as OutboxService,
      {
        append: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditService,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await replicaSet?.stop();
  });

  it('persists and isolates structured Task Notes', async () => {
    const created = await service.createTaskNote({}, projectId, taskId, {
      title: 'Invitation endpoint',
      accomplishments: 'Added the invitation endpoint.',
      approach: 'Used a transaction and an outbox.',
      reason: 'Prevent duplicate invitations.',
    });

    expect(created.status).toBe('CONFIRMED');
    expect(created.permissions.canReview).toBe(false);
    expect(await connection.collection('work_notes').countDocuments()).toBe(1);
    expect(
      await service.getTaskNote({}, projectId, taskId, created.id),
    ).toMatchObject({
      id: created.id,
      taskId,
      accomplishments: 'Added the invitation endpoint.',
    });
    await expect(
      service.getTaskNote(
        {},
        new Types.ObjectId().toHexString(),
        taskId,
        created.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('keeps approved Document versions immutable through review and follow-up edits', async () => {
    const original = {
      title: 'Database design',
      type: 'DATABASE_DESIGN' as const,
      content: '# First version',
    };
    const created = await service.createDocument({}, projectId, original);
    const edited = await service.updateDocumentDraft(
      {},
      projectId,
      created.id,
      {
        ...original,
        content: '# Submitted version',
      },
    );
    await service.submitDocument({}, projectId, created.id);

    currentActor = {
      ...currentActor,
      userId: memberId,
      userName: 'Mina Member',
      canReview: true,
      canConfigure: true,
    };
    await expect(
      service.reviewDocument({}, projectId, created.id, 'APPROVED', {}),
    ).rejects.toMatchObject({ status: 403 });

    currentActor = {
      ...currentActor,
      userId: leaderId,
      userName: 'Lee Leader',
    };
    const changed = await service.reviewDocument(
      {},
      projectId,
      created.id,
      'CHANGES_REQUESTED',
      { comment: 'Add the migration rollback plan.' },
    );
    expect(changed.status).toBe('CHANGES_REQUESTED');

    currentActor = {
      ...currentActor,
      userId: memberId,
      userName: 'Mina Member',
      canReview: false,
      canConfigure: false,
    };
    await service.updateDocumentDraft({}, projectId, created.id, {
      ...original,
      content: '# Corrected version',
    });
    await service.submitDocument({}, projectId, created.id);
    currentActor = { ...currentActor, userId: leaderId, canReview: true };
    const approved = await service.reviewDocument(
      {},
      projectId,
      created.id,
      'APPROVED',
      {},
    );
    expect(approved.status).toBe('APPROVED');
    expect(approved.reviewHistory).toHaveLength(2);

    currentActor = { ...currentActor, userId: memberId, canReview: false };
    const nextVersion = await service.updateDocumentDraft(
      {},
      projectId,
      created.id,
      { ...original, content: '# Version two draft' },
    );
    expect(nextVersion.version).toBe(2);
    expect(nextVersion.status).toBe('DRAFT');
    expect(nextVersion.versions).toEqual([
      expect.objectContaining({ version: 1, status: 'APPROVED' }),
      expect.objectContaining({ version: 2, status: 'DRAFT' }),
    ]);
    expect(
      await connection.collection('project_document_versions').findOne({
        documentId: new Types.ObjectId(created.id),
        versionNumber: 1,
      }),
    ).toMatchObject({ content: '# Corrected version', status: 'APPROVED' });
    expect(
      await connection.collection('outbox_events').countDocuments({
        eventName: 'KNOWLEDGE_SOURCE_APPROVED',
      }),
    ).toBe(1);
    expect(edited.content).toBe('# Submitted version');
  });

  it('allows a Document owner to clear its optional description', async () => {
    const created = await service.createDocument({}, projectId, {
      title: 'API specification',
      description: 'Initial description',
      type: 'API_SPECIFICATION',
      content: '# Endpoints',
    });

    const updated = await service.updateDocumentDraft(
      {},
      projectId,
      created.id,
      {
        title: 'API specification',
        description: '',
        type: 'API_SPECIFICATION',
        content: '# Endpoints',
      },
    );

    expect(updated.description).toBe('');
    expect(
      await connection.collection('project_document_versions').findOne({
        documentId: new Types.ObjectId(created.id),
        versionNumber: 1,
      }),
    ).toMatchObject({ description: '' });
  });

  it('creates one report per member period, reviews it, and emits overdue events once', async () => {
    const settings = await service.getWorkReportSettings({}, projectId);
    expect(settings.frequency).toBe('WEEKLY');
    currentActor = { ...currentActor, canReview: true, canConfigure: true };
    const first = await service.listWorkReports({}, projectId, 1, 100);
    const second = await service.listWorkReports({}, projectId, 1, 100);
    expect(first.data).toHaveLength(1);
    expect(first.data[0].memberName).toBe('Mina Member');
    expect(Number.isFinite(Date.parse(first.data[0].createdAt))).toBe(true);
    expect(second.data[0].id).toBe(first.data[0].id);
    expect(await connection.collection('work_reports').countDocuments()).toBe(
      1,
    );

    currentActor = {
      ...currentActor,
      userId: memberId,
      canReview: false,
      canConfigure: false,
    };
    const saved = await service.saveCurrentWorkReportDraft({}, projectId, {
      accomplishments: 'Completed the API.',
      approach: 'Added validation and a transaction.',
      reason: 'Protect data integrity.',
      blockers: 'Waiting for review.',
      nextSteps: 'Add the FE integration.',
    });
    const submitted = await service.submitWorkReport({}, projectId, saved.id);
    expect(submitted.status).toBe('PENDING_REVIEW');

    currentActor = {
      ...currentActor,
      userId: leaderId,
      canReview: true,
      canConfigure: true,
    };
    const approved = await service.reviewWorkReport(
      {},
      projectId,
      saved.id,
      'APPROVED',
      {},
    );
    expect(approved.status).toBe('APPROVED');
    expect(
      await connection.collection('outbox_events').countDocuments({
        eventName: 'KNOWLEDGE_SOURCE_APPROVED',
      }),
    ).toBe(1);

    const overdueId = new Types.ObjectId();
    const now = new Date();
    await connection.collection('work_reports').insertOne({
      _id: overdueId,
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      memberUserId: new Types.ObjectId(memberId),
      frequency: 'DAILY',
      periodStart: new Date(now.getTime() - 2 * 86_400_000),
      periodEnd: new Date(now.getTime() - 86_400_000),
      dueAt: new Date(now.getTime() - 86_400_000),
      status: 'DRAFT',
      reviewHistory: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(await service.sweepOverdueReports()).toBe(1);
    expect(await service.sweepOverdueReports()).toBe(0);
    expect(
      await connection.collection('work_reports').findOne({ _id: overdueId }),
    ).toMatchObject({ status: 'OVERDUE' });
    expect(
      await connection.collection('outbox_events').countDocuments({
        eventName: 'WORK_REPORT_OVERDUE',
      }),
    ).toBe(1);
  });
});
