import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import type { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import type { WorkNotesActor } from './work-notes.types';
import { WorkNotesService } from './work-notes.service';
import type { AuditService } from '../infrastructure/audit/audit.service';
import type { OutboxService } from '../infrastructure/outbox/outbox.service';
import type { ProjectDocumentStorage } from '../infrastructure/storage/project-document.storage';

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
      joinedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    };
    authorization = {
      resolveProject: jest.fn(() => Promise.resolve(currentActor)),
      resolveTask: jest.fn(() => Promise.resolve(currentActor)),
      listActiveMembers: jest.fn(() =>
        Promise.resolve([
          {
            userId: memberId,
            fullName: 'Mina Member',
            joinedAt: new Date().toISOString(),
          },
        ]),
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
    expect(
      await service.getProjectTaskNote({}, projectId, created.id),
    ).toMatchObject({
      id: created.id,
      taskId,
      type: 'TASK_NOTE',
    });
    await expect(
      service.getProjectTaskNote(
        {},
        new Types.ObjectId().toHexString(),
        created.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('excludes legacy unlinked records from the Task Note taxonomy', async () => {
    await connection.collection('work_notes').insertOne({
      _id: new Types.ObjectId(),
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      authorUserId: new Types.ObjectId(memberId),
      type: 'TASK_NOTE',
      title: 'Unlinked legacy note',
      whatDone: 'Old generic content',
      howSolved: 'Old generic content',
      whyThisWay: 'Old generic content',
      status: 'CONFIRMED',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.createTaskNote({}, projectId, taskId, {
      title: 'Linked note',
      accomplishments: 'Done',
      approach: 'Approach',
      reason: 'Reason',
    });

    const page = await service.listProjectTaskNotes({}, projectId, 1, 50);

    expect(page.data).toHaveLength(1);
    expect(page.data[0].taskId).toBe(taskId);
  });

  it('allows the author or reviewer to edit and archive a Task Note', async () => {
    const input = {
      title: 'Original',
      accomplishments: 'Done',
      approach: 'Method',
      reason: 'Reason',
    };
    const note = await service.createTaskNote({}, projectId, taskId, input);
    const ownerEdit = await service.updateTaskNote(
      {},
      projectId,
      taskId,
      note.id,
      { ...input, title: 'Owner edit' },
    );
    expect(ownerEdit.title).toBe('Owner edit');
    currentActor = {
      ...currentActor,
      userId: new Types.ObjectId().toHexString(),
    };
    await expect(
      service.updateTaskNote({}, projectId, taskId, note.id, input),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.deleteTaskNote({}, projectId, taskId, note.id),
    ).rejects.toMatchObject({ status: 404 });
    currentActor = { ...currentActor, userId: leaderId, canReview: true };
    const edited = await service.updateTaskNote(
      {},
      projectId,
      taskId,
      note.id,
      { ...input, title: 'Corrected' },
    );
    expect(edited.title).toBe('Corrected');
    await service.deleteTaskNote({}, projectId, taskId, note.id);
    await expect(
      service.getTaskNote({}, projectId, taskId, note.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await connection
        .collection('work_notes')
        .findOne({ _id: new Types.ObjectId(note.id) }),
    ).toMatchObject({ status: 'ARCHIVED' });
  });

  it('does not assign periods ending before a member joined', async () => {
    currentActor = { ...currentActor, canReview: true };
    const joinedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    (authorization.listActiveMembers as jest.Mock).mockResolvedValue([
      { userId: memberId, fullName: 'Mina Member', joinedAt },
    ]);
    await connection.collection('work_report_settings').insertOne({
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      frequency: 'DAILY',
      effectiveAt: new Date(Date.now() - 10 * 86_400_000),
      createdByUserId: new Types.ObjectId(leaderId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.listWorkReports({}, projectId, 1, 100);
    expect(
      await connection.collection('work_reports').countDocuments(),
    ).toBeLessThanOrEqual(3);
  });

  it('creates overdue obligations and events without a page request', async () => {
    const now = Date.now();
    await connection.collection('work_report_settings').insertOne({
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      frequency: 'DAILY',
      effectiveAt: new Date(now - 4 * 86_400_000),
      createdByUserId: new Types.ObjectId(leaderId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const project = {
      organizationId,
      projectId,
      projectCreatedBy: leaderId,
      members: [
        {
          userId: memberId,
          joinedAt: new Date(now - 2 * 86_400_000).toISOString(),
        },
      ],
    };
    await service.ensureScheduledReportObligations(project);
    expect(await connection.collection('work_reports').countDocuments()).toBe(
      3,
    );
    expect(await service.sweepOverdueReports()).toBe(2);
    await service.ensureScheduledReportObligations(project);
    expect(await service.sweepOverdueReports()).toBe(0);
    expect(
      await connection
        .collection('outbox_events')
        .countDocuments({ eventName: 'WORK_REPORT_DUE' }),
    ).toBe(2);
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

    await service.submitDocument({}, projectId, created.id);
    currentActor = { ...currentActor, userId: leaderId, canReview: true };
    const secondApproval = await service.reviewDocument(
      {},
      projectId,
      created.id,
      'APPROVED',
      {},
    );
    expect(secondApproval.version).toBe(2);
    expect(
      await connection
        .collection('outbox_events')
        .countDocuments({ eventName: 'KNOWLEDGE_SOURCE_REPLACED' }),
    ).toBe(1);
    await service.archiveDocument({}, projectId, created.id);
    expect(
      await connection
        .collection('outbox_events')
        .countDocuments({ eventName: 'KNOWLEDGE_SOURCE_REVOKED' }),
    ).toBe(1);
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

  it('stores a private PDF reference per Document version and enforces Project scope', async () => {
    const objects = new Map<string, Buffer>();
    const storage = {
      put: jest.fn((key: string, bytes: Buffer) => {
        objects.set(key, bytes);
        return Promise.resolve();
      }),
      get: jest.fn((key: string) =>
        Promise.resolve(objects.get(key) ?? Buffer.alloc(0)),
      ),
      delete: jest.fn((key: string) => {
        objects.delete(key);
        return Promise.resolve();
      }),
    } as unknown as ProjectDocumentStorage;
    service = new WorkNotesService(
      authorization as WorkNotesAuthorizationService,
      connection,
      {
        append: async (
          event: Record<string, unknown>,
          session?: mongoose.ClientSession,
        ) => {
          await connection
            .collection('outbox_events')
            .insertOne(event, session ? { session } : undefined);
        },
      } as unknown as OutboxService,
      {
        append: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuditService,
      storage,
    );
    const document = await service.createDocument({}, projectId, {
      title: 'RSR',
      type: 'RSR',
      content: '',
    });
    await expect(
      service.submitDocument({}, projectId, document.id),
    ).rejects.toMatchObject({ status: 409 });
    const pdf = Buffer.from('%PDF-1.4 test');
    const uploaded = await service.uploadDocumentFile(
      {},
      projectId,
      document.id,
      'rsr.pdf',
      'application/pdf',
      pdf,
    );
    expect(uploaded.file).toEqual({
      name: 'rsr.pdf',
      contentType: 'application/pdf',
      size: pdf.length,
    });
    expect(JSON.stringify(uploaded)).not.toContain('work-notes/');
    expect(
      (await service.downloadDocumentFile({}, projectId, document.id)).bytes,
    ).toEqual(pdf);
    const markdown = Buffer.from(
      '# RSR Specification\n\nDetailed requirements.',
    );
    const uploadedMarkdown = await service.uploadDocumentFile(
      {},
      projectId,
      document.id,
      'rsr-spec.md',
      '',
      markdown,
    );
    expect(uploadedMarkdown.file).toEqual({
      name: 'rsr-spec.md',
      contentType: 'text/markdown',
      size: markdown.length,
    });
    await expect(
      service.uploadDocumentFile(
        {},
        projectId,
        document.id,
        'malicious-binary.md',
        'text/markdown',
        Buffer.from([0x4d, 0x5a, 0x00, 0x90]),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.downloadDocumentFile(
        {},
        new Types.ObjectId().toHexString(),
        document.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await service.submitDocument({}, projectId, document.id);
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

  it('uses historical joinedAt for Member listWorkReports and blocks Leader draft creation', async () => {
    const now = Date.now();
    await connection.collection('work_report_settings').insertOne({
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      frequency: 'DAILY',
      effectiveAt: new Date(now - 10 * 86_400_000),
      createdByUserId: new Types.ObjectId(leaderId),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    currentActor = {
      ...currentActor,
      userId: memberId,
      canReview: false,
      canConfigure: false,
      joinedAt: new Date(now - 2 * 86_400_000).toISOString(),
    };

    const memberReports = await service.listWorkReports({}, projectId, 1, 100);
    expect(memberReports.data.length).toBeGreaterThanOrEqual(2);
    expect(memberReports.data.length).toBeLessThanOrEqual(3);
    expect(memberReports.data[0].permissions.canCreate).toBe(true);

    currentActor = {
      ...currentActor,
      userId: leaderId,
      canReview: true,
      canConfigure: true,
      joinedAt: undefined,
    };
    const leaderReports = await service.listWorkReports({}, projectId, 1, 100);
    expect(leaderReports.data[0].permissions.canCreate).toBe(false);
    await expect(
      service.saveCurrentWorkReportDraft({}, projectId, {
        accomplishments: 'Leader draft',
        approach: 'Approach',
        reason: 'Reason',
      }),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'WORK_REPORT_MEMBER_ONLY' },
    });
  });

  it('preserves APPROVED filter visibility and archive revocation when a newer version is DRAFT or REJECTED', async () => {
    const created = await service.createDocument({}, projectId, {
      title: 'Architecture Blueprint',
      type: 'ARCHITECTURE',
      content: '# v1 approved content',
    });
    await service.submitDocument({}, projectId, created.id);
    currentActor = { ...currentActor, userId: leaderId, canReview: true };
    await service.reviewDocument({}, projectId, created.id, 'APPROVED', {});

    currentActor = { ...currentActor, userId: memberId, canReview: false };
    const draftV2 = await service.updateDocumentDraft(
      {},
      projectId,
      created.id,
      {
        title: 'Architecture Blueprint',
        type: 'ARCHITECTURE',
        content: '# v2 work in progress',
      },
    );
    expect(draftV2.version).toBe(2);
    expect(draftV2.status).toBe('DRAFT');

    const approvedList = await service.listDocuments(
      {},
      projectId,
      1,
      20,
      'APPROVED',
    );
    expect(approvedList.data).toEqual([
      expect.objectContaining({ id: created.id }),
    ]);

    currentActor = {
      ...currentActor,
      userId: leaderId,
      canReview: true,
      canConfigure: true,
    };
    await service.archiveDocument({}, projectId, created.id);

    const revokeEvent = await connection.collection('outbox_events').findOne({
      eventName: 'KNOWLEDGE_SOURCE_REVOKED',
      aggregateId: created.id,
    });
    expect(revokeEvent?.payload).toMatchObject({
      sourceId: created.id,
      version: 1,
    });
  });

  it('skips overdue transitions for members excluded from activeRosters', async () => {
    const departedMemberId = new Types.ObjectId().toHexString();
    const now = new Date();
    await connection.collection('work_reports').insertMany([
      {
        _id: new Types.ObjectId(),
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
      },
      {
        _id: new Types.ObjectId(),
        organizationId: new Types.ObjectId(organizationId),
        projectId: new Types.ObjectId(projectId),
        memberUserId: new Types.ObjectId(departedMemberId),
        frequency: 'DAILY',
        periodStart: new Date(now.getTime() - 2 * 86_400_000),
        periodEnd: new Date(now.getTime() - 86_400_000),
        dueAt: new Date(now.getTime() - 86_400_000),
        status: 'DRAFT',
        reviewHistory: [],
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const swept = await service.sweepOverdueReports([
      {
        organizationId,
        projectId,
        projectCreatedBy: leaderId,
        members: [
          {
            userId: memberId,
            joinedAt: new Date(now.getTime() - 5 * 86_400_000).toISOString(),
          },
        ],
      },
    ]);
    expect(swept).toBe(1);
    expect(
      await connection.collection('work_reports').findOne({
        memberUserId: new Types.ObjectId(departedMemberId),
      }),
    ).toMatchObject({ status: 'DRAFT' });
  });

  it('rolls back the mutation transaction when audit append fails', async () => {
    const failingService = new WorkNotesService(
      authorization as WorkNotesAuthorizationService,
      connection,
      {
        append: async (
          event: Record<string, unknown>,
          session?: mongoose.ClientSession,
        ) => {
          await connection
            .collection('outbox_events')
            .insertOne(event, session ? { session } : undefined);
        },
      } as unknown as OutboxService,
      {
        append: jest.fn().mockRejectedValue(new Error('Audit write failure')),
      } as unknown as AuditService,
    );

    await expect(
      failingService.createTaskNote({}, projectId, taskId, {
        title: 'Transactional task note',
        accomplishments: 'Done',
        approach: 'Approach',
        reason: 'Reason',
      }),
    ).rejects.toThrow('Audit write failure');

    expect(await connection.collection('work_notes').countDocuments()).toBe(0);
    expect(await connection.collection('outbox_events').countDocuments()).toBe(
      0,
    );
  });
});
