import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type ClientSession, type Connection } from 'mongoose';
import { randomUUID } from 'node:crypto';
import type { Document, Db } from 'mongodb';
import { CAPTURE_PERSISTENCE } from '../infrastructure/persistence';
import { AuditService } from '../infrastructure/audit/audit.service';
import { OutboxService } from '../infrastructure/outbox/outbox.service';
import { ProjectDocumentStorage } from '../infrastructure/storage/project-document.storage';
import {
  assertReviewerCanReview,
  calculateReportPeriod,
  getFrequencyDays,
  nextFrequencyEffectiveAt,
  type WorkReportFrequency,
} from './work-notes.domain';
import { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import type { ReportingProjectMembers } from '../../iam/application/projects/project-report-roster.service';
import type {
  CaptureRequestHeaders,
  DocumentStatus,
  DocumentVersionRecord,
  ProjectDocumentInput,
  ProjectDocumentRecord,
  ProjectDocumentSummaryRecord,
  ReviewInput,
  TaskNoteInput,
  TaskNoteRecord,
  WorkNotesActor,
  WorkNotesPage,
  WorkNotesPermissions,
  WorkReportInput,
  WorkReportRecord,
  WorkReportSettingsRecord,
  WorkReportStatus,
} from './work-notes.types';

type MongoRecord = Record<string, unknown> & { _id: Types.ObjectId };

const documentNotFound = () =>
  new NotFoundException({
    code: 'DOCUMENT_NOT_FOUND',
    message: 'Project Document not found.',
  });
const reportNotFound = () =>
  new NotFoundException({
    code: 'WORK_REPORT_NOT_FOUND',
    message: 'Work Report not found.',
  });
const conflict = (message: string) =>
  new ConflictException({ code: 'WORKFLOW_CONFLICT', message });
const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);
const objectId = (value: string) => new Types.ObjectId(value.toLowerCase());
const startOfUtcWeek = (value: Date): Date => {
  const start = new Date(value);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
};
const record = (value: Document | null): MongoRecord | null =>
  value as unknown as MongoRecord | null;
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const idText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value instanceof Types.ObjectId
      ? value.toHexString()
      : '';
const iso = (value: unknown): string | undefined =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : undefined;
const pickReviewHistory = (value: unknown) =>
  Array.isArray(value)
    ? value.map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          action: item.action as 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
          reviewerId: text(item.reviewerId),
          ...(typeof item.comment === 'string'
            ? { comment: item.comment }
            : {}),
          at: iso(item.at) ?? new Date(0).toISOString(),
        };
      })
    : [];

@Injectable()
export class WorkNotesService {
  constructor(
    private readonly authorization: WorkNotesAuthorizationService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional() private readonly outbox?: OutboxService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly documentStorage?: ProjectDocumentStorage,
  ) {}

