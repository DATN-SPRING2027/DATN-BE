import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  StreamableFile,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Types, type Connection } from 'mongoose';
import { WorkNotesController } from '../controllers/work-notes.controller';
import type { AuditService } from '../infrastructure/audit/audit.service';
import {
  KnowledgeOutboxConsumer,
  type SagKnowledgeSyncTransport,
} from '../infrastructure/outbox/knowledge-outbox.consumer';
import type { OutboxService } from '../infrastructure/outbox/outbox.service';
import { KnowledgeIngestionProcessor } from '../infrastructure/queues/knowledge-ingestion.processor';
import {
  QUEUE_NAMES,
  type CaptureQueuePublisher,
} from '../infrastructure/queues/queue.names';
import type { ProjectDocumentStorage } from '../infrastructure/storage/project-document.storage';
import type { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import { WorkNotesService } from './work-notes.service';

describe('Direct-to-R2 Zero-Buffer Document Upload & SAG Queue Handoff', () => {
  const orgId = '111111111111111111111111';
  const projectId = '222222222222222222222222';
  const documentId = '333333333333333333333333';
  const leaderId = '444444444444444444444444';
  const otherUserId = '555555555555555555555555';

  const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  const toIdStr = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : value instanceof Types.ObjectId
        ? value.toHexString()
        : '';

  function createInMemoryMongoStub(
    initialVersionFile?: Record<string, unknown>,
  ) {
    const now = new Date('2026-10-29T12:00:00.000Z');
    const docRow: Record<string, unknown> = {
      _id: new Types.ObjectId(documentId),
      organizationId: new Types.ObjectId(orgId),
      projectId: new Types.ObjectId(projectId),
      title: 'System Architecture Spec',
      documentType: 'ARCHITECTURE',
      createdByUserId: new Types.ObjectId(leaderId),
      updatedByUserId: new Types.ObjectId(leaderId),
      currentVersionNumber: 1,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
    };

    const versionRow: Record<string, unknown> = {
      _id: new Types.ObjectId('666666666666666666666666'),
      organizationId: new Types.ObjectId(orgId),
      projectId: new Types.ObjectId(projectId),
      documentId: new Types.ObjectId(documentId),
      versionNumber: 1,
      title: 'System Architecture Spec',
      documentType: 'ARCHITECTURE',
      content: '',
      ...(initialVersionFile ? { file: initialVersionFile } : {}),
      status: 'DRAFT',
      editedByUserId: new Types.ObjectId(leaderId),
      reviewHistory: [],
      createdAt: now,
      updatedAt: now,
    };

    const otherVersionRows: Array<Record<string, unknown>> = [];

    const documentsCollection = {
      findOne: jest.fn((filter: Record<string, unknown>) => {
        if (filter._id && toIdStr(filter._id) !== toIdStr(docRow._id)) {
          return Promise.resolve(null);
        }
        if (filter.status && filter.status !== docRow.status) {
          return Promise.resolve(null);
        }
        if (
          filter.createdByUserId &&
          toIdStr(filter.createdByUserId) !== toIdStr(docRow.createdByUserId)
        ) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...docRow });
      }),
      updateOne: jest.fn(
        (
          _filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown> },
        ) => {
          if (update.$set) Object.assign(docRow, update.$set);
          return Promise.resolve({ modifiedCount: 1 });
        },
      ),
      deleteOne: jest.fn(() => Promise.resolve({ deletedCount: 1 })),
    };

    const outboxCollection = {
      deleteMany: jest.fn(() => Promise.resolve({ deletedCount: 0 })),
    };

    const versionsCollection = {
      findOne: jest.fn((filter: Record<string, unknown>) => {
        if (filter['file.sha256']) {
          const all = [versionRow, ...otherVersionRows];
          const found = all.find((row) => {
            const file = row.file as
              { sha256?: string; size?: number; key?: string } | undefined;
            return (
              toIdStr(row.organizationId) === toIdStr(filter.organizationId) &&
              file?.sha256 === filter['file.sha256'] &&
              (filter['file.size'] === undefined ||
                file?.size === filter['file.size']) &&
              Boolean(file?.key)
            );
          });
          return Promise.resolve(found ? { ...found } : null);
        }
        if (
          filter.documentId &&
          toIdStr(filter.documentId) !== toIdStr(versionRow.documentId)
        ) {
          return Promise.resolve(null);
        }
        if (filter.status && filter.status !== versionRow.status) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ ...versionRow });
      }),
      find: jest.fn(() => ({
        toArray: () => Promise.resolve([{ ...versionRow }]),
        sort: () => ({
          toArray: () => Promise.resolve([{ ...versionRow }]),
        }),
      })),
      updateOne: jest.fn(
        (
          _filter: Record<string, unknown>,
          update: { $set?: Record<string, unknown> },
        ) => {
          if (update.$set) Object.assign(versionRow, update.$set);
          return Promise.resolve({ modifiedCount: 1 });
        },
      ),
      deleteMany: jest.fn(() => Promise.resolve({ deletedCount: 1 })),
      countDocuments: jest.fn(() => Promise.resolve(0)),
    };

    const db = {
      collection: (name: string) => {
        if (name === 'project_documents') return documentsCollection;
        if (name === 'project_document_versions') return versionsCollection;
        if (name === 'outbox_events') return outboxCollection;
        throw new Error(`Unexpected collection ${name}`);
      },
    };

    const connection = {
      db,
      startSession: () =>
        Promise.resolve({
          withTransaction: async <T>(fn: () => Promise<T>) => fn(),
          endSession: () => Promise.resolve(undefined),
        }),
    } as unknown as Connection;

    return {
      connection,
      docRow,
      versionRow,
      otherVersionRows,
      documentsCollection,
      versionsCollection,
    };
  }

  it('issues DIRECT_PUT intent, validates 64-byte magic prefix on confirm, and triggers zero-buffer SAG object ingest', async () => {
    const mongo = createInMemoryMongoStub();
    const authorization = {
      resolveProject: jest.fn().mockResolvedValue({
        userId: leaderId,
        userName: 'Project Leader',
        organizationId: orgId,
        projectId,
        canReview: true,
        canConfigure: true,
        isLeader: true,
      }),
    } as unknown as WorkNotesAuthorizationService;

    const storageGetMock = jest.fn();
    const storage = {
      isDirectCloudEnabled: jest.fn().mockReturnValue(true),
      createDirectUploadUrl: jest
        .fn()
        .mockResolvedValue(
          'https://r2.example.cloudflarestorage.com/presigned-put',
        ),
      createDirectDownloadUrl: jest
        .fn()
        .mockResolvedValue(
          'https://r2.example.cloudflarestorage.com/presigned-get',
        ),
      inspectStoredPrefix: jest.fn().mockResolvedValue({
        size: pdfBytes.length,
        contentType: 'application/pdf',
        prefix: pdfBytes.subarray(0, 16),
      }),
      get: storageGetMock,
      delete: jest.fn().mockResolvedValue(undefined),
    } as unknown as ProjectDocumentStorage;

    const uploadProjectDocumentMock = jest.fn();
    const ingestProjectDocumentObjectMock = jest.fn().mockResolvedValue({
      documentId: 'sag-doc-1',
      versionId: 'sag-ver-1',
      versionNo: 1,
      runId: 'sag-run-1',
      fileHash: pdfSha256,
      status: 'RECEIVED',
      searchStatus: 'PENDING',
      knowledgeStatus: 'NOT_STARTED',
      isDuplicate: false,
    });
    const sagTransport: SagKnowledgeSyncTransport = {
      uploadProjectDocument: uploadProjectDocumentMock,
      ingestProjectDocumentObject: ingestProjectDocumentObjectMock,
      revokeProjectDocument: jest.fn(),
    };

    const queuePublisher: CaptureQueuePublisher = {
      add: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const config = {
      get: jest.fn((key: string) => {
        if (key === 'DOCUMENT_UPLOAD_TOKEN_SECRET') {
          return 'unit-test-upload-signing-secret-32-chars-minimum';
        }
        return undefined;
      }),
    } as unknown as ConfigService;

    const service = new WorkNotesService(
      authorization,
      mongo.connection,
      { append: jest.fn() } as unknown as OutboxService,
      { append: jest.fn() } as unknown as AuditService,
      storage,
      undefined,
      sagTransport,
      queuePublisher,
      config,
    );

    const intent = await service.createDocumentUploadIntent(
      {},
      projectId,
      documentId,
      {
        fileName: 'architecture.pdf',
        contentType: 'application/pdf',
        size: pdfBytes.length,
        sha256: pdfSha256,
      },
    );

    expect(intent.mode).toBe('DIRECT_PUT');
    expect(intent.uploadUrl).toBe(
      'https://r2.example.cloudflarestorage.com/presigned-put',
    );
    expect(intent.headers).toEqual({ 'Content-Type': 'application/pdf' });
    expect(typeof intent.uploadToken).toBe('string');

    const confirmed = await service.confirmDocumentUpload(
      {},
      projectId,
      documentId,
      {
        uploadToken: intent.uploadToken!,
        autoSyncSag: true,
      },
    );

    expect(confirmed.status).toBe('APPROVED');
    expect(confirmed.file).toEqual({
      name: 'architecture.pdf',
      contentType: 'application/pdf',
      size: pdfBytes.length,
    });
    expect(confirmed.knowledgeSync).toMatchObject({
      sagDocumentId: 'sag-doc-1',
      sagVersionNo: 1,
      runId: 'sag-run-1',
      status: 'RECEIVED',
    });
    // Zero-buffer guarantee: DATN-BE never downloaded the full file from R2!
    expect(storageGetMock).not.toHaveBeenCalled();
    expect(uploadProjectDocumentMock).not.toHaveBeenCalled();
    expect(ingestProjectDocumentObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        documentId,
        sourceUrl: 'https://r2.example.cloudflarestorage.com/presigned-get',
        fileName: 'architecture.pdf',
        contentType: 'application/pdf',
        expectedSha256: pdfSha256,
        expectedSizeBytes: pdfBytes.length,
      }),
    );
  });

  it('short-circuits with DEDUPLICATED mode when an identical SHA-256 object already exists in R2 and rejects spoofed magic bytes', async () => {
    const existingKey = `work-notes/${orgId}/${projectId}/${documentId}/123e4567-e89b-42d3-a456-426614174000`;
    const mongo = createInMemoryMongoStub();
    mongo.otherVersionRows.push({
      organizationId: new Types.ObjectId(orgId),
      projectId: new Types.ObjectId(projectId),
      file: {
        key: existingKey,
        name: 'original.pdf',
        contentType: 'application/pdf',
        size: pdfBytes.length,
        sha256: pdfSha256,
      },
    });

    const authorization = {
      resolveProject: jest.fn().mockResolvedValue({
        userId: leaderId,
        userName: 'Project Leader',
        organizationId: orgId,
        projectId,
        canReview: true,
        canConfigure: true,
      }),
    } as unknown as WorkNotesAuthorizationService;

    const deleteMock = jest.fn().mockResolvedValue(undefined);
    const inspectMock = jest.fn().mockResolvedValue({
      size: pdfBytes.length,
      contentType: 'application/pdf',
      prefix: pdfBytes.subarray(0, 16),
    });
    const createUploadUrlMock = jest
      .fn()
      .mockResolvedValue('https://r2.example.cloudflarestorage.com/put-spoof');

    const storage = {
      isDirectCloudEnabled: jest.fn().mockReturnValue(true),
      createDirectUploadUrl: createUploadUrlMock,
      inspectStoredPrefix: inspectMock,
      delete: deleteMock,
    } as unknown as ProjectDocumentStorage;

    const service = new WorkNotesService(
      authorization,
      mongo.connection,
      undefined,
      { append: jest.fn() } as unknown as AuditService,
      storage,
    );

    const dedupIntent = await service.createDocumentUploadIntent(
      {},
      projectId,
      documentId,
      {
        fileName: 'duplicate-copy.pdf',
        contentType: 'application/pdf',
        size: pdfBytes.length,
        sha256: pdfSha256,
      },
    );
    expect(dedupIntent.mode).toBe('DEDUPLICATED');
    expect(createUploadUrlMock).not.toHaveBeenCalled();

    // Now test spoofed binary uploaded under a fresh DIRECT_PUT token: must be deleted from R2!
    const otherHash = 'f'.repeat(64);
    const freshIntent = await service.createDocumentUploadIntent(
      {},
      projectId,
      documentId,
      {
        fileName: 'spoofed.pdf',
        contentType: 'application/pdf',
        size: 16,
        sha256: otherHash,
      },
    );
    expect(freshIntent.mode).toBe('DIRECT_PUT');

    // Simulate attacker uploading a Windows PE executable ("MZ...") instead of %PDF-
    inspectMock.mockResolvedValueOnce({
      size: 16,
      contentType: 'application/pdf',
      prefix: Buffer.from('MZ\x90\x00\x03\x00\x00\x00spoofed!'),
    });

    await expect(
      service.confirmDocumentUpload({}, projectId, documentId, {
        uploadToken: freshIntent.uploadToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleteMock).toHaveBeenCalledTimes(1);

    // Cross-user token replay must also fail
    (authorization.resolveProject as jest.Mock).mockResolvedValueOnce({
      userId: otherUserId,
      userName: 'Other User',
      organizationId: orgId,
      projectId,
      canReview: false,
      canConfigure: false,
    });
    await expect(
      service.confirmDocumentUpload({}, projectId, documentId, {
        uploadToken: dedupIntent.uploadToken!,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces CSRF on upload-intent/confirm-upload and redirects native file downloads via 302 to R2', async () => {
    const csrfToken = 'csrf-secret-xyz';
    const downloadDocumentFileMock = jest.fn().mockResolvedValue({
      bytes: pdfBytes,
      name: 'spec.pdf',
      contentType: 'application/pdf',
    });
    const service = {
      createDocumentUploadIntent: jest
        .fn()
        .mockResolvedValue({ mode: 'LEGACY_PROXY' }),
      confirmDocumentUpload: jest.fn().mockResolvedValue({ id: documentId }),
      resolveDocumentFileDownloadUrl: jest.fn().mockResolvedValue({
        mode: 'DIRECT_GET',
        downloadUrl: 'https://r2.example.cloudflarestorage.com/direct-download',
        fileName: 'spec.pdf',
        contentType: 'application/pdf',
        expiresInSeconds: 120,
      }),
      downloadDocumentFile: downloadDocumentFileMock,
    } as unknown as WorkNotesService;

    const controller = new WorkNotesController(service);
    const badReq = Object.assign(Readable.from([]), {
      headers: {
        cookie: `continuum_session=s1; continuum_csrf=${csrfToken}`,
      },
    }) as unknown as Request;

    expect(() =>
      controller.createDocumentUploadIntent(badReq, projectId, documentId, {
        fileName: 'spec.pdf',
        contentType: 'application/pdf',
        size: 12,
        sha256: pdfSha256,
      }),
    ).toThrow(ForbiddenException);

    expect(() =>
      controller.confirmDocumentUpload(badReq, projectId, documentId, {
        uploadToken: 'v1.eyJ0ZXN0IjoxfQ.signature123456',
      }),
    ).toThrow(ForbiddenException);

    const setHeader = jest.fn();
    const status = jest.fn().mockReturnThis();
    const res = { setHeader, status } as unknown as Response;
    const getReq = Object.assign(Readable.from([]), {
      headers: { cookie: 'continuum_session=s1' },
    }) as unknown as Request;

    // 1. Native <a href> download -> 302 Found redirect directly to R2
    const redirectResult = await controller.downloadDocumentFile(
      getReq,
      res,
      projectId,
      documentId,
      {},
    );
    expect(redirectResult).toBeUndefined();
    expect(status).toHaveBeenCalledWith(HttpStatus.FOUND);
    expect(setHeader).toHaveBeenCalledWith(
      'Location',
      'https://r2.example.cloudflarestorage.com/direct-download',
    );
    expect(downloadDocumentFileMock).not.toHaveBeenCalled();

    // 2. ?format=url -> JSON direct URL descriptor
    const urlResult = await controller.downloadDocumentFile(
      getReq,
      res,
      projectId,
      documentId,
      { format: 'url' },
    );
    expect(urlResult).toMatchObject({
      mode: 'DIRECT_GET',
      downloadUrl: 'https://r2.example.cloudflarestorage.com/direct-download',
    });

    // 3. ?proxy=true -> StreamableFile fallback
    const proxyResult = await controller.downloadDocumentFile(
      getReq,
      res,
      projectId,
      documentId,
      { proxy: 'true' },
    );
    expect(proxyResult).toBeInstanceOf(StreamableFile);
    expect(downloadDocumentFileMock).toHaveBeenCalledTimes(1);
  });

  it('consumes BullMQ ingestion jobs via KnowledgeIngestionProcessor and hands off R2 URLs with KNOWLEDGE_OUTBOX_ASYNC_HANDOFF=true', async () => {
    const eventId = new Types.ObjectId('777777777777777777777777');
    let leased = false;
    const outboxUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const docUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const verUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

    const connection = {
      collection: (name: string) => {
        if (name === 'outbox_events') {
          return {
            findOneAndUpdate: jest.fn(() => {
              if (leased) return Promise.resolve(null);
              leased = true;
              return Promise.resolve({
                _id: eventId,
                eventName: 'KNOWLEDGE_SOURCE_APPROVED',
                aggregateType: 'PROJECT_DOCUMENT',
                aggregateId: documentId,
                status: 'PENDING',
                occurredAt: new Date(),
                payload: {
                  organizationId: orgId,
                  projectId,
                  version: 1,
                  delivery: { attemptCount: 1 },
                },
              });
            }),
            findOne: jest.fn().mockResolvedValue(null),
            updateOne: outboxUpdateOne,
          };
        }
        if (name === 'project_documents') {
          return {
            findOne: jest.fn().mockResolvedValue({
              _id: new Types.ObjectId(documentId),
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectId),
              status: 'APPROVED',
              currentVersionNumber: 1,
              latestApprovedVersionNumber: 1,
              updatedByUserId: new Types.ObjectId(leaderId),
            }),
            updateOne: docUpdateOne,
          };
        }
        if (name === 'project_document_versions') {
          return {
            findOne: jest.fn().mockResolvedValue({
              _id: new Types.ObjectId('666666666666666666666666'),
              documentId: new Types.ObjectId(documentId),
              versionNumber: 1,
              status: 'APPROVED',
              reviewedByUserId: new Types.ObjectId(leaderId),
              file: {
                key: `work-notes/${orgId}/${projectId}/${documentId}/123e4567-e89b-42d3-a456-426614174000`,
                name: 'report.pdf',
                contentType: 'application/pdf',
                size: pdfBytes.length,
                sha256: pdfSha256,
              },
            }),
            updateOne: verUpdateOne,
          };
        }
        throw new Error(`Unexpected collection ${name}`);
      },
    } as unknown as Connection;

    const storageGetSpy = jest.fn();
    const storage = {
      isDirectCloudEnabled: () => true,
      createDirectDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://r2.example.cloudflarestorage.com/sag-pull'),
      get: storageGetSpy,
    } as unknown as ProjectDocumentStorage;

    const getStatusSpy = jest.fn();
    const ingestSpy = jest.fn().mockResolvedValue({
      documentId: 'sag-doc-99',
      versionId: 'sag-ver-99',
      versionNo: 1,
      runId: 'sag-run-99',
      status: 'RECEIVED',
      searchStatus: 'PENDING',
      knowledgeStatus: 'NOT_STARTED',
      isDuplicate: false,
    });

    const transport: SagKnowledgeSyncTransport = {
      uploadProjectDocument: jest.fn(),
      ingestProjectDocumentObject: ingestSpy,
      getProjectDocumentVersionStatus: getStatusSpy,
      revokeProjectDocument: jest.fn(),
    };

    const config = {
      get: (key: string) =>
        key === 'KNOWLEDGE_OUTBOX_ASYNC_HANDOFF' ? 'true' : undefined,
    } as unknown as ConfigService;

    const consumer = new KnowledgeOutboxConsumer(
      connection,
      config,
      storage,
      transport,
    );
    const processor = new KnowledgeIngestionProcessor(consumer);

    const outcome = await processor.process({
      id: 'bull-job-1',
      name: QUEUE_NAMES.ingestion,
      data: {
        event: 'KNOWLEDGE_SOURCE_APPROVED',
        payload: { projectId, documentId, version: 1 },
      },
    } as never);

    expect(outcome).toEqual({
      documentId,
      outcomes: ['PUBLISHED'],
    });
    expect(storageGetSpy).not.toHaveBeenCalled();
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    // Async handoff enabled -> worker does NOT block in 90s status polling loop!
    expect(getStatusSpy).not.toHaveBeenCalled();
    expect(docUpdateOne).toHaveBeenCalledTimes(1);
    expect(verUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('resets progress to 0% on REPROCESS and builds chronological activityHistory across all lifecycle and AI actions', async () => {
    const fileKey = `work-notes/${orgId}/${projectId}/${documentId}/123e4567-e89b-42d3-a456-426614174000`;
    const mongo = createInMemoryMongoStub({
      key: fileKey,
      name: 'architecture.pdf',
      contentType: 'application/pdf',
      size: pdfBytes.length,
      sha256: pdfSha256,
    });
    mongo.docRow.status = 'APPROVED';
    mongo.docRow.latestApprovedVersionNumber = 1;
    mongo.versionRow.status = 'APPROVED';
    mongo.versionRow.knowledgeSync = {
      documentId,
      version: 1,
      sagDocumentId: 'sag-doc-1',
      sagVersionNo: 1,
      status: 'READY',
      searchStatus: 'SEARCH_READY',
      knowledgeStatus: 'KNOWLEDGE_READY',
      searchReady: true,
      knowledgeReady: true,
      currentStage: 'COMPLETE',
      documentStatus: 'indexed',
      progress: 100,
      chunkCount: 12,
      syncedAt: '2026-10-29T12:01:00.000Z',
    };
    mongo.docRow.knowledgeSync = mongo.versionRow.knowledgeSync;

    const auditEvents: Array<Record<string, unknown>> = [
      {
        id: 'aud-1',
        actorUserId: leaderId,
        action: 'DOCUMENT_DRAFT_CREATED',
        targetResource: 'PROJECT_DOCUMENT',
        targetResourceId: documentId,
        occurredAt: '2026-10-29T12:00:00.000Z',
        metadata: { version: 1 },
      },
      {
        id: 'aud-2',
        actorUserId: leaderId,
        action: 'DOCUMENT_FILE_UPLOADED',
        targetResource: 'PROJECT_DOCUMENT',
        targetResourceId: documentId,
        occurredAt: '2026-10-29T12:00:15.000Z',
        metadata: {
          version: 1,
          fileName: 'architecture.pdf',
          size: pdfBytes.length,
          deduplicated: false,
          directCloud: true,
        },
      },
      {
        id: 'aud-3',
        actorUserId: leaderId,
        action: 'DOCUMENT_AUTO_APPROVED',
        targetResource: 'PROJECT_DOCUMENT',
        targetResourceId: documentId,
        occurredAt: '2026-10-29T12:00:16.000Z',
        metadata: { version: 1 },
      },
      {
        id: 'aud-4',
        actorUserId: leaderId,
        action: 'DOCUMENT_KNOWLEDGE_SYNCED',
        targetResource: 'PROJECT_DOCUMENT',
        targetResourceId: documentId,
        occurredAt: '2026-10-29T12:00:17.000Z',
        metadata: { version: 1, sagDocumentId: 'sag-doc-1', sagVersionNo: 1 },
      },
    ];

    const auditService = {
      append: jest.fn((event: Record<string, unknown>) => {
        auditEvents.push({
          id: `aud-${auditEvents.length + 1}`,
          actorUserId: event.actorUserId,
          action: event.action,
          targetResource: event.targetResource,
          targetResourceId: event.targetResourceId,
          occurredAt: '2026-10-29T12:05:00.000Z',
          metadata: event.metadata,
        });
        return Promise.resolve();
      }),
      listForTarget: jest.fn(() => Promise.resolve([...auditEvents])),
    } as unknown as AuditService;

    const authorization = {
      resolveProject: jest.fn().mockResolvedValue({
        userId: leaderId,
        userName: 'Project Leader',
        organizationId: orgId,
        projectId,
        canReview: true,
        canConfigure: true,
      }),
    } as unknown as WorkNotesAuthorizationService;

    const controlProjectDocumentMock = jest.fn().mockResolvedValue({
      documentId: 'sag-doc-1',
      action: 'REPROCESS',
      accepted: true,
      status: 'pending',
      message: 'Reprocessing scheduled.',
    });
    const sagTransport: SagKnowledgeSyncTransport = {
      uploadProjectDocument: jest.fn(),
      revokeProjectDocument: jest.fn(),
      controlProjectDocument: controlProjectDocumentMock,
    };

    const service = new WorkNotesService(
      authorization,
      mongo.connection,
      undefined,
      auditService,
      undefined,
      undefined,
      sagTransport,
    );

    const reprocessed = await service.controlDocumentKnowledge(
      {},
      projectId,
      documentId,
      'REPROCESS',
    );

    expect(reprocessed).toMatchObject({
      status: 'RECEIVED',
      searchStatus: 'PENDING',
      searchReady: false,
      knowledgeReady: false,
      currentStage: 'RECEIVE',
      documentStatus: 'pending',
      progress: 0,
      chunkCount: 0,
    });
    expect(controlProjectDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sagDocumentId: 'sag-doc-1',
        action: 'reprocess',
        actorUserId: leaderId,
      }),
    );

    const fullDoc = await service.getDocument({}, projectId, documentId);
    expect(fullDoc.activityHistory?.map((item) => item.action)).toEqual([
      'CREATED',
      'FILE_UPLOADED',
      'AUTO_APPROVED',
      'KNOWLEDGE_SYNCED',
      'KNOWLEDGE_REPROCESSED',
    ]);
    expect(fullDoc.activityHistory?.[1]).toMatchObject({
      action: 'FILE_UPLOADED',
      version: 1,
      fileName: 'architecture.pdf',
      deduplicated: false,
    });
  });

  it('permanently deletes unreferenced R2 objects on deleteDocument while preserving deduplicated R2 objects referenced by other versions', async () => {
    const sharedOrUniqueKey = `work-notes/${orgId}/${projectId}/${documentId}/123e4567-e89b-42d3-a456-426614174000`;
    const mongo = createInMemoryMongoStub({
      key: sharedOrUniqueKey,
      name: 'architecture.pdf',
      contentType: 'application/pdf',
      size: pdfBytes.length,
      sha256: pdfSha256,
    });
    mongo.docRow.status = 'APPROVED';
    mongo.versionRow.status = 'APPROVED';
    mongo.docRow.knowledgeSync = {
      documentId,
      version: 1,
      sagDocumentId: 'sag-doc-del-1',
      sagVersionNo: 1,
      status: 'READY',
      searchReady: true,
      knowledgeReady: true,
      progress: 100,
      syncedAt: '2026-10-29T12:01:00.000Z',
    };

    const resolveProjectMock = jest.fn().mockResolvedValue({
      userId: leaderId,
      userName: 'Project Leader',
      organizationId: orgId,
      projectId,
      canReview: true,
      canConfigure: true,
    });
    const authorization = {
      resolveProject: resolveProjectMock,
    } as unknown as WorkNotesAuthorizationService;

    const storageDeleteMock = jest.fn().mockResolvedValue(undefined);
    const storage = {
      isDirectCloudEnabled: jest.fn().mockReturnValue(true),
      delete: storageDeleteMock,
    } as unknown as ProjectDocumentStorage;

    const revokeMock = jest.fn().mockResolvedValue({ revokedCount: 1 });
    const sagTransport: SagKnowledgeSyncTransport = {
      uploadProjectDocument: jest.fn(),
      revokeProjectDocument: revokeMock,
    };

    const service = new WorkNotesService(
      authorization,
      mongo.connection,
      undefined,
      { append: jest.fn() } as unknown as AuditService,
      storage,
      undefined,
      sagTransport,
    );

    const inspected = await service.getDocument({}, projectId, documentId);
    expect(inspected.storageReference).toEqual({
      provider: 'CLOUDFLARE_R2',
      objectCount: 1,
      deletableObjectCount: 1,
      sharedObjectCount: 0,
      refCount: 1,
      externalDocumentRefs: 0,
      willDeleteFromStorage: true,
      sha256: pdfSha256,
    });

    // 1. Non-leader member cannot delete an APPROVED document
    resolveProjectMock.mockResolvedValueOnce({
      userId: otherUserId,
      userName: 'Regular Member',
      organizationId: orgId,
      projectId,
      canReview: false,
      canConfigure: false,
    });
    await expect(
      service.deleteDocument({}, projectId, documentId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storageDeleteMock).not.toHaveBeenCalled();

    // 2. Deduplicated R2 object (remainingRefs = 1) -> DB & SAG revoked, R2 object preserved!
    mongo.versionsCollection.countDocuments.mockResolvedValueOnce(1);
    const sharedOutcome = await service.deleteDocument(
      {},
      projectId,
      documentId,
    );
    expect(sharedOutcome).toEqual({
      deletedDocumentId: documentId,
      sagRevoked: true,
      r2DeletedKeys: 0,
      r2RetainedSharedKeys: 1,
    });
    expect(revokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        documentId,
        reason: 'DOCUMENT_DELETED',
      }),
    );
    expect(mongo.documentsCollection.deleteOne).toHaveBeenCalledTimes(1);
    expect(mongo.versionsCollection.deleteMany).toHaveBeenCalledTimes(1);
    expect(storageDeleteMock).not.toHaveBeenCalled();

    // 3. Unique R2 object (remainingRefs = 0) -> R2 object permanently deleted!
    mongo.versionsCollection.countDocuments.mockResolvedValueOnce(0);
    const uniqueOutcome = await service.deleteDocument(
      {},
      projectId,
      documentId,
    );
    expect(uniqueOutcome).toEqual({
      deletedDocumentId: documentId,
      sagRevoked: true,
      r2DeletedKeys: 1,
      r2RetainedSharedKeys: 0,
    });
    expect(storageDeleteMock).toHaveBeenCalledWith(sharedOrUniqueKey);
  });
});
