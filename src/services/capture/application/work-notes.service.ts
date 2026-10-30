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
import { NotificationService } from '../../notification/notification.service';
import {
  assertReviewerCanReview,
  calculateReportPeriod,
  getFrequencyDays,
  type WorkReportFrequency,
} from './work-notes.domain';
import { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import {
  ProjectReportRosterService,
  type ReportingProjectMembers,
} from '../../iam/application/projects/project-report-roster.service';
import type {
  CaptureRequestHeaders,
  DocumentStatus,
  DocumentVersionRecord,
  ProjectDocumentInput,
  ProjectDocumentRecord,
  ProjectDocumentSummaryRecord,
  ProjectTaskNotesQueryOptions,
  ReviewInput,
  TaskNoteInput,
  TaskNoteRecord,
  WorkNotesActor,
  WorkNotesPage,
  WorkNotesPermissions,
  WorkReportInput,
  WorkReportRecord,
  WorkReportRosterEntry,
  WorkReportScope,
  WorkReportSettingsRecord,
  WorkReportsListFilters,
  WorkReportsPageRecord,
  WorkReportStatus,
  WorkReportSummaryCounts,
  WorkReportTierSettingsSummary,
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
const pickReviewHistory = (
  value: unknown,
): DocumentVersionRecord['reviewHistory'] =>
  Array.isArray(value)
    ? value.map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          action: item.action as
            | 'PENDING_REVIEW'
            | 'APPROVED'
            | 'CHANGES_REQUESTED'
            | 'REJECTED',
          reviewerId: text(item.reviewerId),
          ...(item.reviewerRole === 'MANAGER' || item.reviewerRole === 'LEADER'
            ? { reviewerRole: item.reviewerRole }
            : {}),
          ...(typeof item.comment === 'string'
            ? { comment: item.comment }
            : {}),
          at: iso(item.at) ?? new Date(0).toISOString(),
        };
      })
    : [];

const isActorManager = (actor: WorkNotesActor): boolean =>
  Boolean(actor.isManager);
const isActorLeader = (actor: WorkNotesActor): boolean =>
  Boolean(actor.isLeader) || (actor.canReview && !actor.isManager);
const isActorPureMember = (actor: WorkNotesActor): boolean =>
  !isActorManager(actor) && !isActorLeader(actor);
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const OLE2_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function isTextBuffer(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return !sample.includes(0);
}

const isZipBuffer = (bytes: Buffer) =>
  bytes.subarray(0, 2).toString('ascii') === 'PK';
const isOle2Buffer = (bytes: Buffer) =>
  bytes.length >= 8 && bytes.subarray(0, 8).equals(OLE2_SIGNATURE);
const isRtfBuffer = (bytes: Buffer) =>
  bytes.subarray(0, 5).toString('ascii') === '{\\rtf';

type DocumentFileFormatRule = Readonly<{
  extensions: readonly string[];
  canonicalContentType: string;
  acceptedContentTypes: readonly string[];
  validateBytes: (bytes: Buffer) => boolean;
}>;