  async listTaskNotes(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    page: number,
    pageSize: number,
  ): Promise<WorkNotesPage<TaskNoteRecord>> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const db = this.database();
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      taskId: objectId(taskId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
    };
    const collection = db.collection('work_notes');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) => this.taskNoteRecord(row, actor)),
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async listProjectTaskNotes(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    taskId?: string,
  ): Promise<WorkNotesPage<TaskNoteRecord>> {
    const actor = taskId
      ? await this.authorization.resolveTask(headers, projectId, taskId)
      : await this.authorization.resolveProject(headers, projectId);
    const db = this.database();
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      taskId: { $type: 'objectId' },
      ...(taskId ? { taskId: objectId(taskId) } : {}),
    };
    const collection = db.collection('work_notes');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) => this.taskNoteRecord(row, actor)),
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async getTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const row = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        taskId: objectId(taskId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    if (!row) throw this.taskNoteNotFound();
    return this.taskNoteRecord(row, actor);
  }

  async getProjectTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const row = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    const taskId = row ? idText(row.taskId) : '';
    if (!row || !validId(taskId)) throw this.taskNoteNotFound();
    await this.authorization.resolveTask(headers, projectId, taskId);
    return this.taskNoteRecord(row, actor);
  }

  async createTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    input: TaskNoteInput,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const id = new Types.ObjectId();
    const now = new Date();
    await this.transaction(async (db, session) => {
      await db.collection('work_notes').insertOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          authorUserId: objectId(actor.userId),
          authorName: actor.userName,
          title: input.title,
          whatDone: input.accomplishments,
          howSolved: input.approach,
          whyThisWay: input.reason,
          status: 'CONFIRMED',
          authorConfirmedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
    });
    await this.auditEvent(actor, 'TASK_NOTE_CREATED', 'WORK_NOTE', String(id));
    return {
      id: String(id),
      projectId,
      taskId,
      authorId: actor.userId,
      authorName: actor.userName,
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      ...input,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      permissions: this.taskNotePermissions(actor, actor.userId),
    };
  }

  async updateTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
    input: TaskNoteInput,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const row = await this.database()
      .collection('work_notes')
      .findOneAndUpdate(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        {
          $set: {
            title: input.title,
            whatDone: input.accomplishments,
            howSolved: input.approach,
            whyThisWay: input.reason,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' },
      );
    if (!row) throw this.taskNoteNotFound();
    await this.auditEvent(actor, 'TASK_NOTE_UPDATED', 'WORK_NOTE', noteId);
    return this.taskNoteRecord(row, actor);
  }

  async deleteTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
  ): Promise<void> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const result = await this.database()
      .collection('work_notes')
      .updateOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        { $set: { status: 'ARCHIVED', updatedAt: new Date() } },
      );
    if (result.modifiedCount !== 1) throw this.taskNoteNotFound();
    await this.auditEvent(actor, 'TASK_NOTE_ARCHIVED', 'WORK_NOTE', noteId);
  }

  async listDocuments(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: DocumentStatus,
  ): Promise<WorkNotesPage<ProjectDocumentSummaryRecord>> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      ...(status ? { status } : {}),
    };
    const collection = this.database().collection('project_documents');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) => this.documentSummary(row, actor)),
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async createDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: ProjectDocumentInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = input.taskId
      ? await this.authorization.resolveTask(headers, projectId, input.taskId)
      : await this.authorization.resolveProject(headers, projectId);
    const id = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const now = new Date();
    await this.transaction(async (db, session) => {
      await db.collection('project_documents').insertOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...(input.taskId ? { taskId: objectId(input.taskId) } : {}),
          title: input.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          documentType: input.type,
          createdByUserId: objectId(actor.userId),
          updatedByUserId: objectId(actor.userId),
          currentVersionNumber: 1,
          status: 'DRAFT',
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await db.collection('project_document_versions').insertOne(
        {
          _id: versionId,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          documentId: id,
          versionNumber: 1,
          title: input.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          documentType: input.type,
          ...(input.taskId ? { taskId: objectId(input.taskId) } : {}),
          content: input.content,
          status: 'DRAFT',
          editedByUserId: objectId(actor.userId),
          reviewHistory: [],
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
    });
    await this.auditEvent(
      actor,
      'DOCUMENT_DRAFT_CREATED',
      'PROJECT_DOCUMENT',
      String(id),
    );
    const created = await this.readDocument(actor, id);
    if (!created) throw documentNotFound();
    return created;
  }

  async getDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const result = await this.readDocument(actor, objectId(documentId));
    if (!result) throw documentNotFound();
    return result;
  }

  async uploadDocumentFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    name: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const cleanName = name.trim();
    const supported =
      contentType === 'application/pdf' ||
      contentType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const signatureValid =
      contentType === 'application/pdf'
        ? bytes.subarray(0, 5).toString('ascii') === '%PDF-'
        : bytes.subarray(0, 2).toString('ascii') === 'PK';
    if (
      !supported ||
      !signatureValid ||
      bytes.length === 0 ||
      bytes.length > 20 * 1024 * 1024 ||
      cleanName.length > 180 ||
      /[\\/]/.test(cleanName) ||
      [...cleanName].some((character) => character.charCodeAt(0) < 32) ||
      !cleanName
        .toLowerCase()
        .endsWith(contentType === 'application/pdf' ? '.pdf' : '.docx')
    )
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message: 'A PDF or DOCX file up to 20 MB is required.',
      });
    const id = objectId(documentId);
    const documents = this.database().collection('project_documents');
    const document = await documents.findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      createdByUserId: objectId(actor.userId),
    });
    if (!document) throw documentNotFound();
    const versionNumber = Number(document.currentVersionNumber);
    const versions = this.database().collection('project_document_versions');
    const previousVersion = await versions.findOne({
      documentId: id,
      versionNumber,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      editedByUserId: objectId(actor.userId),
    });
    if (!previousVersion) throw documentNotFound();
    const key = `work-notes/${actor.organizationId}/${projectId}/${documentId}/${randomUUID()}`;
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    await this.documentStorage.put(key, bytes, contentType);
    try {
      const result = await versions.updateOne(
        {
          documentId: id,
          versionNumber,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: 'DRAFT',
          editedByUserId: objectId(actor.userId),
          updatedAt: previousVersion.updatedAt,
        },
        {
          $set: {
            file: { key, name: cleanName, contentType, size: bytes.length },
            updatedAt: new Date(),
          },
        },
      );
      if (result.modifiedCount !== 1)
        throw conflict('The Document changed during upload.');
    } catch (error) {
      await this.documentStorage.delete(key).catch(() => undefined);
      throw error;
    }
    const oldKey = (previousVersion.file as { key?: string } | undefined)?.key;
    if (
      oldKey &&
      oldKey !== key &&
      (await versions.countDocuments({
        'file.key': oldKey,
        _id: { $ne: previousVersion._id },
      })) === 0
    )
      await this.documentStorage.delete(oldKey).catch(() => undefined);
    await this.auditEvent(
      actor,
      'DOCUMENT_FILE_UPLOADED',
      'PROJECT_DOCUMENT',
      documentId,
      { version: versionNumber },
    );
    const updated = await this.readDocument(actor, id);
    if (!updated) throw documentNotFound();
    return updated;
  }

  async downloadDocumentFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    versionNumber?: number,
  ): Promise<{ bytes: Buffer; name: string; contentType: string }> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const document = await this.database()
      .collection('project_documents')
      .findOne({
        _id: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      });
    if (!document) throw documentNotFound();
    const version = await this.database()
      .collection('project_document_versions')
      .findOne({
        documentId: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        versionNumber: versionNumber ?? Number(document.currentVersionNumber),
      });
    const file = version?.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (!file?.key || !file.name || !file.contentType) throw documentNotFound();
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    return {
      bytes: await this.documentStorage.get(file.key),
      name: file.name,
      contentType: file.contentType,
    };
  }

  async updateDocumentDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: ProjectDocumentInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = input.taskId
      ? await this.authorization.resolveTask(headers, projectId, input.taskId)
      : await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const versions = db.collection('project_document_versions');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      if (String(current.createdByUserId) !== actor.userId) {
        throw new ForbiddenException({
          code: 'DOCUMENT_OWNER_REQUIRED',
          message: 'Only the Document owner can edit it.',
        });
      }
      const status = text(current.status) as DocumentStatus;
      if (status === 'PENDING_REVIEW' || status === 'ARCHIVED')
        throw conflict(
          'This Document version cannot be edited in its current state.',
        );

      const currentVersionNumber = Number(current.currentVersionNumber);
      const nextVersionNumber =
        status === 'APPROVED' || status === 'REJECTED'
          ? currentVersionNumber + 1
          : currentVersionNumber;
      const versionFilter = {
        documentId: id,
        versionNumber: currentVersionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      };
      if (nextVersionNumber === currentVersionNumber) {
        const updated = await versions.updateOne(
          {
            ...versionFilter,
            status: { $in: ['DRAFT', 'CHANGES_REQUESTED'] },
            editedByUserId: objectId(actor.userId),
          },
          {
            $set: {
              title: input.title,
              ...(input.description !== undefined
                ? { description: input.description }
                : {}),
              documentType: input.type,
              ...(input.taskId
                ? { taskId: objectId(input.taskId) }
                : { taskId: null }),
              content: input.content,
              status: 'DRAFT',
              editedByUserId: objectId(actor.userId),
              updatedAt: now,
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw conflict(
            'The Document version changed while it was being edited.',
          );
      } else {
        const previous = await versions.findOne(versionFilter, { session });
        if (!previous) throw documentNotFound();
        await versions.insertOne(
          {
            _id: new Types.ObjectId(),
            ...versionFilter,
            versionNumber: nextVersionNumber,
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            documentType: input.type,
            ...(input.taskId ? { taskId: objectId(input.taskId) } : {}),
            content: input.content,
            ...(previous.file ? { file: previous.file } : {}),
            status: 'DRAFT',
            editedByUserId: objectId(actor.userId),
            reviewHistory: [],
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      }
      const update = await documents.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          currentVersionNumber,
          status,
        },
        {
          $set: {
            ...(input.taskId
              ? { taskId: objectId(input.taskId) }
              : { taskId: null }),
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            documentType: input.type,
            updatedByUserId: objectId(actor.userId),
            currentVersionNumber: nextVersionNumber,
            status: 'DRAFT',
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document changed while it was being edited.');
    });
    await this.auditEvent(
      actor,
      'DOCUMENT_DRAFT_UPDATED',
      'PROJECT_DOCUMENT',
      documentId,
    );
    const updated = await this.readDocument(actor, id);
    if (!updated) throw documentNotFound();
    return updated;
  }

  async submitDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      if (String(current.createdByUserId) !== actor.userId) {
        throw new ForbiddenException({
          code: 'DOCUMENT_OWNER_REQUIRED',
          message: 'Only the Document owner can submit it.',
        });
      }
      const versionNumber = Number(current.currentVersionNumber);
      const submittedVersion = await db
        .collection('project_document_versions')
        .findOne(
          {
            documentId: id,
            versionNumber,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        );
      if (
        !submittedVersion ||
        (!text(submittedVersion.content).trim() && !submittedVersion.file)
      )
        throw conflict(
          'A Document needs text or an uploaded file before submission.',
        );
      const versionResult = await db
        .collection('project_document_versions')
        .updateOne(
          {
            documentId: id,
            versionNumber,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            editedByUserId: objectId(actor.userId),
            status: 'DRAFT',
          },
          {
            $set: {
              status: 'PENDING_REVIEW',
              submittedAt: now,
              updatedAt: now,
            },
          },
          { session },
        );
      if (versionResult.modifiedCount !== 1)
        throw conflict('Only an owned draft Document can be submitted.');
      const docResult = await documents.updateOne(
        {
          _id: id,
          currentVersionNumber: versionNumber,
          status: 'DRAFT',
        },
        { $set: { status: 'PENDING_REVIEW', updatedAt: now } },
        { session },
      );
      if (docResult.modifiedCount !== 1)
        throw conflict('The Document changed before submission.');
      await this.appendOutbox(
        {
          eventName: 'DOCUMENT_SUBMITTED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            version: versionNumber,
          },
        },
        session,
      );
    });
    await this.auditEvent(
      actor,
      'DOCUMENT_SUBMITTED',
      'PROJECT_DOCUMENT',
      documentId,
    );
    const submitted = await this.readDocument(actor, id);
    if (!submitted) throw documentNotFound();
    return submitted;
  }

  async reviewDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
    input: ReviewInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    let sourceVersion = 0;
    let authorId = '';
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      authorId = String(current.createdByUserId);
      assertReviewerCanReview(authorId, actor.userId, actor.canReview);
      sourceVersion = Number(current.currentVersionNumber);
      const version = record(
        await db.collection('project_document_versions').findOne(
          {
            documentId: id,
            versionNumber: sourceVersion,
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!version)
        throw conflict('The submitted Document version is unavailable.');
      const history = pickReviewHistory(version.reviewHistory);
      const update = await db.collection('project_document_versions').updateOne(
        { _id: version._id, status: 'PENDING_REVIEW' },
        {
          $set: {
            status: action,
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            ...(input.comment ? { reviewComment: input.comment } : {}),
            reviewHistory: [
              ...history,
              {
                action,
                reviewerId: actor.userId,
                ...(input.comment ? { comment: input.comment } : {}),
                at: now,
              },
            ],
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document was reviewed by another user.');
      const documentUpdate = await documents.updateOne(
        {
          _id: id,
          status: 'PENDING_REVIEW',
          currentVersionNumber: sourceVersion,
        },
        { $set: { status: action, updatedAt: now } },
        { session },
      );
      if (documentUpdate.modifiedCount !== 1)
        throw conflict('The Document changed while it was being reviewed.');

      const eventName =
        action === 'APPROVED'
          ? 'DOCUMENT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'DOCUMENT_CHANGES_REQUESTED'
            : 'DOCUMENT_REJECTED';
      await this.appendOutbox(
        {
          eventName,
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            authorId,
            version: sourceVersion,
            ...(input.comment ? { comment: input.comment } : {}),
          },
        },
        session,
      );
      if (action === 'APPROVED') {
        const previousApproved = await db
          .collection('project_document_versions')
          .find(
            {
              documentId: id,
              versionNumber: { $lt: sourceVersion },
              status: 'APPROVED',
            },
            { session },
          )
          .sort({ versionNumber: -1 })
          .limit(1)
          .next();
        if (previousApproved) {
          await this.appendOutbox(
            {
              eventName: 'KNOWLEDGE_SOURCE_REPLACED',
              aggregateType: 'PROJECT_DOCUMENT',
              aggregateId: documentId,
              payload: {
                sourceType: 'PROJECT_DOCUMENT',
                sourceId: documentId,
                organizationId: actor.organizationId,
                projectId,
                previousVersion: Number(previousApproved.versionNumber),
                version: sourceVersion,
              },
            },
            session,
          );
        }
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_APPROVED',
            aggregateType: 'PROJECT_DOCUMENT',
            aggregateId: documentId,
            payload: {
              sourceType: 'PROJECT_DOCUMENT',
              sourceId: documentId,
              organizationId: actor.organizationId,
              projectId,
              version: sourceVersion,
              approvedAt: now.toISOString(),
            },
          },
          session,
        );
      }
    });
    const auditAction =
      action === 'APPROVED'
        ? 'DOCUMENT_APPROVED'
        : action === 'CHANGES_REQUESTED'
          ? 'DOCUMENT_CHANGES_REQUESTED'
          : 'DOCUMENT_REJECTED';
    await this.auditEvent(actor, auditAction, 'PROJECT_DOCUMENT', documentId, {
      authorId,
      version: sourceVersion,
    });
    const reviewed = await this.readDocument(actor, id);
    if (!reviewed) throw documentNotFound();
    return reviewed;
  }

  async archiveDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    await this.transaction(async (db, session) => {
      const result = await db.collection('project_documents').findOneAndUpdate(
        {
          _id: objectId(documentId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: 'APPROVED',
        },
        {
          $set: {
            status: 'ARCHIVED',
            updatedByUserId: objectId(actor.userId),
            updatedAt: new Date(),
          },
        },
        { session, returnDocument: 'before' },
      );
      if (!result) throw conflict('Only an approved Document can be archived.');
      await this.appendOutbox(
        {
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId,
            organizationId: actor.organizationId,
            projectId,
            version: Number(result.currentVersionNumber),
            reason: 'ARCHIVED',
          },
        },
        session,
      );
    });
    await this.auditEvent(
      actor,
      'DOCUMENT_ARCHIVED',
      'PROJECT_DOCUMENT',
      documentId,
    );
    const archived = await this.readDocument(actor, objectId(documentId));
    if (!archived) throw documentNotFound();
    return archived;
  }

  async getWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const settings = await this.settingsTimeline(actor);
    return this.settingsRecord(settings, actor, new Date());
  }

  async updateWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
    frequency: WorkReportFrequency,
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canConfigure) throw this.reviewPermissionDenied();
    const settings = await this.settingsTimeline(actor);
    const now = new Date();
    const active = this.activeSetting(settings, now);
    const pending = settings.find(
      (item) => new Date(String(item.effectiveAt)).getTime() > now.getTime(),
    );
    if (pending) {
      throw conflict('A Work Report frequency change is already scheduled.');
    }
    if (text(active.frequency) === frequency) {
      return this.settingsRecord(settings, actor, now);
    }

    const effectiveAt = nextFrequencyEffectiveAt(
      new Date(String(active.effectiveAt)),
      text(active.frequency) as WorkReportFrequency,
      now,
    );
    const setting = {
      _id: new Types.ObjectId(),
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      frequency,
      effectiveAt,
      createdByUserId: objectId(actor.userId),
      createdAt: now,
      updatedAt: now,
    };
    await this.transaction(async (db, session) => {
      await db
        .collection('work_report_settings')
        .insertOne(setting, { session });
      await this.appendOutbox(
        {
          eventName: 'WORK_REPORT_FREQUENCY_CHANGED',
          aggregateType: 'WORK_REPORT_SETTINGS',
          aggregateId: projectId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            previousFrequency: text(active.frequency),
            frequency,
            effectiveAt: effectiveAt.toISOString(),
          },
        },
        session,
      );
    });
    await this.auditEvent(
      actor,
      'REPORT_FREQUENCY_CHANGED',
      'PROJECT',
      projectId,
      {
        previousFrequency: text(active.frequency),
        frequency,
        effectiveAt: effectiveAt.toISOString(),
      },
    );
    const updated = await this.settingsTimeline(actor);
    return this.settingsRecord(updated, actor, now);
  }

  async listWorkReports(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: WorkReportStatus,
  ): Promise<WorkNotesPage<WorkReportRecord>> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const members = actor.canReview
      ? await this.authorization.listActiveMembers(actor, headers)
      : [
          {
            userId: actor.userId,
            fullName: actor.userName,
            joinedAt: new Date().toISOString(),
          },
        ];
    const timeline = await this.settingsTimeline(actor);
    await this.ensureReportObligations(actor, members, timeline, new Date());
    await this.markOverdue(actor, projectId, new Date());
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      ...(!actor.canReview ? { memberUserId: objectId(actor.userId) } : {}),
      ...(status ? { status } : {}),
    };
    const collection = this.database().collection('work_reports');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ periodStart: -1, memberUserId: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      data: rows.map((row) => {
        const memberId = String(row.memberUserId);
        const memberName = members.find(
          (member) => member.userId === memberId,
        )?.fullName;
        return this.workReportRecord(row, actor, memberName);
      }),
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async saveCurrentWorkReportDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: WorkReportInput,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const timeline = await this.settingsTimeline(actor);
    const now = new Date();
    await this.ensureReportObligations(
      actor,
      [{ userId: actor.userId, joinedAt: now.toISOString() }],
      timeline,
      now,
    );
    await this.markOverdue(actor, projectId, now);
    const currentSetting = this.activeSetting(timeline, now);
    const period = calculateReportPeriod(
      new Date(String(currentSetting.effectiveAt)),
      text(currentSetting.frequency) as WorkReportFrequency,
      now,
    );
    const row = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          memberUserId: objectId(actor.userId),
          periodStart: period.periodStart,
        }),
    );
    if (!row) throw reportNotFound();
    return this.saveReportDraft(actor, row._id, input);
  }

  async getWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const row = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          _id: objectId(reportId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...(!actor.canReview ? { memberUserId: objectId(actor.userId) } : {}),
        }),
    );
    if (!row) throw reportNotFound();
    const memberId = String(row.memberUserId);
    const memberName =
      memberId === actor.userId
        ? actor.userName
        : actor.canReview
          ? (await this.authorization.listActiveMembers(actor, headers)).find(
              (member) => member.userId === memberId,
            )?.fullName
          : undefined;
    return this.workReportRecord(row, actor, memberName);
  }

  async updateWorkReportDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    input: WorkReportInput,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    return this.saveReportDraft(actor, objectId(reportId), input);
  }

  async submitWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const id = objectId(reportId);
    const now = new Date();
    let memberId = '';
    await this.transaction(async (db, session) => {
      const reports = db.collection('work_reports');
      const current = record(
        await reports.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            memberUserId: objectId(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
          },
          { session },
        ),
      );
      if (!current) throw reportNotFound();
      if (
        !text(current.accomplishments).trim() ||
        !text(current.approach).trim() ||
        !text(current.reason).trim()
      )
        throw conflict(
          'Complete the three required report fields before submitting.',
        );
      memberId = String(current.memberUserId);
      const updated = await reports.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          memberUserId: objectId(actor.userId),
          status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
        },
        {
          $set: { status: 'PENDING_REVIEW', submittedAt: now, updatedAt: now },
        },
        { session },
      );
      if (updated.modifiedCount !== 1)
        throw conflict('The Work Report changed before it was submitted.');
      await this.appendOutbox(
        {
          eventName: 'WORK_REPORT_SUBMITTED',
          aggregateType: 'WORK_REPORT',
          aggregateId: reportId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            memberId,
          },
        },
        session,
      );
    });
    await this.auditEvent(actor, 'REPORT_SUBMITTED', 'WORK_REPORT', reportId, {
      memberId,
    });
    return this.getWorkReport(headers, projectId, reportId);
  }

  async reviewWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
    input: ReviewInput,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(reportId)) throw reportNotFound();
    const id = objectId(reportId);
    const now = new Date();
    let memberId = '';
    await this.transaction(async (db, session) => {
      const reports = db.collection('work_reports');
      const current = record(
        await reports.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!current) throw reportNotFound();
      memberId = String(current.memberUserId);
      assertReviewerCanReview(memberId, actor.userId, actor.canReview);
      const history = pickReviewHistory(current.reviewHistory);
      const updated = await reports.updateOne(
        { _id: id, status: 'PENDING_REVIEW' },
        {
          $set: {
            status: action,
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            ...(input.comment ? { reviewComment: input.comment } : {}),
            reviewHistory: [
              ...history,
              {
                action,
                reviewerId: actor.userId,
                ...(input.comment ? { comment: input.comment } : {}),
                at: now,
              },
            ],
            updatedAt: now,
          },
        },
        { session },
      );
      if (updated.modifiedCount !== 1)
        throw conflict('The Work Report was reviewed by another user.');
      const eventName =
        action === 'APPROVED'
          ? 'WORK_REPORT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'WORK_REPORT_CHANGES_REQUESTED'
            : 'WORK_REPORT_REJECTED';
      await this.appendOutbox(
        {
          eventName,
          aggregateType: 'WORK_REPORT',
          aggregateId: reportId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            memberId,
            ...(input.comment ? { comment: input.comment } : {}),
          },
        },
        session,
      );
      if (action === 'APPROVED') {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_APPROVED',
            aggregateType: 'WORK_REPORT',
            aggregateId: reportId,
            payload: {
              sourceType: 'PERIODIC_REPORT',
              sourceId: reportId,
              organizationId: actor.organizationId,
              projectId,
              version: 1,
              approvedAt: now.toISOString(),
            },
          },
          session,
        );
      }
    });
    const auditAction =
      action === 'APPROVED'
        ? 'REPORT_APPROVED'
        : action === 'CHANGES_REQUESTED'
          ? 'REPORT_CHANGES_REQUESTED'
          : 'REPORT_REJECTED';
    await this.auditEvent(actor, auditAction, 'WORK_REPORT', reportId, {
      memberId,
    });
    return this.getWorkReport(headers, projectId, reportId);
  }

  async sweepOverdueReports(): Promise<number> {
    const db = this.database();
    const now = new Date();
    const rows = await db
      .collection('work_reports')
      .find({ status: 'DRAFT', dueAt: { $lte: now } })
      .sort({ dueAt: 1, _id: 1 })
      .limit(500)
      .toArray();
    let transitioned = 0;
    for (const candidate of rows) {
      const item = candidate as unknown as Record<string, unknown>;
      const id = objectId(String(item._id));
      const didTransition = await this.transaction(
        async (transactionDb, session) => {
          const update = await transactionDb
            .collection('work_reports')
            .updateOne(
              { _id: id, status: 'DRAFT', dueAt: { $lte: now } },
              { $set: { status: 'OVERDUE', updatedAt: now } },
              { session },
            );
          if (update.modifiedCount !== 1) return false;
          const projectId = String(item.projectId);
          const memberId = String(item.memberUserId);
          const commonPayload = {
            organizationId: String(item.organizationId),
            projectId,
            memberId,
            periodStart: iso(item.periodStart),
            periodEnd: iso(item.periodEnd),
            dueAt: iso(item.dueAt),
          };
          await this.appendOutbox(
            {
              eventName: 'WORK_REPORT_DUE',
              aggregateType: 'WORK_REPORT',
              aggregateId: String(id),
              payload: commonPayload,
            },
            session,
          );
          await this.appendOutbox(
            {
              eventName: 'WORK_REPORT_OVERDUE',
              aggregateType: 'WORK_REPORT',
              aggregateId: String(id),
              payload: commonPayload,
            },
            session,
          );
          return true;
        },
      );
      if (didTransition) transitioned += 1;
    }
    return transitioned;
  }

  async ensureScheduledReportObligations(
    project: ReportingProjectMembers,
  ): Promise<void> {
    const actor: WorkNotesActor = {
      userId: project.projectCreatedBy,
      userName: '',
      organizationId: project.organizationId,
      projectId: project.projectId,
      canReview: true,
      canConfigure: true,
    };
    const timeline = await this.settingsTimeline(actor);
    await this.ensureReportObligations(
      actor,
      project.members,
      timeline,
      new Date(),
    );
  }

  private async saveReportDraft(
    actor: WorkNotesActor,
    reportId: Types.ObjectId,
    input: WorkReportInput,
  ): Promise<WorkReportRecord> {
    const now = new Date();
    const reports = this.database().collection('work_reports');
    const update = await reports.updateOne(
      {
        _id: reportId,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
        memberUserId: objectId(actor.userId),
        status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
      },
      {
        $set: {
          accomplishments: input.accomplishments,
          approach: input.approach,
          reason: input.reason,
          blockers: input.blockers ?? '',
          nextSteps: input.nextSteps ?? '',
          updatedAt: now,
        },
      },
    );
    if (update.matchedCount !== 1) {
      const exists = await reports.findOne({
        _id: reportId,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
      });
      if (!exists) throw reportNotFound();
      throw conflict('Only your unsubmitted Work Report can be edited.');
    }
    await this.auditEvent(
      actor,
      'REPORT_DRAFT_SAVED',
      'WORK_REPORT',
      String(reportId),
    );
    const row = await reports.findOne({ _id: reportId });
    if (!row) throw reportNotFound();
    return this.workReportRecord(row, actor);
  }

  private async settingsTimeline(
    actor: WorkNotesActor,
  ): Promise<MongoRecord[]> {
    const collection = this.database().collection('work_report_settings');
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(actor.projectId),
    };
    let rows = await collection
      .find(filter)
      .sort({ effectiveAt: 1, _id: 1 })
      .toArray();
    if (rows.length === 0) {
      const now = new Date();
      const setting = {
        _id: new Types.ObjectId(),
        ...filter,
        frequency: 'WEEKLY',
        effectiveAt: startOfUtcWeek(now),
        createdByUserId: objectId(actor.userId),
        createdAt: now,
        updatedAt: now,
      };
      try {
        await collection.insertOne(setting);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 11000
        )
          throw error;
      }
      rows = await collection
        .find(filter)
        .sort({ effectiveAt: 1, _id: 1 })
        .toArray();
    }
    return rows;
  }

  private activeSetting(settings: MongoRecord[], now: Date): MongoRecord {
    const active = settings
      .filter(
        (item) => new Date(String(item.effectiveAt)).getTime() <= now.getTime(),
      )
      .at(-1);
    if (active) return active;
    if (settings[0]) return settings[0];
    throw new ServiceUnavailableException({
      code: 'WORK_REPORT_SETTINGS_UNAVAILABLE',
      message: 'Work Report settings are unavailable.',
    });
  }

  private settingsRecord(
    settings: MongoRecord[],
    actor: WorkNotesActor,
    now: Date,
  ): WorkReportSettingsRecord {
    const active = this.activeSetting(settings, now);
    const next = settings.find(
      (item) => new Date(String(item.effectiveAt)).getTime() > now.getTime(),
    );
    return {
      projectId: actor.projectId,
      frequency: text(active.frequency) as WorkReportFrequency,
      effectiveAt: iso(active.effectiveAt) ?? '',
      ...(next ? { nextEffectiveAt: iso(next.effectiveAt) } : {}),
      updatedBy: String(active.createdByUserId),
      history: settings.map((item) => ({
        frequency: text(item.frequency) as WorkReportFrequency,
        effectiveAt: iso(item.effectiveAt) ?? '',
        updatedBy: String(item.createdByUserId),
      })),
      permissions: { canConfigure: actor.canConfigure },
    };
  }

  private async ensureReportObligations(
    actor: WorkNotesActor,
    members: Array<{ userId: string; joinedAt: string }>,
    settings: MongoRecord[],
    now: Date,
  ): Promise<void> {
    const reports = this.database().collection('work_reports');
    const operations: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: { $setOnInsert: Record<string, unknown> };
        upsert: true;
      };
    }> = [];
    const maxPeriodsPerMember = 20_000;
    const periodStartByUser = new Map<string, number>();

    for (let index = 0; index < settings.length; index += 1) {
      const setting = settings[index];
      const segmentStart = new Date(String(setting.effectiveAt));
      const nextSetting = settings[index + 1];
      const segmentEnd = nextSetting
        ? new Date(String(nextSetting.effectiveAt))
        : undefined;
      if (segmentStart.getTime() > now.getTime()) continue;

      const frequency = text(setting.frequency) as WorkReportFrequency;
      const periodLengthMs = getFrequencyDays(frequency) * 24 * 60 * 60 * 1000;
      let periodStart = segmentStart;
      while (
        periodStart.getTime() <= now.getTime() &&
        (!segmentEnd || periodStart.getTime() < segmentEnd.getTime())
      ) {
        const calculated = calculateReportPeriod(
          segmentStart,
          frequency,
          periodStart,
        );
        const start = calculated.periodStart;
        let end = calculated.periodEnd;
        if (segmentEnd && end.getTime() > segmentEnd.getTime())
          end = segmentEnd;
        if (end.getTime() <= start.getTime()) break;
        for (const member of members) {
          const memberId = member.userId;
          if (!validId(memberId)) continue;
          const joinedAt = new Date(member.joinedAt);
          if (
            !Number.isFinite(joinedAt.getTime()) ||
            joinedAt.getTime() >= end.getTime()
          )
            continue;
          const count = (periodStartByUser.get(memberId) ?? 0) + 1;
          if (count > maxPeriodsPerMember) {
            throw new ServiceUnavailableException({
              code: 'WORK_REPORT_HISTORY_TOO_LARGE',
              message: 'Work Report periods need administrative catch-up.',
            });
          }
          periodStartByUser.set(memberId, count);
          const projectObjectId = objectId(actor.projectId);
          const memberObjectId = objectId(memberId);
          const id = new Types.ObjectId();
          operations.push({
            updateOne: {
              filter: {
                projectId: projectObjectId,
                memberUserId: memberObjectId,
                periodStart: start,
              },
              update: {
                $setOnInsert: {
                  _id: id,
                  organizationId: objectId(actor.organizationId),
                  projectId: projectObjectId,
                  memberUserId: memberObjectId,
                  frequency,
                  periodStart: start,
                  periodEnd: end,
                  dueAt: end,
                  accomplishments: '',
                  approach: '',
                  reason: '',
                  blockers: '',
                  nextSteps: '',
                  status: 'DRAFT',
                  reviewHistory: [],
                  createdAt: now,
                  updatedAt: now,
                },
              },
              upsert: true,
            },
          });
        }
        periodStart = new Date(periodStart.getTime() + periodLengthMs);
      }
    }

    for (let offset = 0; offset < operations.length; offset += 500) {
      const batch = operations.slice(offset, offset + 500);
      try {
        await reports.bulkWrite(batch, { ordered: false });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 11000
        )
          throw error;
      }
    }
  }

  private workReportRecord(
    row: Document,
    actor: WorkNotesActor,
    resolvedMemberName?: string,
  ): WorkReportRecord {
    const value = row as unknown as Record<string, unknown>;
    const memberId = String(value.memberUserId);
    const status = text(value.status) as WorkReportStatus;
    const isOwner = memberId === actor.userId;
    return {
      id: String(value._id),
      projectId: String(value.projectId),
      memberId,
      memberName: isOwner ? actor.userName : resolvedMemberName || memberId,
      frequency: text(value.frequency) as WorkReportFrequency,
      periodStart: iso(value.periodStart) ?? '',
      periodEnd: iso(value.periodEnd) ?? '',
      dueAt: iso(value.dueAt) ?? '',
      status,
      accomplishments: text(value.accomplishments),
      approach: text(value.approach),
      reason: text(value.reason),
      blockers: text(value.blockers),
      nextSteps: text(value.nextSteps),
      createdAt: iso(value.createdAt) ?? '',
      updatedAt: iso(value.updatedAt) ?? '',
      ...(iso(value.submittedAt)
        ? { submittedAt: iso(value.submittedAt) }
        : {}),
      ...(value.reviewedByUserId
        ? { reviewedBy: idText(value.reviewedByUserId) }
        : {}),
      ...(iso(value.reviewedAt) ? { reviewedAt: iso(value.reviewedAt) } : {}),
      ...(typeof value.reviewComment === 'string'
        ? { reviewComment: value.reviewComment }
        : {}),
      reviewHistory: pickReviewHistory(value.reviewHistory),
      permissions: {
        canCreate: true,
        canEdit:
          isOwner && ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canSubmit:
          isOwner && ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canReview: actor.canReview && !isOwner && status === 'PENDING_REVIEW',
        canConfigure: actor.canConfigure,
      },
    };
  }

  private async markOverdue(
    actor: WorkNotesActor,
    projectId: string,
    now: Date,
  ): Promise<void> {
    const candidates = await this.database()
      .collection('work_reports')
      .find({
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        status: 'DRAFT',
        dueAt: { $lte: now },
      })
      .limit(500)
      .toArray();
    for (const candidate of candidates) {
      const item = candidate as unknown as Record<string, unknown>;
      const id = objectId(String(item._id));
      await this.transaction(async (db, session) => {
        const update = await db
          .collection('work_reports')
          .updateOne(
            { _id: id, status: 'DRAFT', dueAt: { $lte: now } },
            { $set: { status: 'OVERDUE', updatedAt: now } },
            { session },
          );
        if (update.modifiedCount !== 1) return;
        const commonPayload = {
          organizationId: actor.organizationId,
          projectId,
          memberId: String(item.memberUserId),
          periodStart: iso(item.periodStart),
          periodEnd: iso(item.periodEnd),
          dueAt: iso(item.dueAt),
        };
        await this.appendOutbox(
          {
            eventName: 'WORK_REPORT_DUE',
            aggregateType: 'WORK_REPORT',
            aggregateId: String(id),
            payload: commonPayload,
          },
          session,
        );
        await this.appendOutbox(
          {
            eventName: 'WORK_REPORT_OVERDUE',
            aggregateType: 'WORK_REPORT',
            aggregateId: String(id),
            payload: commonPayload,
          },
          session,
        );
      });
    }
  }

  private taskNoteRecord(row: Document, actor: WorkNotesActor): TaskNoteRecord {
    const value = row as unknown as Record<string, unknown>;
    const authorId = String(value.authorUserId);
    return {
      id: String(value._id),
      projectId: String(value.projectId),
      taskId: String(value.taskId),
      authorId,
      authorName:
        text(value.authorName) ||
        (authorId === actor.userId ? actor.userName : authorId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      title: text(value.title),
      accomplishments: text(value.whatDone),
      approach: text(value.howSolved),
      reason: text(value.whyThisWay),
      createdAt: iso(value.createdAt) ?? '',
      updatedAt: iso(value.updatedAt) ?? '',
      permissions: this.taskNotePermissions(actor, authorId),
    };
  }

  private documentSummary(
    row: Document,
    actor: WorkNotesActor,
  ): ProjectDocumentSummaryRecord {
    const value = row as unknown as Record<string, unknown>;
    const createdBy = String(value.createdByUserId);
    const status = text(value.status) as DocumentStatus;
    return {
      id: String(value._id),
      projectId: String(value.projectId),
      ...(value.taskId ? { taskId: idText(value.taskId) } : {}),
      title: text(value.title),
      ...(typeof value.description === 'string'
        ? { description: value.description }
        : {}),
      type: text(value.documentType) as ProjectDocumentRecord['type'],
      version: Number(value.currentVersionNumber),
      status,
      createdBy,
      createdAt: iso(value.createdAt) ?? '',
      updatedAt: iso(value.updatedAt) ?? '',
      permissions: {
        ...this.permissions(actor, createdBy, status),
        canEdit:
          createdBy === actor.userId &&
          ['DRAFT', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED'].includes(
            status,
          ),
        canSubmit: createdBy === actor.userId && status === 'DRAFT',
      },
    };
  }

  private async readDocument(
    actor: WorkNotesActor,
    id: Types.ObjectId,
  ): Promise<ProjectDocumentRecord | null> {
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
      }),
    );
    if (!document) return null;
    const versions = await db
      .collection('project_document_versions')
      .find({
        documentId: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
      })
      .sort({ versionNumber: 1 })
      .toArray();
    const versionRecords = versions.map((item) =>
      this.documentVersion(item as Document),
    );
    const current = versionRecords.find(
      (item) => item.version === Number(document.currentVersionNumber),
    );
    if (!current) throw documentNotFound();
    const summary = this.documentSummary(document, actor);
    return {
      ...summary,
      submittedAt: current.submittedAt,
      reviewedBy: current.reviewedBy,
      reviewedAt: current.reviewedAt,
      reviewComment: current.reviewComment,
      content: current.content,
      ...(current.file ? { file: current.file } : {}),
      versions: versionRecords.map(
        ({ version, status, createdAt, editedBy, file }) => ({
          version,
          status,
          createdAt,
          editedBy,
          ...(file ? { file } : {}),
        }),
      ),
      reviewHistory: versionRecords
        .flatMap((item) => item.reviewHistory)
        .sort((left, right) => left.at.localeCompare(right.at)),
    };
  }

  private documentVersion(row: Document): DocumentVersionRecord {
    const value = row as unknown as Record<string, unknown>;
    return {
      version: Number(value.versionNumber),
      title: text(value.title),
      ...(typeof value.description === 'string'
        ? { description: value.description }
        : {}),
      type: text(value.documentType) as ProjectDocumentRecord['type'],
      ...(value.taskId ? { taskId: idText(value.taskId) } : {}),
      content: text(value.content),
      ...(value.file && typeof value.file === 'object'
        ? {
            file: {
              name: text((value.file as Record<string, unknown>).name),
              contentType: text(
                (value.file as Record<string, unknown>).contentType,
              ),
              size: Number((value.file as Record<string, unknown>).size),
            },
          }
        : {}),
      status: text(value.status) as DocumentStatus,
      editedBy: String(value.editedByUserId),
      createdAt: iso(value.createdAt) ?? '',
      ...(iso(value.submittedAt)
        ? { submittedAt: iso(value.submittedAt) }
        : {}),
      ...(value.reviewedByUserId
        ? { reviewedBy: idText(value.reviewedByUserId) }
        : {}),
      ...(iso(value.reviewedAt) ? { reviewedAt: iso(value.reviewedAt) } : {}),
      ...(typeof value.reviewComment === 'string'
        ? { reviewComment: value.reviewComment }
        : {}),
      reviewHistory: pickReviewHistory(value.reviewHistory),
    };
  }

  private permissions(
    actor: WorkNotesActor,
    authorId: string,
    status: string,
  ): WorkNotesPermissions {
    return {
      canCreate: true,
      canEdit: authorId === actor.userId && status === 'DRAFT',
      canSubmit: authorId === actor.userId && status === 'DRAFT',
      canReview:
        actor.canReview &&
        authorId !== actor.userId &&
        status === 'PENDING_REVIEW',
      canConfigure: actor.canConfigure,
    };
  }

  private taskNotePermissions(
    actor: WorkNotesActor,
    authorId: string,
  ): WorkNotesPermissions {
    const canManage = actor.userId === authorId || actor.canReview;
    return {
      canCreate: true,
      canEdit: canManage,
      canDelete: canManage,
      canSubmit: false,
      canReview: false,
      canConfigure: false,
    };
  }

  private pagination(page: number, pageSize: number, totalItems: number) {
    return {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    };
  }

  private taskNoteNotFound() {
    return new NotFoundException({
      code: 'TASK_NOTE_NOT_FOUND',
      message: 'Task Note not found.',
    });
  }

  private reviewPermissionDenied() {
    return new ForbiddenException({
      code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
      message: 'Project review permission is required.',
    });
  }

  private database(): Db {
    if (!this.connection?.db) {
      throw new ServiceUnavailableException({
        code: 'CAPTURE_PERSISTENCE_UNAVAILABLE',
        message: 'Work Notes persistence is unavailable.',
      });
    }
    return this.connection.db;
  }

  private async transaction<T>(
    operation: (db: Db, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const db = this.database();
    const session = await this.connection!.startSession();
    try {
      const result = await session.withTransaction(() =>
        operation(db, session),
      );
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async appendOutbox(
    event: {
      eventName: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
    session: ClientSession,
  ): Promise<void> {
    if (!this.outbox) {
      throw new ServiceUnavailableException({
        code: 'CAPTURE_OUTBOX_UNAVAILABLE',
        message: 'Work Notes event delivery is unavailable.',
      });
    }
    await this.outbox.append(event, session);
  }

  private async auditEvent(
    actor: WorkNotesActor,
    action: string,
    targetResource: string,
    targetResourceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit?.append({
      organizationId: actor.organizationId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      action,
      targetResource,
      targetResourceId,
      ...(metadata ? { metadata } : {}),
    });
  }
}
