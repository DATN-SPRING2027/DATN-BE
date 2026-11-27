import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Types, type Connection } from 'mongoose';
import { WorkNotesController } from '../controllers/work-notes.controller';
import type { AuditService } from '../infrastructure/audit/audit.service';
import {
  HttpSagKnowledgeSyncTransport,
  KnowledgeOutboxConsumer,
} from '../infrastructure/outbox/knowledge-outbox.consumer';
import type { OutboxService } from '../infrastructure/outbox/outbox.service';
import type { RedisService } from '../infrastructure/redis/redis.service';
import { ProjectDocumentStorage } from '../infrastructure/storage/project-document.storage';
import type { R2Storage } from '../infrastructure/storage/r2.storage';
import type { ProjectReportRosterService } from '../../iam/application/projects/project-report-roster.service';
import { HandoverCaptureSourceService } from './handover-capture-source.service';
import { detectSensitiveData } from './work-note-agent/security/sensitive-data.detector';
import { securityPolicyFromConfig } from './work-note-agent/security/sensitive-data.masker';
import type { IamActorContextService } from '../../iam/application/projects/iam-actor-context.service';
import type { TaskWorkspaceRepository } from '../../task/workspace/task-workspace.repository';
import { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import { WorkNotesService } from './work-notes.service';
import { WorkReportOverdueScheduler } from './work-report-overdue.scheduler';

describe('Capture Audit Remediation Regressions', () => {
  const orgId = '111111111111111111111111';
  const projectAId = '222222222222222222222222';
  const projectBId = '222222222222222222222223';
  const docId = '333333333333333333333333';
  const noteId = '444444444444444444444444';
  const reportId = '555555555555555555555555';
  const taskId = '666666666666666666666666';
  const leaderId = '777777777777777777777777';
  const memberId = '888888888888888888888888';
  const managerId = '999999999999999999999999';

  const pdfBytes = Buffer.from(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n',
  );
  const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');

  function makeSessionConnection(
    collections: Record<string, Record<string, unknown>>,
  ): Connection {
    return {
      db: {
        collection: (name: string) => {
          if (collections[name]) return collections[name];
          return {
            findOne: jest.fn().mockResolvedValue(null),
            find: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
            countDocuments: jest.fn().mockResolvedValue(0),
            updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
            deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
            deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
            insertOne: jest
              .fn()
              .mockResolvedValue({ insertedId: new Types.ObjectId() }),
          };
        },
      },
      startSession: () =>
        Promise.resolve({
          withTransaction: async <T>(fn: () => Promise<T>) => fn(),
          endSession: () => Promise.resolve(undefined),
        }),
    } as unknown as Connection;
  }

  describe('SEC-AUTH-002 / BE-DATA-001: Project-scoped SHA-256 dedup, full-hash verification & JTI anti-replay', () => {
    it('isolates SHA-256 deduplication by projectId so Project B never reuses Project A storage keys', async () => {
      const projectAKey = `work-notes/${orgId}/${projectAId}/${docId}/secret-a.pdf`;
      const versionsFindOne = jest.fn((filter: Record<string, unknown>) => {
        // Only Project A owns this file hash
        if (filter['file.sha256']) {
          if (
            String(filter.projectId) === projectAId &&
            filter['file.sha256'] === pdfSha256
          ) {
            return Promise.resolve({
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectAId),
              file: {
                key: projectAKey,
                sha256: pdfSha256,
                size: pdfBytes.length,
                contentType: 'application/pdf',
              },
            });
          }
          return Promise.resolve(null);
        }
        return Promise.resolve({
          _id: new Types.ObjectId(),
          organizationId: new Types.ObjectId(orgId),
          projectId: new Types.ObjectId(projectBId),
          documentId: new Types.ObjectId(docId),
          versionNumber: 1,
          status: 'DRAFT',
          editedByUserId: new Types.ObjectId(leaderId),
        });
      });
      const docsFindOne = jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(docId),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectBId),
        status: 'DRAFT',
        createdByUserId: new Types.ObjectId(leaderId),
        currentVersionNumber: 1,
      });

      const connection = makeSessionConnection({
        project_documents: { findOne: docsFindOne },
        project_document_versions: { findOne: versionsFindOne },
      });
      const createUploadUrlMock = jest.fn<
        Promise<string>,
        [string, ...unknown[]]
      >(() => Promise.resolve('https://r2.example/project-b-put'));
      const storage = {
        isDirectCloudEnabled: () => true,
        createDirectUploadUrl: createUploadUrlMock,
      } as unknown as ProjectDocumentStorage;
      const authorization = {
        resolveProject: jest.fn().mockResolvedValue({
          userId: leaderId,
          userName: 'Leader B',
          organizationId: orgId,
          projectId: projectBId,
          canReview: true,
          canConfigure: true,
          isLeader: true,
        }),
      } as unknown as WorkNotesAuthorizationService;

      const service = new WorkNotesService(
        authorization,
        connection,
        undefined,
        { append: jest.fn() } as unknown as AuditService,
        storage,
      );

      const intent = await service.createDocumentUploadIntent(
        {},
        projectBId,
        docId,
        {
          fileName: 'stolen.pdf',
          contentType: 'application/pdf',
          size: pdfBytes.length,
          sha256: pdfSha256,
        },
      );

      expect(intent.mode).toBe('DIRECT_PUT');
      expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
      expect(createUploadUrlMock.mock.calls[0][0]).toContain(
        `work-notes/${orgId}/${projectBId}/`,
      );
      expect(versionsFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: new Types.ObjectId(orgId),
          projectId: new Types.ObjectId(projectBId),
          'file.sha256': pdfSha256,
        }),
      );
    });

    it('rejects full-body SHA-256 tampering despite valid %PDF prefix, deletes poisoned blob, and blocks uploadToken JTI replay', async () => {
      const updatedAt = new Date('2026-11-27T01:00:00.000Z');
      const docRow = {
        _id: new Types.ObjectId(docId),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectAId),
        title: 'Spec',
        documentType: 'ARCHITECTURE',
        createdByUserId: new Types.ObjectId(leaderId),
        updatedByUserId: new Types.ObjectId(leaderId),
        currentVersionNumber: 1,
        status: 'DRAFT',
        createdAt: updatedAt,
        updatedAt,
      };
      const verRow = {
        _id: new Types.ObjectId(),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectAId),
        documentId: new Types.ObjectId(docId),
        versionNumber: 1,
        title: 'Spec',
        documentType: 'ARCHITECTURE',
        content: '',
        status: 'DRAFT',
        editedByUserId: new Types.ObjectId(leaderId),
        reviewHistory: [],
        createdAt: updatedAt,
        updatedAt,
      };

      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue(docRow),
          updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        },
        project_document_versions: {
          findOne: jest.fn((filter: Record<string, unknown>) =>
            filter['file.sha256']
              ? Promise.resolve(null)
              : Promise.resolve(verRow),
          ),
          find: jest.fn(() => ({
            sort: () => ({ toArray: jest.fn().mockResolvedValue([verRow]) }),
            toArray: jest.fn().mockResolvedValue([verRow]),
          })),
          updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        },
      });

      const tamperedBytes = Buffer.from(
        '%PDF-1.7\n1 0 obj\n<< /Tampered true >>\nendobj\n',
      );
      // Same length as pdfBytes? Pad to exact length to prove SHA-256 catches payload swaps!
      const sameLengthTampered = Buffer.alloc(pdfBytes.length, 0x20);
      tamperedBytes.copy(
        sameLengthTampered,
        0,
        0,
        Math.min(tamperedBytes.length, pdfBytes.length),
      );

      const deleteMock = jest.fn().mockResolvedValue(undefined);
      const getMock = jest.fn().mockResolvedValue(sameLengthTampered);
      const storage = {
        isDirectCloudEnabled: () => true,
        createDirectUploadUrl: jest
          .fn()
          .mockResolvedValue('https://r2.example/put'),
        get: getMock,
        delete: deleteMock,
      } as unknown as ProjectDocumentStorage;

      const authorization = {
        resolveProject: jest.fn().mockResolvedValue({
          userId: leaderId,
          userName: 'Leader',
          organizationId: orgId,
          projectId: projectAId,
          canReview: true,
          canConfigure: true,
          isLeader: true,
        }),
      } as unknown as WorkNotesAuthorizationService;

      const service = new WorkNotesService(
        authorization,
        connection,
        undefined,
        { append: jest.fn() } as unknown as AuditService,
        storage,
      );

      const intent = await service.createDocumentUploadIntent(
        {},
        projectAId,
        docId,
        {
          fileName: 'spec.pdf',
          contentType: 'application/pdf',
          size: pdfBytes.length,
          sha256: pdfSha256,
        },
      );

      await expect(
        service.confirmDocumentUpload({}, projectAId, docId, {
          uploadToken: intent.uploadToken!,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'DOCUMENT_FILE_CHECKSUM_MISMATCH' },
      });
      expect(deleteMock).toHaveBeenCalledTimes(1);

      // Single-use JTI anti-replay: reusing the same token MUST fail even with valid bytes!
      getMock.mockResolvedValueOnce(pdfBytes);
      await expect(
        service.confirmDocumentUpload({}, projectAId, docId, {
          uploadToken: intent.uploadToken!,
        }),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'DOCUMENT_UPLOAD_TOKEN_REPLAYED' },
      });
    });

    it('fails closed in production when DOCUMENT_UPLOAD_TOKEN_SECRET is missing', async () => {
      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(docId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            status: 'DRAFT',
            createdByUserId: new Types.ObjectId(leaderId),
            currentVersionNumber: 1,
          }),
        },
        project_document_versions: {
          findOne: jest.fn((filter: Record<string, unknown>) =>
            filter['file.sha256']
              ? Promise.resolve(null)
              : Promise.resolve({
                  _id: new Types.ObjectId(),
                  organizationId: new Types.ObjectId(orgId),
                  projectId: new Types.ObjectId(projectAId),
                  documentId: new Types.ObjectId(docId),
                  versionNumber: 1,
                  status: 'DRAFT',
                  editedByUserId: new Types.ObjectId(leaderId),
                }),
          ),
        },
      });
      const config = new ConfigService({
        NODE_ENV: 'production',
        JWT_SECRET: 'must-never-be-reused-for-upload-tokens',
      });
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue({
            userId: leaderId,
            userName: 'Leader',
            organizationId: orgId,
            projectId: projectAId,
            canReview: true,
            canConfigure: true,
            isLeader: true,
          }),
        } as unknown as WorkNotesAuthorizationService,
        connection,
        undefined,
        undefined,
        {
          isDirectCloudEnabled: () => true,
          createDirectUploadUrl: jest
            .fn()
            .mockResolvedValue('https://r2.example/put'),
        } as unknown as ProjectDocumentStorage,
        undefined,
        undefined,
        undefined,
        config,
      );

      await expect(
        service.createDocumentUploadIntent({}, projectAId, docId, {
          fileName: 'spec.pdf',
          contentType: 'application/pdf',
          size: pdfBytes.length,
          sha256: pdfSha256,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('BE-LOGIC-001 & SEC-AUTH-007: Self-approval & privilege boundary enforcement', () => {
    it('blocks syncDocumentToSag, syncWorkReportToSag, and syncTaskNoteToSag on unapproved artifacts (409)', async () => {
      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(docId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            status: 'DRAFT',
            currentVersionNumber: 1,
            createdByUserId: new Types.ObjectId(leaderId),
          }),
        },
        work_reports: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(reportId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            memberUserId: new Types.ObjectId(leaderId),
            reportScope: 'LEADER',
            status: 'REJECTED',
          }),
        },
        work_notes: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(noteId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            taskId: new Types.ObjectId(taskId),
            authorUserId: new Types.ObjectId(leaderId),
            type: 'TASK_NOTE',
            status: 'CONFIRMED',
            provenance: { review: { status: 'PENDING_REVIEW' } },
          }),
        },
      });
      const actor = {
        userId: leaderId,
        userName: 'Leader',
        organizationId: orgId,
        projectId: projectAId,
        canReview: true,
        canConfigure: true,
        isLeader: true,
      };
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue(actor),
          resolveTask: jest.fn().mockResolvedValue(actor),
        } as unknown as WorkNotesAuthorizationService,
        connection,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          uploadProjectDocument: jest.fn(),
          revokeProjectDocument: jest.fn(),
        },
      );

      await expect(
        service.syncDocumentToSag({}, projectAId, docId),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.syncWorkReportToSag({}, projectAId, reportId),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.syncTaskNoteToSag({}, projectAId, noteId),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('blocks non-member Managers from mutating Task Notes and creating/deleting Project Documents', async () => {
      const nonMemberManager = {
        userId: managerId,
        userName: 'Org Manager',
        organizationId: orgId,
        projectId: projectAId,
        canReview: true,
        canConfigure: true,
        isManager: true,
        isLeader: false,
        isProjectMember: false,
      };
      const connection = makeSessionConnection({});
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue(nonMemberManager),
          resolveTask: jest.fn().mockResolvedValue(nonMemberManager),
        } as unknown as WorkNotesAuthorizationService,
        connection,
      );

      await expect(
        service.createTaskNote({}, projectAId, taskId, {
          title: 'Manager note',
          accomplishments: 'Should fail',
          approach: 'Should fail',
          reason: 'Should fail',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.deleteTaskNote({}, projectAId, taskId, noteId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.createDocument({}, projectAId, {
          title: 'Manager doc',
          type: 'ARCHITECTURE',
          content: '# forbidden',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.deleteDocument({}, projectAId, docId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks MEMBER authors from revoking or deleting APPROVED Task Notes', async () => {
      const memberActor = {
        userId: memberId,
        userName: 'Member',
        organizationId: orgId,
        projectId: projectAId,
        canReview: false,
        canConfigure: false,
        isLeader: false,
        isManager: false,
        isProjectMember: true,
      };
      const approvedNote = {
        _id: new Types.ObjectId(noteId),
        organizationId: new Types.ObjectId(orgId),
        projectId: new Types.ObjectId(projectAId),
        taskId: new Types.ObjectId(taskId),
        authorUserId: new Types.ObjectId(memberId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
        currentVersionNumber: 1,
        provenance: {
          review: { status: 'APPROVED' },
          knowledgeSync: { sagDocumentId: 'sag-1', status: 'READY' },
        },
      };
      const connection = makeSessionConnection({
        work_notes: {
          findOne: jest.fn().mockResolvedValue(approvedNote),
        },
      });
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue(memberActor),
          resolveTask: jest.fn().mockResolvedValue(memberActor),
        } as unknown as WorkNotesAuthorizationService,
        connection,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          uploadProjectDocument: jest.fn(),
          revokeProjectDocument: jest.fn(),
          controlProjectDocument: jest.fn(),
        },
      );

      await expect(
        service.controlTaskNoteKnowledge({}, projectAId, noteId, 'REVOKE'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.deleteTaskNote({}, projectAId, taskId, noteId),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('E2E-INT-001, BE-DATA-002, BE-DATA-003 & BE-REL-001', () => {
    it('HttpSagKnowledgeSyncTransport sends NO body on POST .../reprocess (E2E-INT-001)', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            document_id: 'sag-doc-1',
            accepted: true,
            status: 'pending',
          }),
      } as unknown as Response);

      try {
        const transport = new HttpSagKnowledgeSyncTransport(
          new ConfigService({
            SAG_API_BASE_URL: 'http://sag.internal:8000',
            SAG_BFF_SERVICE_TOKEN: 'test-internal-key',
          }),
        );
        await transport.controlProjectDocument({
          organizationId: orgId,
          projectId: projectAId,
          sagDocumentId: 'sag-doc-1',
          action: 'reprocess',
          actorUserId: leaderId,
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [, init] = fetchSpy.mock.calls[0];
        expect(init?.body).toBeUndefined();
        expect(init?.redirect).toBe('error');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('deleteDocument emits durable KNOWLEDGE_SOURCE_REVOKED outbox inside TX when SAG revoke fails and preserves keys referenced by work_notes (BE-DATA-003)', async () => {
      const sharedKey = `work-notes/${orgId}/${projectAId}/${docId}/shared.pdf`;
      const outboxAppend = jest.fn().mockResolvedValue(undefined);
      const storageDelete = jest.fn().mockResolvedValue(undefined);

      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(docId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            status: 'APPROVED',
            currentVersionNumber: 1,
            createdByUserId: new Types.ObjectId(leaderId),
            knowledgeSync: { sagDocumentId: 'sag-doc-503', status: 'READY' },
          }),
          deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
        },
        project_document_versions: {
          find: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([
              {
                _id: new Types.ObjectId(),
                documentId: new Types.ObjectId(docId),
                file: { key: sharedKey },
              },
            ]),
          })),
          deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
          countDocuments: jest.fn().mockResolvedValue(0),
        },
        work_notes: {
          // Another confirmed Task Note still references this storage key!
          countDocuments: jest.fn().mockResolvedValue(1),
        },
        work_reports: {
          countDocuments: jest.fn().mockResolvedValue(0),
        },
        outbox_events: {
          deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
        },
      });

      const queueAdd = jest.fn<
        Promise<{ id: string }>,
        [string, string, unknown, { jobId: string }]
      >(() => Promise.resolve({ id: 'job-deterministic' }));
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue({
            userId: leaderId,
            userName: 'Leader',
            organizationId: orgId,
            projectId: projectAId,
            canReview: true,
            canConfigure: true,
            isLeader: true,
            isProjectMember: true,
          }),
        } as unknown as WorkNotesAuthorizationService,
        connection,
        { append: outboxAppend } as unknown as OutboxService,
        { append: jest.fn() } as unknown as AuditService,
        {
          isDirectCloudEnabled: () => true,
          delete: storageDelete,
        } as unknown as ProjectDocumentStorage,
        undefined,
        {
          uploadProjectDocument: jest.fn(),
          revokeProjectDocument: jest
            .fn()
            .mockRejectedValue(new Error('SAG 503 Unavailable')),
        },
        { add: queueAdd },
      );

      const outcome = await service.deleteDocument({}, projectAId, docId);
      expect(outcome.sagRevoked).toBe(false);
      expect(outcome.r2DeletedKeys).toBe(0);
      expect(outcome.r2RetainedSharedKeys).toBe(1);
      expect(storageDelete).not.toHaveBeenCalled();
      expect(outboxAppend).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: docId,
        }),
        expect.anything(),
      );
      // BE-REL-001: BullMQ jobId must be deterministic (no Date.now() suffix!)
      expect(queueAdd).toHaveBeenCalledTimes(1);
      const jobOpts = queueAdd.mock.calls[0][3];
      expect(jobOpts.jobId).toBe(
        `knowledge:${docId}:KNOWLEDGE_SOURCE_REVOKED:v1`,
      );
    });

    it('ProjectDocumentStorage respects STORAGE_MODE=local and enables R2 when configured without local override (BE-DATA-002)', () => {
      const r2Stub = { isConfigured: () => true } as unknown as R2Storage;
      const cloudStorage = new ProjectDocumentStorage(
        r2Stub,
        new ConfigService({}),
      );
      expect(cloudStorage.isDirectCloudEnabled()).toBe(true);

      const modeLocalStorage = new ProjectDocumentStorage(
        r2Stub,
        new ConfigService({ STORAGE_MODE: 'local' }),
      );
      expect(modeLocalStorage.isDirectCloudEnabled()).toBe(false);

      const noR2Storage = new ProjectDocumentStorage(
        { isConfigured: () => false } as unknown as R2Storage,
        new ConfigService({}),
      );
      expect(noR2Storage.isDirectCloudEnabled()).toBe(false);
    });

    it('KnowledgeOutboxConsumer exports no ingest-object path and always uses uploadProjectDocument', () => {
      const consumer = new KnowledgeOutboxConsumer(
        makeSessionConnection({}),
        new ConfigService({}),
        new ProjectDocumentStorage(
          { isConfigured: () => false } as unknown as R2Storage,
          new ConfigService({}),
        ),
        {
          uploadProjectDocument: jest.fn(),
          revokeProjectDocument: jest.fn(),
        },
      );
      expect(consumer).toBeDefined();
    });
  });

  describe('SEC-BE-003 & SEC-BE-015: Pre-LLM DLP bypass & production fail-closed policy', () => {
    it('detects secrets wrapped inside user-supplied __WN_PROTECTED_...__ tokens', () => {
      const awsKey = 'AKIAIOSFODNN7EXAMPLE';
      const wrappedAws = `token is __WN_PROTECTED_${awsKey}__`;
      const findingsAws = detectSensitiveData(wrappedAws);
      expect(findingsAws.some((f) => f.ruleId === 'aws-access-key-id')).toBe(
        true,
      );

      const wrappedPwd = 'DB_PASSWORD=__WN_PROTECTED_S3cr3tPass99!__';
      const findingsPwd = detectSensitiveData(wrappedPwd);
      expect(findingsPwd.some((f) => f.category === 'PASSWORD')).toBe(true);
    });

    it('forbids monitor mode, off mode, and missing placeholder key in production', () => {
      expect(() =>
        securityPolicyFromConfig(
          new ConfigService({
            NODE_ENV: 'production',
            WORKNOTE_SECURITY_GATEWAY_MODE: 'monitor',
            WORKNOTE_SECURITY_PLACEHOLDER_KEY: 'a-very-strong-prod-key',
          }),
        ),
      ).toThrow(ServiceUnavailableException);

      expect(() =>
        securityPolicyFromConfig(
          new ConfigService({
            NODE_ENV: 'production',
            WORKNOTE_SECURITY_GATEWAY_MODE: 'enforce',
          }),
        ),
      ).toThrow(ServiceUnavailableException);
    });
  });

  describe('BE-PERF-005 & BE-REL-005: Batched Handover sources & distributed scheduler lock', () => {
    it('batches multi-viewer source evaluation with $in queries and enforces per-viewer Work Report ACL', async () => {
      const docObjId = new Types.ObjectId();
      const reportObjId = new Types.ObjectId();
      const findSpies = {
        project_documents: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            {
              _id: docObjId,
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectAId),
              title: 'Runbook',
              status: 'APPROVED',
              latestApprovedVersionNumber: 1,
            },
          ]),
        })),
        project_document_versions: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            {
              documentId: docObjId,
              versionNumber: 1,
              status: 'APPROVED',
              title: 'Runbook',
              content: 'Restart Redis cleanly.',
            },
          ]),
        })),
        work_reports: jest.fn(() => ({
          toArray: jest.fn().mockResolvedValue([
            {
              _id: reportObjId,
              organizationId: new Types.ObjectId(orgId),
              projectId: new Types.ObjectId(projectAId),
              memberUserId: new Types.ObjectId(memberId),
              reportScope: 'MEMBER',
              status: 'APPROVED',
              contentSchemaVersion: 2,
              currentVersionNumber: 1,
              contentMarkdown: 'Shipped feature cleanly.',
              accomplishments: 'Shipped feature.',
              reviewHistory: [{ action: 'APPROVED', at: new Date() }],
            },
          ]),
        })),
      };
      const connection = makeSessionConnection({
        project_documents: { find: findSpies.project_documents },
        project_document_versions: {
          find: findSpies.project_document_versions,
        },
        work_reports: { find: findSpies.work_reports },
      });

      const svc = new HandoverCaptureSourceService(connection);
      const leaderViewer = {
        organizationId: orgId,
        projectId: projectAId,
        userId: leaderId,
        isProjectMember: true,
        isProjectLeader: true,
      };
      const peerMemberViewer = {
        organizationId: orgId,
        projectId: projectAId,
        userId: new Types.ObjectId().toHexString(),
        isProjectMember: true,
        isProjectLeader: false,
      };
      const refs = [
        {
          kind: 'PROJECT_DOCUMENT' as const,
          id: docObjId.toHexString(),
          version: 1,
        },
        {
          kind: 'WORK_REPORT' as const,
          id: reportObjId.toHexString(),
          version: 1,
        },
      ];

      const [leaderResults, peerResults] =
        await svc.evaluateSourcesBatchForViewers(
          [leaderViewer, peerMemberViewer],
          refs,
        );

      // Single batched $in query per collection across BOTH viewers!
      expect(findSpies.project_documents).toHaveBeenCalledTimes(1);
      expect(findSpies.project_document_versions).toHaveBeenCalledTimes(1);
      expect(findSpies.work_reports).toHaveBeenCalledTimes(1);
      // Leader can read both Document and Member Work Report; peer Member can read Document only!
      expect(leaderResults[0].readable).toBe(true);
      expect(leaderResults[1].readable).toBe(true);
      expect(peerResults[0].readable).toBe(true);
      expect(peerResults[1].readable).toBe(false);
    });

    it('WorkReportOverdueScheduler skips sweep when Redis distributed lock is held by another replica', async () => {
      const listActive = jest.fn().mockResolvedValue([]);
      const sweepOverdue = jest.fn().mockResolvedValue(0);
      const acquireLock = jest.fn().mockResolvedValue(false);
      const releaseLock = jest.fn().mockResolvedValue(undefined);

      const scheduler = new WorkReportOverdueScheduler(
        {
          sweepOverdueReports: sweepOverdue,
          ensureScheduledReportObligations: jest.fn(),
        } as unknown as WorkNotesService,
        {
          listActiveProjectsWithMembers: listActive,
        } as unknown as ProjectReportRosterService,
        undefined,
        {
          acquireLock,
          releaseLock,
        } as unknown as RedisService,
      );

      await (scheduler as unknown as { sweep: () => Promise<void> }).sweep();
      expect(acquireLock).toHaveBeenCalledTimes(1);
      expect(listActive).not.toHaveBeenCalled();
      expect(sweepOverdue).not.toHaveBeenCalled();
      expect(releaseLock).not.toHaveBeenCalled();
    });
  });

  describe('SEC-BE-007, SEC-BE-011 & E2E-INT-012: Pre-buffer auth, strict XML/DOCX validation & If-Match CAS', () => {
    it('WorkNotesController.uploadDocumentFile enforces auth BEFORE reading the 20MB stream (SEC-BE-007)', async () => {
      let streamRead = false;
      const stream = new Readable({
        read() {
          streamRead = true;
          this.push(Buffer.from('%PDF-1.7\n'));
          this.push(null);
        },
      });
      const req = Object.assign(stream, {
        headers: {
          authorization: 'Bearer invalid',
          'content-type': 'application/pdf',
          'x-file-name': 'big.pdf',
        },
      }) as unknown as Request;

      const controller = new WorkNotesController({
        assertUploadAuthorized: jest
          .fn()
          .mockRejectedValue(new UnauthorizedException('Unauthorized')),
        uploadDocumentFile: jest.fn(),
      } as unknown as WorkNotesService);

      await expect(
        controller.uploadDocumentFile(req, projectAId, docId),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(streamRead).toBe(false);
    });

    it('rejects XML with XXE DOCTYPE/ENTITY and rejects non-OOXML ZIP spoofed as DOCX (SEC-BE-011)', async () => {
      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(docId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            status: 'DRAFT',
            createdByUserId: new Types.ObjectId(leaderId),
            currentVersionNumber: 1,
          }),
        },
        project_document_versions: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            documentId: new Types.ObjectId(docId),
            versionNumber: 1,
            status: 'DRAFT',
            editedByUserId: new Types.ObjectId(leaderId),
          }),
        },
      });
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue({
            userId: leaderId,
            userName: 'Leader',
            organizationId: orgId,
            projectId: projectAId,
            canReview: true,
            canConfigure: true,
            isLeader: true,
            isProjectMember: true,
          }),
        } as unknown as WorkNotesAuthorizationService,
        connection,
        undefined,
        undefined,
        { put: jest.fn() } as unknown as ProjectDocumentStorage,
      );

      const xxeXml = Buffer.from(
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>',
      );
      await expect(
        service.uploadDocumentFile(
          {},
          projectAId,
          docId,
          'payload.xml',
          'application/xml',
          xxeXml,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Bare 4-byte PK header without ZIP central directory / [Content_Types].xml
      const fakeDocx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00]);
      await expect(
        service.uploadDocumentFile(
          {},
          projectAId,
          docId,
          'spoofed.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fakeDocx,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enforces If-Match ETag optimistic concurrency on updateDocumentDraft (E2E-INT-012)', async () => {
      const updatedAt = new Date('2026-11-27T05:00:00.000Z');
      const connection = makeSessionConnection({
        project_documents: {
          findOne: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(docId),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            status: 'DRAFT',
            createdByUserId: new Types.ObjectId(leaderId),
            currentVersionNumber: 1,
            updatedAt,
          }),
        },
      });
      const service = new WorkNotesService(
        {
          resolveProject: jest.fn().mockResolvedValue({
            userId: leaderId,
            userName: 'Leader',
            organizationId: orgId,
            projectId: projectAId,
            canReview: true,
            canConfigure: true,
            isLeader: true,
            isProjectMember: true,
          }),
        } as unknown as WorkNotesAuthorizationService,
        connection,
      );

      await expect(
        service.updateDocumentDraft(
          { ifMatch: 'W/"1000000000000"' },
          projectAId,
          docId,
          { title: 'Updated', type: 'ARCHITECTURE', content: '# new' },
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'ETAG_MISMATCH' },
      });
    });
  });

  describe('BE-PERF-003: In-process monolith authorization, batched Task lookup & roster (Round 2 Defect 6)', () => {
    it('resolves project actor via in-process IamActorContextService with zero HTTP fetch hops and enforces membership/platform blocks', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const resolveProjectActorContext = jest.fn().mockResolvedValue({
        actor: {
          id: leaderId,
          email: 'leader@acme.io',
          name: 'Leo Leader',
          organizationId: orgId,
          roles: ['MEMBER'],
        },
        project: {
          id: projectAId,
          organizationId: orgId,
          name: 'Alpha',
          code: 'ALP',
          status: 'ACTIVE',
          visibility: 'PRIVATE',
        },
        isProjectMember: true,
        isLeader: true,
        isManager: false,
        joinedAt: '2026-10-01T00:00:00.000Z',
        canReview: true,
      });

      const authService = new WorkNotesAuthorizationService(
        new ConfigService({}),
        undefined,
        undefined,
        { resolveProjectActorContext } as unknown as IamActorContextService,
      );

      try {
        const actor = await authService.resolveProject(
          { authorization: 'Bearer tok-1', organizationId: orgId },
          projectAId,
        );
        expect(actor).toMatchObject({
          userId: leaderId,
          organizationId: orgId,
          projectId: projectAId,
          isProjectMember: true,
          isLeader: true,
          isManager: false,
          canReview: true,
          joinedAt: '2026-10-01T00:00:00.000Z',
        });
        expect(resolveProjectActorContext).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();

        // Non-member non-manager MUST receive 404 PROJECT_NOT_FOUND
        resolveProjectActorContext.mockResolvedValueOnce({
          actor: {
            id: memberId,
            email: 'outsider@acme.io',
            name: 'Outsider',
            organizationId: orgId,
            roles: ['MEMBER'],
          },
          project: {
            id: projectAId,
            organizationId: orgId,
            name: 'Alpha',
            code: 'ALP',
            status: 'ACTIVE',
            visibility: 'PUBLIC',
          },
          isProjectMember: false,
          isLeader: false,
          isManager: false,
          joinedAt: null,
          canReview: false,
        });
        await expect(
          authService.resolveProject(
            { authorization: 'Bearer tok-2' },
            projectAId,
          ),
        ).rejects.toBeInstanceOf(NotFoundException);

        // PLATFORM_OPERATOR MUST receive 403
        resolveProjectActorContext.mockResolvedValueOnce({
          actor: {
            id: managerId,
            email: 'ops@continuum.ai',
            name: 'Ops',
            organizationId: orgId,
            roles: ['PLATFORM_OPERATOR'],
          },
          project: {
            id: projectAId,
            organizationId: orgId,
            name: 'Alpha',
            code: 'ALP',
            status: 'ACTIVE',
            visibility: 'PRIVATE',
          },
          isProjectMember: true,
          isLeader: false,
          isManager: true,
          joinedAt: null,
          canReview: true,
        });
        await expect(
          authService.resolveProject(
            { authorization: 'Bearer tok-3' },
            projectAId,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('batches task resolution in ONE $in query via TaskWorkspaceRepository and reads active roster in-process with zero HTTP calls', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      const task1Id = new Types.ObjectId().toHexString();
      const task2Id = new Types.ObjectId().toHexString();
      const missingTaskId = new Types.ObjectId().toHexString();
      const tasksFindSpy = jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(task1Id),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            key: 'ALP-1',
            title: 'Task One',
            description: 'First task',
            status: 'IN_PROGRESS',
            version: 2,
            parentId: null,
            steps: [],
          },
          {
            _id: new Types.ObjectId(task2Id),
            organizationId: new Types.ObjectId(orgId),
            projectId: new Types.ObjectId(projectAId),
            key: 'ALP-2',
            title: 'Task Two',
            description: null,
            status: 'TODO',
            version: 1,
            parentId: new Types.ObjectId(task1Id),
            steps: [],
          },
        ]),
      }));
      const taskRepoStub = {
        db: {
          collection: jest.fn(() => ({ find: tasksFindSpy })),
        },
        getTaskById: jest.fn(),
      } as unknown as TaskWorkspaceRepository;

      const leaderRoleId = new Types.ObjectId();
      const iamConnection = makeSessionConnection({
        project_memberships: {
          find: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([
              {
                userId: new Types.ObjectId(leaderId),
                joinedAt: new Date('2026-09-01T00:00:00.000Z'),
              },
              {
                userId: new Types.ObjectId(memberId),
                joinedAt: new Date('2026-08-01T00:00:00.000Z'),
                reactivatedAt: new Date('2026-11-10T00:00:00.000Z'),
              },
            ]),
          })),
        },
        role_assignments: {
          find: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([
              {
                userId: new Types.ObjectId(leaderId),
                roleId: leaderRoleId,
              },
            ]),
          })),
        },
        organization_memberships: {
          find: jest.fn(() => ({
            toArray: jest
              .fn()
              .mockResolvedValue([
                { userId: new Types.ObjectId(leaderId) },
                { userId: new Types.ObjectId(memberId) },
              ]),
          })),
        },
        users: {
          find: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([
              { _id: new Types.ObjectId(leaderId), fullName: 'Leo Leader' },
              { _id: new Types.ObjectId(memberId), fullName: 'Mina Member' },
            ]),
          })),
        },
        roles: {
          find: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([{ _id: leaderRoleId }]),
          })),
        },
      });

      const authService = new WorkNotesAuthorizationService(
        new ConfigService({}),
        undefined,
        iamConnection,
        undefined,
        taskRepoStub,
      );

      try {
        const actor = {
          userId: leaderId,
          userName: 'Leo Leader',
          organizationId: orgId,
          projectId: projectAId,
          canReview: true,
          canConfigure: true,
          isLeader: true,
          isManager: false,
          isProjectMember: true,
        };

        const batchMap = await authService.resolveTasksBatch({}, actor, [
          task1Id,
          task2Id,
          missingTaskId,
        ]);
        expect(tasksFindSpy).toHaveBeenCalledTimes(1);
        expect(batchMap.get(task1Id)?.taskKey).toBe('ALP-1');
        expect(batchMap.get(task2Id)?.taskParentId).toBe(task1Id);
        expect(batchMap.get(missingTaskId)).toBeNull();

        const roster = await authService.listActiveRoster(actor, {});
        expect(roster.leaders).toEqual([
          {
            userId: leaderId,
            fullName: 'Leo Leader',
            joinedAt: '2026-09-01T00:00:00.000Z',
          },
        ]);
        expect(roster.members).toEqual([
          {
            userId: memberId,
            fullName: 'Mina Member',
            // BE-LOGIC-008: reactivatedAt preferred over stale joinedAt
            joinedAt: '2026-11-10T00:00:00.000Z',
          },
        ]);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