const DOCUMENT_FILE_FORMAT_RULES: readonly DocumentFileFormatRule[] = [
  {
    extensions: ['.pdf'],
    canonicalContentType: 'application/pdf',
    acceptedContentTypes: ['application/pdf'],
    validateBytes: (bytes) =>
      bytes.subarray(0, 5).toString('ascii') === '%PDF-',
  },
  {
    extensions: ['.docx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.doc'],
    canonicalContentType: 'application/msword',
    acceptedContentTypes: ['application/msword', 'application/vnd.ms-word'],
    validateBytes: (bytes) => isOle2Buffer(bytes) || isRtfBuffer(bytes),
  },
  {
    extensions: ['.xlsx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.xls'],
    canonicalContentType: 'application/vnd.ms-excel',
    acceptedContentTypes: ['application/vnd.ms-excel'],
    validateBytes: isOle2Buffer,
  },
  {
    extensions: ['.pptx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.ppt'],
    canonicalContentType: 'application/vnd.ms-powerpoint',
    acceptedContentTypes: ['application/vnd.ms-powerpoint'],
    validateBytes: isOle2Buffer,
  },
  {
    extensions: ['.odt'],
    canonicalContentType: 'application/vnd.oasis.opendocument.text',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.text',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.ods'],
    canonicalContentType: 'application/vnd.oasis.opendocument.spreadsheet',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.odp'],
    canonicalContentType: 'application/vnd.oasis.opendocument.presentation',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.presentation',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isZipBuffer,
  },
  {
    extensions: ['.rtf'],
    canonicalContentType: 'application/rtf',
    acceptedContentTypes: ['application/rtf', 'text/rtf', 'text/plain'],
    validateBytes: isRtfBuffer,
  },
  {
    extensions: ['.txt'],
    canonicalContentType: 'text/plain',
    acceptedContentTypes: ['text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.md', '.markdown'],
    canonicalContentType: 'text/markdown',
    acceptedContentTypes: ['text/markdown', 'text/x-markdown', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.csv'],
    canonicalContentType: 'text/csv',
    acceptedContentTypes: [
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'text/plain',
    ],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.tsv'],
    canonicalContentType: 'text/tab-separated-values',
    acceptedContentTypes: ['text/tab-separated-values', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.json'],
    canonicalContentType: 'application/json',
    acceptedContentTypes: ['application/json', 'text/json', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.yaml', '.yml'],
    canonicalContentType: 'application/yaml',
    acceptedContentTypes: [
      'application/yaml',
      'application/x-yaml',
      'text/yaml',
      'text/x-yaml',
      'text/plain',
    ],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.xml', '.drawio'],
    canonicalContentType: 'application/xml',
    acceptedContentTypes: ['application/xml', 'text/xml', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.sql'],
    canonicalContentType: 'application/sql',
    acceptedContentTypes: ['application/sql', 'text/x-sql', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.png'],
    canonicalContentType: 'image/png',
    acceptedContentTypes: ['image/png'],
    validateBytes: (bytes) =>
      bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  },
  {
    extensions: ['.jpg', '.jpeg'],
    canonicalContentType: 'image/jpeg',
    acceptedContentTypes: ['image/jpeg', 'image/pjpeg'],
    validateBytes: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  {
    extensions: ['.webp'],
    canonicalContentType: 'image/webp',
    acceptedContentTypes: ['image/webp'],
    validateBytes: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function resolveValidatedDocumentContentType(
  cleanName: string,
  rawContentType: string,
  bytes: Buffer,
): string | null {
  const lowerName = cleanName.toLowerCase();
  const rule = DOCUMENT_FILE_FORMAT_RULES.find((candidate) =>
    candidate.extensions.some((ext) => lowerName.endsWith(ext)),
  );
  if (!rule) return null;
  const baseContentType =
    rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentTypeAllowed =
    baseContentType === '' ||
    baseContentType === 'application/octet-stream' ||
    rule.acceptedContentTypes.includes(baseContentType);
  if (!contentTypeAllowed || !rule.validateBytes(bytes)) return null;
  return rule.canonicalContentType;
}

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
    @Optional() private readonly notifications?: NotificationService,
    @Optional() private readonly reportRoster?: ProjectReportRosterService,
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
    taskIdOrOptions?: string | ProjectTaskNotesQueryOptions,
  ): Promise<WorkNotesPage<TaskNoteRecord>> {
    const options: ProjectTaskNotesQueryOptions =
      typeof taskIdOrOptions === 'string'
        ? { taskId: taskIdOrOptions }
        : (taskIdOrOptions ?? {});
    const { taskId, authorId, search, sort = 'recent' } = options;
    const actor = taskId
      ? await this.authorization.resolveTask(headers, projectId, taskId)
      : await this.authorization.resolveProject(headers, projectId);
    const db = this.database();
    const trimmedSearch = search?.trim() ?? '';
    const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex =
      escapedSearch.length > 0 ? new RegExp(escapedSearch, 'i') : undefined;
    const filter: Record<string, unknown> = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      taskId: taskId ? objectId(taskId) : { $type: 'objectId' },
      ...(authorId && validId(authorId)
        ? { authorUserId: objectId(authorId) }
        : {}),
      ...(searchRegex
        ? {
            $or: [
              { title: searchRegex },
              { authorName: searchRegex },
              { whatDone: searchRegex },
              { howSolved: searchRegex },
              { whyThisWay: searchRegex },
            ],
          }
        : {}),
    };
    const sortSpec: Record<string, 1 | -1> =
      sort === 'oldest' ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    const collection = db.collection('work_notes');
    if (taskId) {
      const [rows, totalItems] = await Promise.all([
        collection
          .find(filter)
          .sort(sortSpec)
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

    const allRows = await collection.find(filter).sort(sortSpec).toArray();
    const distinctTaskIds = [
      ...new Set(
        allRows
          .map((row) => idText((row as Record<string, unknown>).taskId))
          .filter((id) => validId(id)),
      ),
    ];
    const resolvedTaskActors = new Map<string, WorkNotesActor | null>();
    await Promise.all(
      distinctTaskIds.map(async (candidateTaskId) => {
        try {
          const resolved = await this.authorization.resolveTask(
            headers,
            projectId,
            candidateTaskId,
          );
          resolvedTaskActors.set(candidateTaskId, resolved);
        } catch (err) {
          if (
            err instanceof NotFoundException ||
            err instanceof ForbiddenException
          ) {
            resolvedTaskActors.set(candidateTaskId, null);
            return;
          }
          throw err;
        }
      }),
    );

    const authorizedRows = allRows.filter((row) => {
      const rowTaskId = idText((row as Record<string, unknown>).taskId);
      return Boolean(resolvedTaskActors.get(rowTaskId));
    });
    const totalItems = authorizedRows.length;
    const pagedRows = authorizedRows.slice(
      (page - 1) * pageSize,
      page * pageSize,
    );
    return {
      data: pagedRows.map((row) => {
        const rowTaskId = idText((row as Record<string, unknown>).taskId);
        const taskActor = resolvedTaskActors.get(rowTaskId) ?? actor;
        return this.taskNoteRecord(row, taskActor);
      }),
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
    const taskActor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    return this.taskNoteRecord(row, taskActor);
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
      await this.auditEvent(
        actor,
        'TASK_NOTE_CREATED',
        'WORK_NOTE',
        String(id),
        undefined,
        session,
      );
    });
    return {
      id: String(id),
      projectId,
      taskId,
      ...(actor.taskKey ? { taskKey: actor.taskKey } : {}),
      ...(actor.taskTitle ? { taskTitle: actor.taskTitle } : {}),
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
    let updatedRow: Document | null = null;
    await this.transaction(async (db, session) => {
      updatedRow = await db.collection('work_notes').findOneAndUpdate(
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
        { returnDocument: 'after', session },
      );
      if (!updatedRow) throw this.taskNoteNotFound();
      await this.auditEvent(
        actor,
        'TASK_NOTE_UPDATED',
        'WORK_NOTE',
        noteId,
        undefined,
        session,
      );
    });
    if (!updatedRow) throw this.taskNoteNotFound();
    return this.taskNoteRecord(updatedRow, actor);
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
    await this.transaction(async (db, session) => {
      const result = await db.collection('work_notes').updateOne(
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
        { session },
      );
      if (result.modifiedCount !== 1) throw this.taskNoteNotFound();
      await this.auditEvent(
        actor,
        'TASK_NOTE_ARCHIVED',
        'WORK_NOTE',
        noteId,
        undefined,
        session,
      );
    });
  }

  async listDocuments(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: DocumentStatus,
  ): Promise<WorkNotesPage<ProjectDocumentSummaryRecord>> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const statusFilter =
      status === undefined
        ? {}
        : status === 'APPROVED'
          ? {
              status: { $ne: 'ARCHIVED' },
              $or: [
                { status: 'APPROVED' },
                { latestApprovedVersionNumber: { $type: 'number' } },
              ],
            }
          : { status };
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      ...statusFilter,
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
    const actor = await this.authorization.resolveProject(headers, projectId);
    const id = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const now = new Date();
    await this.transaction(async (db, session) => {
      await db.collection('project_documents').insertOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
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
          content: input.content,
          status: 'DRAFT',
          editedByUserId: objectId(actor.userId),
          reviewHistory: [],
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_DRAFT_CREATED',
        'PROJECT_DOCUMENT',
        String(id),
        undefined,
        session,
      );
    });
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
    const resolvedContentType =
      bytes.length > 0 &&
      bytes.length <= 20 * 1024 * 1024 &&
      cleanName.length > 0 &&
      cleanName.length <= 180 &&
      !/[\\/]/.test(cleanName) &&
      ![...cleanName].some((character) => character.charCodeAt(0) < 32)
        ? resolveValidatedDocumentContentType(cleanName, contentType, bytes)
        : null;
    if (!resolvedContentType)
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message:
          'A supported document file (PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, MD, CSV, TSV, JSON, YAML, XML, SQL, DRAWIO, PNG, JPG, WEBP) up to 20 MB is required.',
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
    await this.documentStorage.put(key, bytes, resolvedContentType);
    try {
      await this.transaction(async (db, session) => {
        const result = await db
          .collection('project_document_versions')
          .updateOne(
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
                file: {
                  key,
                  name: cleanName,
                  contentType: resolvedContentType,
                  size: bytes.length,
                },
                updatedAt: new Date(),
              },
            },
            { session },
          );
        if (result.modifiedCount !== 1)
          throw conflict('The Document changed during upload.');
        await this.auditEvent(
          actor,
          'DOCUMENT_FILE_UPLOADED',
          'PROJECT_DOCUMENT',
          documentId,
          { version: versionNumber },
          session,
        );
      });
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
    const actor = await this.authorization.resolveProject(headers, projectId);
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
      await this.auditEvent(
        actor,
        'DOCUMENT_DRAFT_UPDATED',
        'PROJECT_DOCUMENT',
        documentId,
        undefined,
        session,
      );
    });
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
      await this.auditEvent(
        actor,
        'DOCUMENT_SUBMITTED',
        'PROJECT_DOCUMENT',
        documentId,
        undefined,
        session,
      );
    });
    const submitted = await this.readDocument(actor, id);
    if (!submitted) throw documentNotFound();
    return submitted;
  }

  async commentDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: ReviewInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    const comment = input.comment?.trim() ?? '';
    if (!comment) {
      throw new BadRequestException({
        code: 'REVIEW_COMMENT_REQUIRED',
        message: 'A review comment is required.',
      });
    }
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
      const authorId = String(current.createdByUserId);
      assertReviewerCanReview(authorId, actor.userId, actor.canReview);
      const sourceVersion = Number(current.currentVersionNumber);
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
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            reviewComment: comment,
            reviewHistory: [
              ...history,
              {
                action: 'PENDING_REVIEW',
                reviewerId: actor.userId,
                comment,
                at: now,
              },
            ],
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document changed while saving the review comment.');
      await documents.updateOne(
        {
          _id: id,
          status: 'PENDING_REVIEW',
          currentVersionNumber: sourceVersion,
        },
        { $set: { updatedAt: now } },
        { session },
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_REVIEW_COMMENTED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: sourceVersion },
        session,
      );
    });
    const commented = await this.readDocument(actor, id);
    if (!commented) throw documentNotFound();
    return commented;
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
        {
          $set: {
            status: action,
            ...(action === 'APPROVED'
              ? { latestApprovedVersionNumber: sourceVersion }
              : {}),
            updatedAt: now,
          },
        },
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
      const auditAction =
        action === 'APPROVED'
          ? 'DOCUMENT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'DOCUMENT_CHANGES_REQUESTED'
            : 'DOCUMENT_REJECTED';
      await this.auditEvent(
        actor,
        auditAction,
        'PROJECT_DOCUMENT',
        documentId,
        {
          authorId,
          version: sourceVersion,
        },
        session,
      );
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
      if (text(current.status) === 'ARCHIVED') {
        throw conflict('Only an approved Document can be archived.');
      }
      const latestApprovedVersion = await versions
        .find(
          {
            documentId: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'APPROVED',
          },
          { session },
        )
        .sort({ versionNumber: -1 })
        .limit(1)
        .next();
      if (
        text(current.status) !== 'APPROVED' &&
        typeof current.latestApprovedVersionNumber !== 'number' &&
        !latestApprovedVersion
      ) {
        throw conflict('Only an approved Document can be archived.');
      }
      const revokedVersion = Number(
        latestApprovedVersion?.versionNumber ??
          current.latestApprovedVersionNumber ??
          current.currentVersionNumber,
      );
      const update = await documents.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: text(current.status),
        },
        {
          $set: {
            status: 'ARCHIVED',
            updatedByUserId: objectId(actor.userId),
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('Only an approved Document can be archived.');
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
            version: revokedVersion,
            reason: 'ARCHIVED',
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_ARCHIVED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: revokedVersion },
        session,
      );
    });
    const archived = await this.readDocument(actor, id);
    if (!archived) throw documentNotFound();
    return archived;
  }

  async getWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (scope === 'LEADER' && isActorPureMember(actor)) {
      throw this.reviewPermissionDenied();
    }
    const [timelines, hasActiveLeaders] = await Promise.all([
      this.scopedSettingsTimelines(actor),
      this.resolveHasActiveLeaders(actor, headers),
    ]);
    return this.settingsRecord(
      timelines,
      actor,
      new Date(),
      scope,
      hasActiveLeaders,
    );
  }

  async updateWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
    frequency: WorkReportFrequency,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const hasActiveLeaders = await this.resolveHasActiveLeaders(actor, headers);
    if (scope === 'LEADER') {
      if (!this.canManageLeaderTier(actor)) {
        throw this.reviewPermissionDenied();
      }
    } else if (!this.canManageMemberTier(actor, hasActiveLeaders)) {
      throw this.reviewPermissionDenied();
    }

    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    const scopeRows =
      scope === 'LEADER' ? timelines.leaderRows : timelines.memberRows;
    const active = this.activeSetting(scopeRows, now);
    const previousFrequency = (text(active.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const activeEffectiveAt =
      active.effectiveAt instanceof Date
        ? active.effectiveAt
        : new Date(String(active.effectiveAt));
    const existingHistory = this.extractSettingRowHistory(
      active,
      activeEffectiveAt,
      actor.userId,
    );

    const scopeReportFilter =
      scope === 'LEADER'
        ? { reportScope: 'LEADER' }
        : {
            $or: [
              { reportScope: 'MEMBER' },
              { reportScope: { $exists: false } },
            ],
          };
    const untouchedEmptyDraftCondition = {
      status: 'DRAFT',
      $and: [
        {
          $or: [
            { accomplishments: '' },
            { accomplishments: { $exists: false } },
          ],
        },
        { $or: [{ approach: '' }, { approach: { $exists: false } }] },
        { $or: [{ reason: '' }, { reason: { $exists: false } }] },
        { $or: [{ blockers: '' }, { blockers: { $exists: false } }] },
        { $or: [{ nextSteps: '' }, { nextSteps: { $exists: false } }] },
        { $or: [{ file: null }, { file: { $exists: false } }] },
        {
          $or: [
            { documentIds: { $size: 0 } },
            { documentIds: { $exists: false } },
          ],
        },
      ],
    };
    const authoredOrSubmittedCondition = {
      $or: [
        { status: { $ne: 'DRAFT' } },
        { accomplishments: { $nin: ['', null] } },
        { approach: { $nin: ['', null] } },
        { reason: { $nin: ['', null] } },
        { blockers: { $nin: ['', null] } },
        { nextSteps: { $nin: ['', null] } },
        { 'file.key': { $exists: true } },
        { 'documentIds.0': { $exists: true } },
      ],
    };

    const existingAuthoredReport = await this.database()
      .collection('work_reports')
      .findOne({
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        ...scopeReportFilter,
        periodStart: { $gte: activeEffectiveAt },
        ...authoredOrSubmittedCondition,
      });
    const shouldSplitSegment =
      Boolean(existingAuthoredReport) &&
      activeEffectiveAt.getTime() < now.getTime();
    const changeEffectiveAt = shouldSplitSegment ? now : activeEffectiveAt;

    await this.transaction(async (db, session) => {
      const settingsCollection = db.collection('work_report_settings');
      const reportsCollection = db.collection('work_reports');

      await settingsCollection.deleteMany(
        {
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...(scope === 'LEADER'
            ? { reportScope: 'LEADER' }
            : {
                $or: [
                  { reportScope: 'MEMBER' },
                  { reportScope: { $exists: false } },
                ],
              }),
          _id: { $ne: active._id },
          effectiveAt: { $gt: now },
        },
        { session },
      );

      // Remove untouched auto-generated empty draft shells in the open window
      // so the next obligation pass cleanly materializes the updated cadence period.
      await reportsCollection.deleteMany(
        {
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...scopeReportFilter,
          periodEnd: { $gt: now },
          ...untouchedEmptyDraftCondition,
        },
        { session },
      );

      if (shouldSplitSegment) {
        // Close open authored draft period windows at the cadence boundary WITHOUT
        // truncating dueAt to now (preventing false instant OVERDUE transitions).
        await reportsCollection.updateMany(
          {
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            ...scopeReportFilter,
            status: 'DRAFT',
            periodEnd: { $gt: now },
          },
          {
            $set: {
              periodEnd: now,
              updatedAt: now,
            },
          },
          { session },
        );

        if (scope === 'LEADER' && !timelines.hasExplicitLeaderRows) {
          await settingsCollection.insertOne(
            {
              _id: new Types.ObjectId(),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              reportScope: 'LEADER',
              frequency: previousFrequency,
              effectiveAt: activeEffectiveAt,
              createdByUserId:
                active.createdByUserId instanceof Types.ObjectId
                  ? active.createdByUserId
                  : objectId(idText(active.createdByUserId) || actor.userId),
              updatedByUserId:
                active.updatedByUserId instanceof Types.ObjectId
                  ? active.updatedByUserId
                  : objectId(
                      idText(
                        active.updatedByUserId ?? active.createdByUserId,
                      ) || actor.userId,
                    ),
              history: existingHistory.map((entry) => ({
                frequency: entry.frequency,
                effectiveAt: new Date(entry.effectiveAt),
                updatedByUserId: validId(entry.updatedBy)
                  ? objectId(entry.updatedBy)
                  : objectId(actor.userId),
              })),
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
        }

        await settingsCollection.insertOne(
          {
            _id: new Types.ObjectId(),
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            reportScope: scope,
            frequency,
            effectiveAt: now,
            createdByUserId: objectId(actor.userId),
            updatedByUserId: objectId(actor.userId),
            history: [
              {
                frequency,
                effectiveAt: now,
                updatedByUserId: objectId(actor.userId),
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      } else {
        const appendedHistory = [
          ...existingHistory.map((entry) => ({
            frequency: entry.frequency,
            effectiveAt: new Date(entry.effectiveAt),
            updatedByUserId: validId(entry.updatedBy)
              ? objectId(entry.updatedBy)
              : objectId(actor.userId),
          })),
          {
            frequency,
            effectiveAt: now,
            updatedByUserId: objectId(actor.userId),
          },
        ];

        if (scope === 'LEADER' && !timelines.hasExplicitLeaderRows) {
          await settingsCollection.insertOne(
            {
              _id: new Types.ObjectId(),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              reportScope: 'LEADER',
              frequency,
              effectiveAt: activeEffectiveAt,
              createdByUserId: objectId(actor.userId),
              updatedByUserId: objectId(actor.userId),
              history: appendedHistory,
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
        } else {
          await settingsCollection.updateOne(
            { _id: active._id },
            {
              $set: {
                reportScope: scope,
                frequency,
                createdByUserId: objectId(actor.userId),
                updatedByUserId: objectId(actor.userId),
                history: appendedHistory,
                updatedAt: now,
              },
            },
            { session },
          );
        }
      }

      await this.appendOutbox(
        {
          eventName: 'WORK_REPORT_FREQUENCY_CHANGED',
          aggregateType: 'WORK_REPORT_SETTINGS',
          aggregateId: projectId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            scope,
            previousFrequency,
            frequency,
            effectiveAt: changeEffectiveAt.toISOString(),
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'REPORT_FREQUENCY_CHANGED',
        'PROJECT',
        projectId,
        {
          scope,
          previousFrequency,
          frequency,
          effectiveAt: changeEffectiveAt.toISOString(),
        },
        session,
      );
    });

    if (this.notifications) {
      try {
        const recipients =
          scope === 'LEADER'
            ? typeof this.authorization.listActiveLeaders === 'function'
              ? (
                  await this.authorization.listActiveLeaders(actor, headers)
                ).map((leader) => leader.userId)
              : await this.resolveProjectLeaderRecipientIds(
                  actor.organizationId,
                  projectId,
                )
            : (await this.authorization.listActiveMembers(actor, headers)).map(
                (member) => member.userId,
              );
        const days = getFrequencyDays(frequency);
        if (recipients.length > 0) {
          await this.notifications.emitSafe({
            type: 'WORK_REPORT_FREQUENCY_CHANGED',
            actorId: actor.userId,
            recipients,
            title:
              scope === 'LEADER'
                ? 'Leader reporting cadence updated'
                : 'Work report schedule updated',
            message:
              scope === 'LEADER'
                ? `Manager updated Leader work report schedule to every ${days} ${days === 1 ? 'day' : 'days'}.`
                : `Project reporting cadence is now every ${days} ${days === 1 ? 'day' : 'days'}.`,
            organizationId: actor.organizationId,
            projectId,
            target: {
              kind: 'PROJECT',
              url: `/projects/${projectId}/work-reports`,
              organizationId: actor.organizationId,
              projectId,
            },
            eventKey: `${scope.toLowerCase()}-report-cadence:${projectId}:${frequency}:${now.getTime()}`,
          });
        }
      } catch {
        // Do not fail setting mutation if notification emit fails
      }
    }

    const updated = await this.scopedSettingsTimelines(actor);
    return this.settingsRecord(updated, actor, now, scope, hasActiveLeaders);
  }

  async listWorkReports(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: WorkReportStatus,
    scope: WorkReportScope = 'MEMBER',
    filters?: WorkReportsListFilters,
  ): Promise<WorkReportsPageRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    const collection = this.database().collection('work_reports');

    if (scope === 'LEADER') {
      if (isActorPureMember(actor)) throw this.reviewPermissionDenied();
      const leaders =
        typeof this.authorization.listActiveLeaders === 'function'
          ? await this.authorization.listActiveLeaders(actor, headers)
          : [];
      if (isActorLeader(actor)) {
        const normalizedActorId = actor.userId.toLowerCase();
        if (
          !leaders.some((l) => l.userId.toLowerCase() === normalizedActorId)
        ) {
          leaders.push({
            userId: normalizedActorId,
            fullName: actor.userName || actor.userId,
            joinedAt:
              actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
                ? actor.joinedAt
                : startOfUtcWeek(now).toISOString(),
          });
        }
      }
      const hasActiveLeaders = leaders.length > 0 || isActorLeader(actor);
      const activeLeaderIds = new Set(
        leaders.map((leader) => leader.userId.toLowerCase()),
      );
      await this.ensureReportObligations(
        actor,
        leaders,
        timelines.leaderRows,
        now,
        'LEADER',
      );
      await this.markOverdue(actor, projectId, now, activeLeaderIds, 'LEADER');

      const canViewAllLeaders = isActorManager(actor);
      const visibleRosterPeople = canViewAllLeaders
        ? leaders
        : leaders.filter(
            (leader) =>
              leader.userId.toLowerCase() === actor.userId.toLowerCase(),
          );
      const baseVisibilityFilter: Record<string, unknown> = {
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        reportScope: 'LEADER',
        ...(!canViewAllLeaders ? { memberUserId: objectId(actor.userId) } : {}),
      };
      return this.queryWorkReportsPage({
        collection,
        actor,
        scope: 'LEADER',
        scopeRows: timelines.leaderRows,
        rosterPeople: visibleRosterPeople,
        allDirectoryPeople: leaders,
        canViewAllInScope: canViewAllLeaders,
        hasActiveLeaders,
        baseVisibilityFilter,
        page,
        pageSize,
        status,
        filters,
        now,
      });
    }

    const canViewAllMembers = isActorLeader(actor) || isActorManager(actor);
    const [members, hasActiveLeaders] = await Promise.all([
      canViewAllMembers
        ? this.authorization.listActiveMembers(actor, headers)
        : Promise.resolve([this.resolveActorMemberObligation(actor)]),
      this.resolveHasActiveLeaders(actor, headers),
    ]);
    const activeMemberIds = new Set(
      members.map((member) => member.userId.toLowerCase()),
    );
    await this.ensureReportObligations(
      actor,
      members,
      timelines.memberRows,
      now,
      'MEMBER',
    );
    await this.markOverdue(actor, projectId, now, activeMemberIds, 'MEMBER');

    const baseVisibilityFilter: Record<string, unknown> = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      $or: [{ reportScope: 'MEMBER' }, { reportScope: { $exists: false } }],
      ...(!canViewAllMembers ? { memberUserId: objectId(actor.userId) } : {}),
    };
    return this.queryWorkReportsPage({
      collection,
      actor,
      scope: 'MEMBER',
      scopeRows: timelines.memberRows,
      rosterPeople: members,
      allDirectoryPeople: members,
      canViewAllInScope: canViewAllMembers,
      hasActiveLeaders,
      baseVisibilityFilter,
      page,
      pageSize,
      status,
      filters,
      now,
    });
  }

  async saveCurrentWorkReportDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: WorkReportInput,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (scope === 'LEADER') {
      if (!isActorLeader(actor)) {
        throw new ForbiddenException({
          code: 'WORK_REPORT_LEADER_ONLY',
          message: 'Only Project Leaders can save a Leader Work Report draft.',
        });
      }
      const now = new Date();
      let resolvedJoinedAt =
        actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
          ? actor.joinedAt
          : undefined;
      if (typeof this.authorization.listActiveLeaders === 'function') {
        try {
          const activeLeaders = await this.authorization.listActiveLeaders(
            actor,
            headers,
          );
          const matched = activeLeaders.find(
            (leader) =>
              leader.userId.toLowerCase() === actor.userId.toLowerCase(),
          );
          if (
            matched?.joinedAt &&
            Number.isFinite(Date.parse(matched.joinedAt))
          ) {
            resolvedJoinedAt = matched.joinedAt;
          }
        } catch {
          // Fallback safely to actor.joinedAt if directory lookup is unavailable
        }
      }
      const leaderObligation = {
        userId: actor.userId,
        fullName: actor.userName,
        joinedAt: resolvedJoinedAt ?? startOfUtcWeek(now).toISOString(),
      };
      const timelines = await this.scopedSettingsTimelines(actor);
      await this.ensureReportObligations(
        actor,
        [leaderObligation],
        timelines.leaderRows,
        now,
        'LEADER',
      );
      await this.markOverdue(
        actor,
        projectId,
        now,
        new Set([actor.userId.toLowerCase()]),
        'LEADER',
      );
      const currentSetting = this.activeSetting(timelines.leaderRows, now);
      const period = calculateReportPeriod(
        currentSetting.effectiveAt instanceof Date
          ? currentSetting.effectiveAt
          : new Date(String(currentSetting.effectiveAt)),
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
            reportScope: 'LEADER',
            periodStart: period.periodStart,
          }),
      );
      if (!row) throw reportNotFound();
      return this.saveReportDraft(actor, row._id, input, 'LEADER');
    }

    if (!isActorPureMember(actor)) {
      throw new ForbiddenException({
        code: 'WORK_REPORT_MEMBER_ONLY',
        message:
          'Project Leaders and Managers are excluded from member Work Report obligations.',
      });
    }
    const member = this.resolveActorMemberObligation(actor);
    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    await this.ensureReportObligations(
      actor,
      [member],
      timelines.memberRows,
      now,
      'MEMBER',
    );
    await this.markOverdue(
      actor,
      projectId,
      now,
      new Set([member.userId.toLowerCase()]),
      'MEMBER',
    );
    const currentSetting = this.activeSetting(timelines.memberRows, now);
    const period = calculateReportPeriod(
      currentSetting.effectiveAt instanceof Date
        ? currentSetting.effectiveAt
        : new Date(String(currentSetting.effectiveAt)),
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
          $or: [{ reportScope: 'MEMBER' }, { reportScope: { $exists: false } }],
          periodStart: period.periodStart,
        }),
    );
    if (!row) throw reportNotFound();
    return this.saveReportDraft(actor, row._id, input, 'MEMBER');
  }

  async uploadWorkReportFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    name: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const cleanName = name.trim();
    const resolvedContentType =
      bytes.length > 0 &&
      bytes.length <= 20 * 1024 * 1024 &&
      cleanName.length > 0 &&
      cleanName.length <= 180 &&
      !/[\\/]/.test(cleanName) &&
      ![...cleanName].some((character) => character.charCodeAt(0) < 32)
        ? resolveValidatedDocumentContentType(cleanName, contentType, bytes)
        : null;
    if (!resolvedContentType)
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message:
          'A supported document file (PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, MD, CSV, TSV, JSON, YAML, XML, SQL, DRAWIO, PNG, JPG, WEBP) up to 20 MB is required.',
      });
    const id = objectId(reportId);
    const reports = this.database().collection('work_reports');
    const existing = await reports.findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      memberUserId: objectId(actor.userId),
      status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
    });
    if (!existing) throw reportNotFound();
    const existingScope: WorkReportScope =
      text((existing as Record<string, unknown>).reportScope) === 'LEADER'
        ? 'LEADER'
        : 'MEMBER';
    this.assertCanAuthorScope(actor, existingScope);
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    const key = `work-reports/${actor.organizationId}/${projectId}/${reportId}/${randomUUID()}`;
    await this.documentStorage.put(key, bytes, resolvedContentType);
    try {
      await this.transaction(async (db, session) => {
        const result = await db.collection('work_reports').updateOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            memberUserId: objectId(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
          },
          {
            $set: {
              file: {
                key,
                name: cleanName,
                contentType: resolvedContentType,
                size: bytes.length,
              },
              updatedAt: new Date(),
            },
          },
          { session },
        );
        if (result.matchedCount !== 1)
          throw conflict('The Work Report changed during file upload.');
        await this.auditEvent(
          actor,
          'REPORT_FILE_UPLOADED',
          'WORK_REPORT',
          reportId,
          { fileName: cleanName, size: bytes.length },
          session,
        );
      });
    } catch (error) {
      await this.documentStorage.delete(key).catch(() => undefined);
      throw error;
    }
    const oldKey = (existing.file as { key?: string } | undefined)?.key;
    if (oldKey && oldKey !== key) {
      await this.documentStorage.delete(oldKey).catch(() => undefined);
    }
    return this.getWorkReport(headers, projectId, reportId);
  }

  async downloadWorkReportFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<{ bytes: Buffer; name: string; contentType: string }> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const report = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          _id: objectId(reportId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        }),
    );
    if (!report || !this.canViewWorkReportRow(actor, report)) {
      throw reportNotFound();
    }
    const file = report.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (!file?.key || !file.name || !file.contentType) throw reportNotFound();
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
        }),
    );
    if (!row || !this.canViewWorkReportRow(actor, row)) {
      throw reportNotFound();
    }
    const memberId = String(row.memberUserId);
    const isLeaderReport = text(row.reportScope) === 'LEADER';
    const [memberName, hasActiveLeaders] = await Promise.all([
      memberId.toLowerCase() === actor.userId.toLowerCase()
        ? Promise.resolve(actor.userName)
        : isActorLeader(actor) || isActorManager(actor)
          ? isLeaderReport &&
            typeof this.authorization.listActiveLeaders === 'function'
            ? this.authorization
                .listActiveLeaders(actor, headers)
                .then(
                  (leaders) =>
                    leaders.find(
                      (leader) => leader.userId === memberId.toLowerCase(),
                    )?.fullName,
                )
            : this.authorization
                .listActiveMembers(actor, headers)
                .then(
                  (members) =>
                    members.find(
                      (member) =>
                        member.userId.toLowerCase() === memberId.toLowerCase(),
                    )?.fullName,
                )
          : Promise.resolve(undefined),
      this.resolveHasActiveLeaders(actor, headers),
    ]);
    return this.workReportRecord(row, actor, memberName, hasActiveLeaders);
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
    const { submittedScope } = await this.transaction(async (db, session) => {
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
      const currentScope: WorkReportScope =
        text(current.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
      this.assertCanAuthorScope(actor, currentScope);
      if (
        !text(current.accomplishments).trim() ||
        !text(current.approach).trim() ||
        !text(current.reason).trim()
      )
        throw conflict(
          'Complete the three required report fields before submitting.',
        );
      const currentMemberId = String(current.memberUserId);
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
            memberId: currentMemberId,
            scope: currentScope,
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'REPORT_SUBMITTED',
        'WORK_REPORT',
        reportId,
        {
          memberId: currentMemberId,
          scope: currentScope,
        },
        session,
      );
      return { memberId: currentMemberId, submittedScope: currentScope };
    });

    if (this.notifications) {
      try {
        const recipients =
          submittedScope === 'LEADER'
            ? await this.resolveOrganizationManagerRecipientIds(
                actor.organizationId,
              )
            : await this.resolveProjectLeaderRecipientIds(
                actor.organizationId,
                projectId,
              );
        if (recipients.length > 0) {
          const authorLabel = actor.userName || 'A team member';
          await this.notifications.emitSafe({
            type: 'WORK_REPORT_SUBMITTED',
            actorId: actor.userId,
            recipients,
            title:
              submittedScope === 'LEADER'
                ? 'Leader work report submitted for review'
                : 'Member work report submitted for review',
            message:
              submittedScope === 'LEADER'
                ? `${authorLabel} submitted a Leader work report awaiting Manager review.`
                : `${authorLabel} submitted a periodic work report awaiting Leader review.`,
            organizationId: actor.organizationId,
            projectId,
            target: {
              kind: 'PROJECT',
              url: `/projects/${projectId}/work-reports`,
              organizationId: actor.organizationId,
              projectId,
            },
            eventKey: `work-report-submitted:${reportId}:${now.getTime()}`,
          });
        }
      } catch {
        // Do not fail report submission if notification emit fails
      }
    }

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
    if (!isActorLeader(actor) && !isActorManager(actor)) {
      throw this.reviewPermissionDenied();
    }
    if (!validId(reportId)) throw reportNotFound();
    const hasActiveLeaders = await this.resolveHasActiveLeaders(actor, headers);
    const id = objectId(reportId);
    const now = new Date();
    const { memberId, reviewedScope } = await this.transaction(
      async (db, session) => {
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
        const isLeaderReport = text(current.reportScope) === 'LEADER';
        const currentScope: WorkReportScope = isLeaderReport
          ? 'LEADER'
          : 'MEMBER';
        const canReviewScope = isLeaderReport
          ? this.canManageLeaderTier(actor)
          : this.canManageMemberTier(actor, hasActiveLeaders);
        if (!canReviewScope) {
          throw this.reviewPermissionDenied();
        }
        const currentMemberId = String(current.memberUserId);
        assertReviewerCanReview(currentMemberId, actor.userId, canReviewScope);
        const reviewerRole: 'MANAGER' | 'LEADER' = isLeaderReport
          ? 'MANAGER'
          : isActorLeader(actor)
            ? 'LEADER'
            : 'MANAGER';
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
                  reviewerRole,
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
              memberId: currentMemberId,
              scope: currentScope,
              reviewerRole,
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
        const auditAction =
          action === 'APPROVED'
            ? 'REPORT_APPROVED'
            : action === 'CHANGES_REQUESTED'
              ? 'REPORT_CHANGES_REQUESTED'
              : 'REPORT_REJECTED';
        await this.auditEvent(
          actor,
          auditAction,
          'WORK_REPORT',
          reportId,
          {
            memberId: currentMemberId,
            scope: currentScope,
            reviewerRole,
          },
          session,
        );
        return { memberId: currentMemberId, reviewedScope: currentScope };
      },
    );
    if (this.notifications && memberId) {
      const notificationType =
        action === 'APPROVED'
          ? 'WORK_REPORT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'WORK_REPORT_CHANGES_REQUESTED'
            : 'WORK_REPORT_REJECTED';
      await this.notifications.emitSafe({
        type: notificationType,
        actorId: actor.userId,
        recipients: [memberId],
        title:
          action === 'APPROVED'
            ? reviewedScope === 'LEADER'
              ? 'Leader work report approved'
              : 'Work report approved'
            : action === 'CHANGES_REQUESTED'
              ? reviewedScope === 'LEADER'
                ? 'Changes requested on Leader work report'
                : 'Changes requested on work report'
              : reviewedScope === 'LEADER'
                ? 'Leader work report rejected'
                : 'Work report rejected',
        message: input.comment
          ? `Reviewer feedback: ${input.comment}`
          : `Your work report status was updated to ${action.replace('_', ' ').toLowerCase()}.`,
        organizationId: actor.organizationId,
        projectId,
        target: {
          kind: 'PROJECT',
          url: `/projects/${projectId}/work-reports`,
          organizationId: actor.organizationId,
          projectId,
        },
        eventKey: `work-report-review:${reportId}:${action}:${now.getTime()}`,
      });
    }
    return this.getWorkReport(headers, projectId, reportId);
  }

  async sweepOverdueReports(
    activeRosters?: ReportingProjectMembers[],
  ): Promise<number> {
    const db = this.database();
    const now = new Date();
    const rostersByProject = activeRosters
      ? new Map(
          activeRosters.map((roster) => [
            roster.projectId.toLowerCase(),
            {
              members: new Set(
                roster.members.map((member) => member.userId.toLowerCase()),
              ),
              leaders: roster.leaders
                ? new Set(
                    roster.leaders.map((leader) => leader.userId.toLowerCase()),
                  )
                : undefined,
            },
          ]),
        )
      : undefined;
    const rows = await db
      .collection('work_reports')
      .find({ status: 'DRAFT', dueAt: { $lte: now } })
      .sort({ dueAt: 1, _id: 1 })
      .limit(500)
      .toArray();
    let transitioned = 0;
    for (const candidate of rows) {
      const item = candidate as unknown as Record<string, unknown>;
      const candidateProjectId = String(item.projectId).toLowerCase();
      const candidateMemberId = String(item.memberUserId).toLowerCase();
      const candidateScope: WorkReportScope =
        text(item.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
      if (rostersByProject) {
        const projectRoster = rostersByProject.get(candidateProjectId);
        if (!projectRoster) {
          continue;
        }
        if (candidateScope === 'LEADER') {
          if (
            projectRoster.leaders &&
            !projectRoster.leaders.has(candidateMemberId)
          ) {
            continue;
          }
        } else if (!projectRoster.members.has(candidateMemberId)) {
          continue;
        }
      }
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
            scope: candidateScope,
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
      if (didTransition) {
        transitioned += 1;
        if (this.notifications) {
          await this.notifications.emitSafe({
            type: 'WORK_REPORT_OVERDUE',
            actorId: null,
            recipients: [String(item.memberUserId)],
            title:
              candidateScope === 'LEADER'
                ? 'Leader work report overdue'
                : 'Work report overdue',
            message:
              'Your periodic work report has passed its due date. Please complete and submit your report.',
            organizationId: String(item.organizationId),
            projectId: String(item.projectId),
            target: {
              kind: 'PROJECT',
              url: `/projects/${String(item.projectId)}/work-reports`,
              organizationId: String(item.organizationId),
              projectId: String(item.projectId),
            },
            eventKey: `work-report-overdue:${String(id)}`,
          });
        }
      }
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
    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    if (project.members.length > 0) {
      await this.ensureReportObligations(
        actor,
        project.members,
        timelines.memberRows,
        now,
        'MEMBER',
      );
    }
    if ((project.leaders?.length ?? 0) > 0) {
      await this.ensureReportObligations(
        actor,
        project.leaders!,
        timelines.leaderRows,
        now,
        'LEADER',
      );
    }
  }

  private async saveReportDraft(
    actor: WorkNotesActor,
    reportId: Types.ObjectId,
    input: WorkReportInput,
    expectedScope?: WorkReportScope,
  ): Promise<WorkReportRecord> {
    const reports = this.database().collection('work_reports');
    const existingReport = record(
      await reports.findOne({
        _id: reportId,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
      }),
    );
    const resolvedScope: WorkReportScope =
      expectedScope ??
      (text(existingReport?.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER');
    this.assertCanAuthorScope(actor, resolvedScope);
    if (!existingReport) throw reportNotFound();
    const now = new Date();
    await this.transaction(async (db, session) => {
      const txReports = db.collection('work_reports');
      const update = await txReports.updateOne(
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
            ...(input.documentIds !== undefined
              ? { documentIds: input.documentIds }
              : {}),
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.matchedCount !== 1) {
        const exists = await txReports.findOne(
          {
            _id: reportId,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(actor.projectId),
          },
          { session },
        );
        if (!exists) throw reportNotFound();
        throw conflict('Only your unsubmitted Work Report can be edited.');
      }
      await this.auditEvent(
        actor,
        'REPORT_DRAFT_SAVED',
        'WORK_REPORT',
        String(reportId),
        undefined,
        session,
      );
    });
    const row = await reports.findOne({ _id: reportId });
    if (!row) throw reportNotFound();
    return this.workReportRecord(row, actor);
  }

  private assertCanAuthorScope(
    actor: WorkNotesActor,
    scope: WorkReportScope,
  ): void {
    if (scope === 'LEADER') {
      if (!isActorLeader(actor)) {
        throw new ForbiddenException({
          code: 'WORK_REPORT_LEADER_ONLY',
          message: 'Only Project Leaders can author a Leader Work Report.',
        });
      }
      return;
    }
    if (!isActorPureMember(actor)) {
      throw new ForbiddenException({
        code: 'WORK_REPORT_MEMBER_ONLY',
        message:
          'Project Leaders and Managers are excluded from member Work Report obligations.',
      });
    }
  }

  private canManageLeaderTier(actor: WorkNotesActor): boolean {
    return isActorManager(actor);
  }

  private canManageMemberTier(
    actor: WorkNotesActor,
    hasActiveLeaders = true,
  ): boolean {
    return isActorLeader(actor) || (isActorManager(actor) && !hasActiveLeaders);
  }

  private canViewWorkReportRow(
    actor: WorkNotesActor,
    row: Record<string, unknown>,
  ): boolean {
    const reportScope: WorkReportScope =
      text(row.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
    const isOwner =
      String(row.memberUserId).toLowerCase() === actor.userId.toLowerCase();
    if (reportScope === 'LEADER') {
      return isActorManager(actor) || (isActorLeader(actor) && isOwner);
    }
    return isActorLeader(actor) || isActorManager(actor) || isOwner;
  }

  private async resolveHasActiveLeaders(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<boolean> {
    if (isActorLeader(actor)) return true;
    if (!isActorManager(actor)) return true;
    if (typeof this.authorization.listActiveLeaders === 'function') {
      const leaders = await this.authorization.listActiveLeaders(
        actor,
        headers,
      );
      return leaders.length > 0;
    }
    if (this.reportRoster) {
      const leaderIds = await this.reportRoster.listActiveProjectLeaderIds(
        actor.organizationId,
        actor.projectId,
      );
      return leaderIds.length > 0;
    }
    return true;
  }

  private async resolveProjectLeaderRecipientIds(
    organizationId: string,
    projectId: string,
  ): Promise<string[]> {
    if (!this.reportRoster) return [];
    try {
      return await this.reportRoster.listActiveProjectLeaderIds(
        organizationId,
        projectId,
      );
    } catch {
      return [];
    }
  }

  private async resolveOrganizationManagerRecipientIds(
    organizationId: string,
  ): Promise<string[]> {
    if (!this.reportRoster) return [];
    try {
      return await this.reportRoster.listActiveOrganizationManagerIds(
        organizationId,
      );
    } catch {
      return [];
    }
  }

  private async queryWorkReportsPage(params: {
    collection: ReturnType<Db['collection']>;
    actor: WorkNotesActor;
    scope: WorkReportScope;
    scopeRows: MongoRecord[];
    rosterPeople: Array<{ userId: string; fullName: string; joinedAt: string }>;
    allDirectoryPeople: Array<{
      userId: string;
      fullName: string;
      joinedAt: string;
    }>;
    canViewAllInScope: boolean;
    hasActiveLeaders: boolean;
    baseVisibilityFilter: Record<string, unknown>;
    page: number;
    pageSize: number;
    status?: WorkReportStatus;
    filters?: WorkReportsListFilters;
    now: Date;
  }): Promise<WorkReportsPageRecord> {
    const {
      collection,
      actor,
      scope,
      scopeRows,
      rosterPeople,
      allDirectoryPeople,
      canViewAllInScope,
      hasActiveLeaders,
      baseVisibilityFilter,
      page,
      pageSize,
      status,
      filters,
      now,
    } = params;

    const currentActiveSetting = this.activeSetting(scopeRows, now);
    const currentFrequency = (text(currentActiveSetting.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const currentEffectiveAt =
      currentActiveSetting.effectiveAt instanceof Date
        ? currentActiveSetting.effectiveAt
        : new Date(String(currentActiveSetting.effectiveAt));
    const currentPeriodDates = calculateReportPeriod(
      currentEffectiveAt,
      currentFrequency,
      now,
    );
    const currentPeriod = {
      periodStart: currentPeriodDates.periodStart.toISOString(),
      periodEnd: currentPeriodDates.periodEnd.toISOString(),
      dueAt: currentPeriodDates.periodEnd.toISOString(),
      frequency: currentFrequency,
    };

    const periodFilter =
      filters?.period === 'CURRENT'
        ? { periodStart: currentPeriodDates.periodStart }
        : {};

    const summaryMatchFilter: Record<string, unknown> = {
      ...baseVisibilityFilter,
      ...periodFilter,
    };

    const queryConditions: Record<string, unknown>[] = [
      baseVisibilityFilter,
      ...(filters?.period === 'CURRENT'
        ? [{ periodStart: currentPeriodDates.periodStart }]
        : []),
      ...(status ? [{ status }] : []),
    ];

    if (filters?.memberId) {
      if (
        !canViewAllInScope &&
        filters.memberId.toLowerCase() !== actor.userId.toLowerCase()
      ) {
        queryConditions.push({
          memberUserId: new Types.ObjectId('000000000000000000000000'),
        });
      } else {
        queryConditions.push({ memberUserId: objectId(filters.memberId) });
      }
    }

    if (filters?.search) {
      const escaped = escapeRegex(filters.search);
      const regex = new RegExp(escaped, 'i');
      const matchingPeopleIds = allDirectoryPeople
        .filter((person) => regex.test(person.fullName))
        .map((person) => person.userId)
        .filter(validId)
        .map(objectId);
      queryConditions.push({
        $or: [
          { accomplishments: regex },
          { approach: regex },
          { reason: regex },
          { blockers: regex },
          { nextSteps: regex },
          { reviewComment: regex },
          ...(matchingPeopleIds.length > 0
            ? [{ memberUserId: { $in: matchingPeopleIds } }]
            : []),
        ],
      });
    }

    const finalFilter: Record<string, unknown> =
      queryConditions.length === 1
        ? queryConditions[0]
        : { $and: queryConditions };

    const [rows, totalItems, statusBuckets, currentPeriodRows] =
      await Promise.all([
        collection
          .find(finalFilter)
          .sort({ periodStart: -1, memberUserId: 1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray(),
        collection.countDocuments(finalFilter),
        collection
          .aggregate<{ _id: string; count: number }>([
            { $match: summaryMatchFilter },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .toArray(),
        collection
          .find({
            ...baseVisibilityFilter,
            periodStart: currentPeriodDates.periodStart,
          })
          .toArray(),
      ]);

    const summary: WorkReportSummaryCounts = {
      total: 0,
      draft: 0,
      pendingReview: 0,
      changesRequested: 0,
      approved: 0,
      rejected: 0,
      overdue: 0,
    };
    for (const bucket of statusBuckets) {
      const count = Number(bucket.count) || 0;
      summary.total += count;
      switch (bucket._id) {
        case 'DRAFT':
          summary.draft = count;
          break;
        case 'PENDING_REVIEW':
          summary.pendingReview = count;
          break;
        case 'CHANGES_REQUESTED':
          summary.changesRequested = count;
          break;
        case 'APPROVED':
          summary.approved = count;
          break;
        case 'REJECTED':
          summary.rejected = count;
          break;
        case 'OVERDUE':
          summary.overdue = count;
          break;
        default:
          break;
      }
    }

    const currentReportByUserId = new Map<string, Record<string, unknown>>();
    for (const currentRow of currentPeriodRows) {
      const item = currentRow as unknown as Record<string, unknown>;
      currentReportByUserId.set(String(item.memberUserId).toLowerCase(), item);
    }

    const roster: WorkReportRosterEntry[] = rosterPeople.map((person) => {
      const currentReport = currentReportByUserId.get(
        person.userId.toLowerCase(),
      );
      return {
        userId: person.userId,
        fullName: person.fullName,
        joinedAt: person.joinedAt,
        ...(currentReport ? { reportId: String(currentReport._id) } : {}),
        status: currentReport
          ? (text(currentReport.status) as WorkReportStatus)
          : 'NOT_STARTED',
        dueAt: iso(currentReport?.dueAt) ?? currentPeriod.dueAt,
        ...(iso(currentReport?.submittedAt)
          ? { submittedAt: iso(currentReport?.submittedAt) }
          : {}),
        ...(iso(currentReport?.reviewedAt)
          ? { reviewedAt: iso(currentReport?.reviewedAt) }
          : {}),
      };
    });

    return {
      data: rows.map((row) => {
        const authorId = String(row.memberUserId).toLowerCase();
        const authorName = allDirectoryPeople.find(
          (person) => person.userId.toLowerCase() === authorId,
        )?.fullName;
        return this.workReportRecord(row, actor, authorName, hasActiveLeaders);
      }),
      pagination: this.pagination(page, pageSize, totalItems),
      scope,
      summary,
      currentPeriod,
      roster,
    };
  }

  private async scopedSettingsTimelines(actor: WorkNotesActor): Promise<{
    memberRows: MongoRecord[];
    leaderRows: MongoRecord[];
    hasExplicitLeaderRows: boolean;
  }> {
    const collection = this.database().collection('work_report_settings');
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(actor.projectId),
    };
    let rows: MongoRecord[] = await collection
      .find(filter)
      .sort({ effectiveAt: 1, _id: 1 })
      .toArray();

    if (rows.length === 0) {
      const now = new Date();
      const effectiveAt = startOfUtcWeek(now);
      const actorObjectId = validId(actor.userId)
        ? objectId(actor.userId)
        : new Types.ObjectId();
      const defaultMemberSetting = {
        _id: new Types.ObjectId(),
        ...filter,
        reportScope: 'MEMBER' as const,
        frequency: 'WEEKLY' as const,
        effectiveAt,
        createdByUserId: actorObjectId,
        updatedByUserId: actorObjectId,
        history: [
          {
            frequency: 'WEEKLY' as const,
            effectiveAt,
            updatedByUserId: actorObjectId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const defaultLeaderSetting = {
        _id: new Types.ObjectId(),
        ...filter,
        reportScope: 'LEADER' as const,
        frequency: 'WEEKLY' as const,
        effectiveAt,
        createdByUserId: actorObjectId,
        updatedByUserId: actorObjectId,
        history: [
          {
            frequency: 'WEEKLY' as const,
            effectiveAt,
            updatedByUserId: actorObjectId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      for (const candidate of [defaultMemberSetting, defaultLeaderSetting]) {
        try {
          await collection.insertOne(candidate);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 11000
          ) {
            throw error;
          }
        }
      }
      rows = await collection
        .find(filter)
        .sort({ effectiveAt: 1, _id: 1 })
        .toArray();
    }

    const memberRows = rows.filter((row) => text(row.reportScope) !== 'LEADER');
    const explicitLeaderRows = rows.filter(
      (row) => text(row.reportScope) === 'LEADER',
    );
    if (explicitLeaderRows.length > 0) {
      return {
        memberRows:
          memberRows.length > 0 ? memberRows : [explicitLeaderRows[0]],
        leaderRows: explicitLeaderRows,
        hasExplicitLeaderRows: true,
      };
    }

    const legacyLeaderRows = this.legacyLeaderSettingsTimeline(
      memberRows,
      actor.userId,
    );
    return {
      memberRows,
      leaderRows: legacyLeaderRows,
      hasExplicitLeaderRows: false,
    };
  }

  private legacyLeaderSettingsTimeline(
    memberSettings: MongoRecord[],
    fallbackUserId: string,
  ): MongoRecord[] {
    const root = memberSettings[0];
    if (!root) return [];
    const frequency = (text(root.leaderFrequency) ||
      'WEEKLY') as WorkReportFrequency;
    const effectiveAt =
      root.leaderEffectiveAt instanceof Date
        ? root.leaderEffectiveAt
        : new Date(String(root.leaderEffectiveAt ?? root.effectiveAt));
    const updatedBy =
      idText(root.leaderUpdatedByUserId ?? root.createdByUserId) ||
      fallbackUserId;
    const history = Array.isArray(root.leaderHistory)
      ? (root.leaderHistory as Array<Record<string, unknown>>)
      : [{ frequency, effectiveAt, updatedBy }];
    return history.map((entry) => ({
      _id: root._id,
      organizationId: root.organizationId,
      projectId: root.projectId,
      reportScope: 'LEADER',
      frequency: text(entry.frequency) || frequency,
      effectiveAt:
        entry.effectiveAt instanceof Date
          ? entry.effectiveAt
          : new Date(String(entry.effectiveAt)),
      createdByUserId: entry.updatedByUserId ?? entry.updatedBy ?? updatedBy,
      updatedByUserId: entry.updatedByUserId ?? entry.updatedBy ?? updatedBy,
    }));
  }

  private extractSettingRowHistory(
    row: MongoRecord,
    defaultEffectiveAt: Date,
    fallbackUserId: string,
  ): Array<{
    frequency: WorkReportFrequency;
    effectiveAt: string;
    updatedBy: string;
  }> {
    const rowFrequency = (text(row.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const rowUpdatedBy =
      idText(row.updatedByUserId ?? row.createdByUserId) || fallbackUserId;
    if (Array.isArray(row.history) && row.history.length > 0) {
      return (row.history as Array<Record<string, unknown>>).map((entry) => ({
        frequency: (text(entry.frequency) ||
          rowFrequency) as WorkReportFrequency,
        effectiveAt: iso(entry.effectiveAt) ?? defaultEffectiveAt.toISOString(),
        updatedBy:
          idText(entry.updatedByUserId ?? entry.updatedBy) || rowUpdatedBy,
      }));
    }
    return [
      {
        frequency: rowFrequency,
        effectiveAt: iso(row.effectiveAt) ?? defaultEffectiveAt.toISOString(),
        updatedBy: rowUpdatedBy,
      },
    ];
  }

  private buildTierSettingsSummary(
    rows: MongoRecord[],
    actor: WorkNotesActor,
    now: Date,
    permissions: {
      canConfigure: boolean;
      canReview: boolean;
      canSubmit: boolean;
    },
  ): WorkReportTierSettingsSummary {
    const active = this.activeSetting(rows, now);
    const next = rows.find(
      (item) => new Date(String(item.effectiveAt)).getTime() > now.getTime(),
    );
    const activeEffectiveAt =
      active.effectiveAt instanceof Date
        ? active.effectiveAt
        : new Date(String(active.effectiveAt));
    const history = rows.flatMap((item) => {
      const itemEffectiveAt =
        item.effectiveAt instanceof Date
          ? item.effectiveAt
          : new Date(String(item.effectiveAt));
      return this.extractSettingRowHistory(item, itemEffectiveAt, actor.userId);
    });
    const latestHistoryEntry = history.at(-1);
    const updatedBy =
      latestHistoryEntry?.updatedBy ||
      idText(active.updatedByUserId ?? active.createdByUserId) ||
      actor.userId;

    return {
      frequency: (text(active.frequency) || 'WEEKLY') as WorkReportFrequency,
      effectiveAt: iso(active.effectiveAt) ?? activeEffectiveAt.toISOString(),
      ...(next
        ? {
            nextFrequency: text(next.frequency) as WorkReportFrequency,
            nextEffectiveAt: iso(next.effectiveAt),
          }
        : {}),
      updatedBy,
      history,
      permissions,
    };
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
    timelines: {
      memberRows: MongoRecord[];
      leaderRows: MongoRecord[];
    },
    actor: WorkNotesActor,
    now: Date,
    scope: WorkReportScope = 'MEMBER',
    hasActiveLeaders = true,
  ): WorkReportSettingsRecord {
    const isManager = isActorManager(actor);
    const isLeader = isActorLeader(actor);
    const isPureMember = isActorPureMember(actor);
    const actorRole: 'MANAGER' | 'LEADER' | 'MEMBER' = isManager
      ? 'MANAGER'
      : isLeader
        ? 'LEADER'
        : 'MEMBER';

    const memberCanManage = this.canManageMemberTier(actor, hasActiveLeaders);
    const leaderCanManage = this.canManageLeaderTier(actor);

    const memberSummary = this.buildTierSettingsSummary(
      timelines.memberRows,
      actor,
      now,
      {
        canConfigure: memberCanManage,
        canReview: memberCanManage,
        canSubmit: isPureMember,
      },
    );
    const leaderSummary = this.buildTierSettingsSummary(
      timelines.leaderRows,
      actor,
      now,
      {
        canConfigure: leaderCanManage,
        canReview: leaderCanManage,
        canSubmit: isLeader,
      },
    );

    const activeTier = scope === 'LEADER' ? leaderSummary : memberSummary;
    return {
      projectId: actor.projectId,
      scope,
      actorRole,
      isManager,
      isLeader,
      hasActiveLeaders,
      frequency: activeTier.frequency,
      effectiveAt: activeTier.effectiveAt,
      ...(activeTier.nextFrequency
        ? {
            nextFrequency: activeTier.nextFrequency,
            nextEffectiveAt: activeTier.nextEffectiveAt,
          }
        : {}),
      updatedBy: activeTier.updatedBy,
      history: activeTier.history,
      permissions: activeTier.permissions,
      memberSettings: memberSummary,
      ...(!isPureMember ? { leaderSettings: leaderSummary } : {}),
    };
  }

  private async ensureReportObligations(
    actor: WorkNotesActor,
    members: Array<{ userId: string; joinedAt: string }>,
    settings: MongoRecord[],
    now: Date,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<void> {
    const reports = this.database().collection('work_reports');
    const operations: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: { $setOnInsert: Record<string, unknown> };
        upsert: true;
      };
    }> = [];
    const currentPeriodNotifications: Array<{
      memberId: string;
      frequency: WorkReportFrequency;
      periodStart: Date;
      dueAt: Date;
    }> = [];
    const maxPeriodsPerMember = 20_000;
    const periodStartByUser = new Map<string, number>();

    for (let index = 0; index < settings.length; index += 1) {
      const setting = settings[index];
      const segmentStart =
        setting.effectiveAt instanceof Date
          ? setting.effectiveAt
          : new Date(String(setting.effectiveAt));
      const nextSetting = settings[index + 1];
      const segmentEnd = nextSetting
        ? nextSetting.effectiveAt instanceof Date
          ? nextSetting.effectiveAt
          : new Date(String(nextSetting.effectiveAt))
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
        const isCurrentPeriod =
          start.getTime() <= now.getTime() && end.getTime() > now.getTime();
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
                reportScope: scope,
                periodStart: start,
              },
              update: {
                $setOnInsert: {
                  _id: id,
                  organizationId: objectId(actor.organizationId),
                  projectId: projectObjectId,
                  memberUserId: memberObjectId,
                  reportScope: scope,
                  frequency,
                  periodStart: start,
                  periodEnd: end,
                  dueAt: end,
                  accomplishments: '',
                  approach: '',
                  reason: '',
                  blockers: '',
                  nextSteps: '',
                  documentIds: [],
                  status: 'DRAFT',
                  reviewHistory: [],
                  createdAt: now,
                  updatedAt: now,
                },
              },
              upsert: true,
            },
          });
          if (isCurrentPeriod) {
            currentPeriodNotifications.push({
              memberId,
              frequency,
              periodStart: start,
              dueAt: end,
            });
          }
        }
        periodStart = new Date(periodStart.getTime() + periodLengthMs);
      }
    }

    let upsertedCount = 0;
    for (let offset = 0; offset < operations.length; offset += 500) {
      const batch = operations.slice(offset, offset + 500);
      try {
        const result = await reports.bulkWrite(batch, { ordered: false });
        upsertedCount += result.upsertedCount ?? 0;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 11000
        )
          throw error;
      }
    }

    if (
      upsertedCount > 0 &&
      this.notifications &&
      currentPeriodNotifications.length > 0
    ) {
      for (const item of currentPeriodNotifications) {
        const days = getFrequencyDays(item.frequency);
        const dueDateLabel = item.dueAt.toISOString().slice(0, 10);
        await this.notifications.emitSafe({
          type: 'TASK_DEADLINE_APPROACHING',
          actorId: null,
          recipients: [item.memberId],
          title:
            scope === 'LEADER'
              ? 'Leader work report due to Manager'
              : 'Periodic work report due',
          message:
            scope === 'LEADER'
              ? `Your Leader report (every ${days} ${days === 1 ? 'day' : 'days'}) is due by ${dueDateLabel}.`
              : `Your periodic work report (every ${days} ${days === 1 ? 'day' : 'days'}) is due by ${dueDateLabel}.`,
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          target: {
            kind: 'PROJECT',
            url: `/projects/${actor.projectId}/work-reports`,
            organizationId: actor.organizationId,
            projectId: actor.projectId,
          },
          eventKey: `work-report-due:${actor.projectId}:${scope}:${item.memberId}:${item.periodStart.toISOString()}`,
        });
      }
    }
  }

  private workReportRecord(
    row: Document,
    actor: WorkNotesActor,
    resolvedMemberName?: string,
    hasActiveLeaders = true,
  ): WorkReportRecord {
    const value = row as unknown as Record<string, unknown>;
    const memberId = String(value.memberUserId);
    const status = text(value.status) as WorkReportStatus;
    const reportScope: WorkReportScope =
      text(value.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
    const isOwner = memberId.toLowerCase() === actor.userId.toLowerCase();
    const canAuthorReport =
      reportScope === 'LEADER'
        ? isActorLeader(actor)
        : isActorPureMember(actor);
    const canManageScope =
      reportScope === 'LEADER'
        ? this.canManageLeaderTier(actor)
        : this.canManageMemberTier(actor, hasActiveLeaders);
    const canReviewReport =
      canManageScope && !isOwner && status === 'PENDING_REVIEW';
    const canConfigureReport = canManageScope;

    return {
      id: String(value._id),
      projectId: String(value.projectId),
      memberId,
      memberName: isOwner ? actor.userName : resolvedMemberName || memberId,
      reportScope,
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
      ...(Array.isArray(value.documentIds)
        ? {
            documentIds: (value.documentIds as unknown[])
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim()),
          }
        : {}),
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
        canCreate: canAuthorReport,
        canEdit:
          canAuthorReport &&
          isOwner &&
          ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canSubmit:
          canAuthorReport &&
          isOwner &&
          ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canReview: canReviewReport,
        canConfigure: canConfigureReport,
      },
    };
  }

  private resolveActorMemberObligation(actor: WorkNotesActor): {
    userId: string;
    fullName: string;
    joinedAt: string;
  } {
    if (!actor.joinedAt || !Number.isFinite(Date.parse(actor.joinedAt))) {
      throw new ServiceUnavailableException({
        code: 'PROJECT_MEMBERS_UNAVAILABLE',
        message: 'Active Project member join date is unavailable.',
      });
    }
    return {
      userId: actor.userId,
      fullName: actor.userName,
      joinedAt: actor.joinedAt,
    };
  }

  private async markOverdue(
    actor: WorkNotesActor,
    projectId: string,
    now: Date,
    activeMemberIds?: ReadonlySet<string>,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<void> {
    if (activeMemberIds && activeMemberIds.size === 0) return;
    const allowedMemberObjectIds = activeMemberIds
      ? [...activeMemberIds].filter(validId).map(objectId)
      : undefined;
    const candidates = await this.database()
      .collection('work_reports')
      .find({
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        ...(scope === 'LEADER'
          ? { reportScope: 'LEADER' }
          : {
              $or: [
                { reportScope: 'MEMBER' },
                { reportScope: { $exists: false } },
              ],
            }),
        ...(allowedMemberObjectIds
          ? { memberUserId: { $in: allowedMemberObjectIds } }
          : {}),
        status: 'DRAFT',
        dueAt: { $lte: now },
      })
      .limit(500)
      .toArray();
    for (const candidate of candidates) {
      const item = candidate as unknown as Record<string, unknown>;
      const id = objectId(String(item._id));
      let didTransition = false;
      await this.transaction(async (db, session) => {
        const update = await db
          .collection('work_reports')
          .updateOne(
            { _id: id, status: 'DRAFT', dueAt: { $lte: now } },
            { $set: { status: 'OVERDUE', updatedAt: now } },
            { session },
          );
        if (update.modifiedCount !== 1) return;
        didTransition = true;
        const commonPayload = {
          organizationId: actor.organizationId,
          projectId,
          memberId: String(item.memberUserId),
          scope,
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
      if (didTransition && this.notifications) {
        await this.notifications.emitSafe({
          type: 'WORK_REPORT_OVERDUE',
          actorId: null,
          recipients: [String(item.memberUserId)],
          title:
            scope === 'LEADER'
              ? 'Leader work report overdue'
              : 'Work report overdue',
          message:
            'Your periodic work report has passed its due date. Please complete and submit your report.',
          organizationId: actor.organizationId,
          projectId,
          target: {
            kind: 'PROJECT',
            url: `/projects/${projectId}/work-reports`,
            organizationId: actor.organizationId,
            projectId,
          },
          eventKey: `work-report-overdue:${String(id)}`,
        });
      }
    }
  }

  private taskNoteRecord(row: Document, actor: WorkNotesActor): TaskNoteRecord {
    const value = row as unknown as Record<string, unknown>;
    const authorId = String(value.authorUserId);
    return {
      id: String(value._id),
      projectId: String(value.projectId),
      taskId: String(value.taskId),
      ...(actor.taskKey ? { taskKey: actor.taskKey } : {}),
      ...(actor.taskTitle ? { taskTitle: actor.taskTitle } : {}),
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
    session?: ClientSession,
  ): Promise<void> {
    await this.audit?.append(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        actorUserId: actor.userId,
        action,
        targetResource,
        targetResourceId,
        ...(metadata ? { metadata } : {}),
      },
      session,
    );
  }
}
