import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { SERVICE_DATABASES } from '../../common/mongodb/database-names';
import {
  readCookie,
  validCsrfPair,
} from '../iam/application/authentication/authentication.application.service';
import { IAM_PERSISTENCE } from '../iam/infrastructure/persistence';
import { NotificationService } from '../notification/notification.service';
import {
  TASK_WORKSPACE_IAM_BRIDGE,
  type TaskWorkspaceIamBridgePort,
} from '../task/workspace/task-workspace-iam.bridge';
import { CAPTURE_PERSISTENCE } from './infrastructure/persistence';

export interface WorkNoteDto {
  id: string;
  organizationId: string;
  projectId: string;
  authorId: string;
  authorName: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  taskKey?: string | null;
  blocker?: string | null;
  unfinished?: string | null;
  nextStep?: string | null;
  tags: string[];
  pinned: boolean;
  mentionUserIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface StoredWorkNoteRecord {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  authorUserId: Types.ObjectId;
  title: string;
  whatDone: string;
  howSolved: string;
  whyThisWay: string;
  status: 'DRAFT' | 'CONFIRMED' | 'ARCHIVED';
  tags: string[];
  category?: string;
  taskKey?: string | null;
  blocker?: string | null;
  unfinished?: string | null;
  nextStep?: string | null;
  pinned?: boolean;
  mentionUserIds?: string[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const OBJECT_ID_REGEX = /^[0-9a-f]{24}$/i;

@Injectable()
export class ProjectWorkNotesService {
  private readonly memoryNotes = new Map<string, StoredWorkNoteRecord>();

  constructor(
    @Inject(TASK_WORKSPACE_IAM_BRIDGE)
    private readonly iamBridge: TaskWorkspaceIamBridgePort,
    private readonly notificationService: NotificationService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly captureConnection?: Connection,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
  ) {}

  private notesCollection() {
    const conn = this.captureConnection ?? this.iamConnection;
    if (!conn || typeof conn.useDb !== 'function') return null;
    const db = conn.useDb(SERVICE_DATABASES.capture, { useCache: true }).db;
    if (!db) return null;
    return db.collection<StoredWorkNoteRecord>('work_notes');
  }

  private iamUsersCollection() {
    const conn = this.iamConnection ?? this.captureConnection;
    if (!conn || typeof conn.useDb !== 'function') return null;
    const db = conn.useDb(SERVICE_DATABASES.iam, { useCache: true }).db;
    if (!db) return null;
    return db.collection('users');
  }

  private assertCsrfIfCookieAuthenticated(
    authorizationHeader: string | undefined,
    cookieHeader: string | undefined,
    csrfHeader: string | undefined,
  ): void {
    const hasBearer =
      typeof authorizationHeader === 'string' &&
      authorizationHeader.trim().toLowerCase().startsWith('bearer ');
    if (hasBearer) return;

    const cookieToken =
      readCookie(cookieHeader, '__Host-csrf') ??
      readCookie(cookieHeader, 'continuum_csrf') ??
      readCookie(cookieHeader, 'csrf_token');
    const trimmedHeader =
      typeof csrfHeader === 'string' ? csrfHeader.trim() : '';
    if (!validCsrfPair(cookieToken, trimmedHeader)) {
      throw new ForbiddenException({
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing or invalid CSRF token.',
      });
    }
  }

  private async resolveMentionsFromTextAndIds(
    organizationId: string,
    projectId: string,
    explicitIds: readonly string[],
    textContent: string,
  ): Promise<string[]> {
    const candidateIds = new Set<string>();
    for (const id of explicitIds) {
      if (typeof id === 'string' && OBJECT_ID_REGEX.test(id.trim())) {
        candidateIds.add(id.trim().toLowerCase());
      }
    }

    // Parse @[Name](userId) or @[userId] tokens from textContent
    const idTokenMatches = textContent.matchAll(/@\[[^\]]*\]\(([0-9a-fA-F]{24})\)|@\[([0-9a-fA-F]{24})\]/g);
    for (const match of idTokenMatches) {
      const matchedId = (match[1] ?? match[2] ?? '').trim().toLowerCase();
      if (OBJECT_ID_REGEX.test(matchedId)) {
        candidateIds.add(matchedId);
      }
    }

    // Parse @email tokens from textContent
    const emailMatches = textContent.match(
      /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g,
    );
    if (emailMatches && emailMatches.length > 0) {
      const usersCol = this.iamUsersCollection();
      if (usersCol) {
        const emails = [
          ...new Set(
            emailMatches.map((token) => token.slice(1).trim().toLowerCase()),
          ),
        ];
        const foundUsers = await usersCol
          .find(
            { email: { $in: emails }, status: 'ACTIVE' },
            { projection: { _id: 1 } },
          )
          .toArray();
        for (const u of foundUsers) {
          if (u._id) candidateIds.add(String(u._id).toLowerCase());
        }
      }
    }

    const hasDatabase = Boolean(this.notesCollection());
    const validMemberIds: string[] = [];
    for (const userId of candidateIds) {
      const isMember = await this.iamBridge
        .isActiveProjectMember(organizationId, projectId, userId)
        .catch(() => !hasDatabase);
      if (isMember) {
        validMemberIds.push(userId);
      }
    }

    return validMemberIds;
  }

  async listProjectWorkNotes(input: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
  }): Promise<{ items: WorkNoteDto[] }> {
    const ctx = await this.iamBridge.resolveProjectContext(
      input.authorizationHeader,
      input.cookieHeader,
      input.projectId,
      input.headerOrgId,
    );

    const col = this.notesCollection();
    let records: StoredWorkNoteRecord[];
    if (!col) {
      records = [...this.memoryNotes.values()]
        .filter(
          (n) =>
            n.projectId.toHexString() === ctx.projectId &&
            n.organizationId.toHexString() === ctx.organizationId &&
            !n.deletedAt,
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    } else {
      records = await col
        .find({
          organizationId: new Types.ObjectId(ctx.organizationId),
          projectId: new Types.ObjectId(ctx.projectId),
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        })
        .sort({ pinned: -1, updatedAt: -1 })
        .limit(100)
        .toArray();
    }

    const authorIds = [
      ...new Set(records.map((r) => r.authorUserId.toHexString())),
    ];
    const authorsById = await this.iamBridge
      .resolveUsersById(authorIds)
      .catch(() => new Map<string, { id: string; fullName: string }>());

    return {
      items: records.map((r) =>
        this.toDto(
          r,
          authorsById.get(r.authorUserId.toHexString())?.fullName ??
            ctx.actorName,
        ),
      ),
    };
  }

  async getProjectWorkNote(input: {
    authorizationHeader?: string;
    cookieHeader?: string;
    headerOrgId?: string;
    projectId: string;
    noteId: string;
  }): Promise<WorkNoteDto> {
    const ctx = await this.iamBridge.resolveProjectContext(
      input.authorizationHeader,
      input.cookieHeader,
      input.projectId,
      input.headerOrgId,
    );
    if (!OBJECT_ID_REGEX.test(input.noteId)) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    const col = this.notesCollection();
    let record: StoredWorkNoteRecord | null = null;
    if (!col) {
      const mem = this.memoryNotes.get(input.noteId.toLowerCase());
      if (
        mem &&
        mem.projectId.toHexString() === ctx.projectId &&
        !mem.deletedAt
      ) {
        record = mem;
      }
    } else {
      record = await col.findOne({
        _id: new Types.ObjectId(input.noteId),
        organizationId: new Types.ObjectId(ctx.organizationId),
        projectId: new Types.ObjectId(ctx.projectId),
      });
    }

    if (!record || record.deletedAt) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    const authorsById = await this.iamBridge
      .resolveUsersById([record.authorUserId.toHexString()])
      .catch(() => new Map<string, { id: string; fullName: string }>());

    return this.toDto(
      record,
      authorsById.get(record.authorUserId.toHexString())?.fullName ??
        ctx.actorName,
    );
  }

  async createProjectWorkNote(input: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    headerOrgId?: string;
    projectId: string;
    body: unknown;
  }): Promise<WorkNoteDto> {
    this.assertCsrfIfCookieAuthenticated(
      input.authorizationHeader,
      input.cookieHeader,
      input.csrfHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      input.authorizationHeader,
      input.cookieHeader,
      input.projectId,
      input.headerOrgId,
    );

    const parsed = this.parseCreateOrUpdateBody(input.body, true);
    const mentionUserIds = await this.resolveMentionsFromTextAndIds(
      ctx.organizationId,
      ctx.projectId,
      parsed.mentionUserIds ?? [],
      `${parsed.summary ?? ''}\n${parsed.content ?? ''}`,
    );

    const now = new Date();
    const noteId = new Types.ObjectId();
    const record: StoredWorkNoteRecord = {
      _id: noteId,
      organizationId: new Types.ObjectId(ctx.organizationId),
      projectId: new Types.ObjectId(ctx.projectId),
      authorUserId: new Types.ObjectId(ctx.actorId),
      title: parsed.title!,
      whatDone: parsed.content!,
      howSolved: parsed.summary || parsed.content!.slice(0, 200),
      whyThisWay: parsed.category || 'Decision',
      status: 'CONFIRMED',
      tags: parsed.tags ?? [],
      category: parsed.category ?? 'Decision',
      taskKey: parsed.taskKey ?? null,
      blocker: parsed.blocker ?? null,
      unfinished: parsed.unfinished ?? null,
      nextStep: parsed.nextStep ?? null,
      pinned: parsed.pinned ?? false,
      mentionUserIds,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const col = this.notesCollection();
    if (!col) {
      this.memoryNotes.set(noteId.toHexString(), record);
    } else {
      await col.insertOne(record);
    }

    // Rule 3: Emit WORK_NOTE_MENTION only after persistence succeeds
    if (mentionUserIds.length > 0) {
      await this.notificationService.notifyWorkNoteMention({
        actorId: ctx.actorId,
        mentionedUserIds: mentionUserIds,
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        noteId: noteId.toHexString(),
        noteTitle: record.title,
        eventId: 'create',
      });
    }

    return this.toDto(record, ctx.actorName);
  }

  async updateProjectWorkNote(input: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    headerOrgId?: string;
    projectId: string;
    noteId: string;
    body: unknown;
  }): Promise<WorkNoteDto> {
    this.assertCsrfIfCookieAuthenticated(
      input.authorizationHeader,
      input.cookieHeader,
      input.csrfHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      input.authorizationHeader,
      input.cookieHeader,
      input.projectId,
      input.headerOrgId,
    );

    if (!OBJECT_ID_REGEX.test(input.noteId)) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    const col = this.notesCollection();
    const existing = !col
      ? (() => {
          const mem = this.memoryNotes.get(input.noteId.toLowerCase()) ?? null;
          if (
            mem &&
            mem.projectId.toHexString() === ctx.projectId &&
            mem.organizationId.toHexString() === ctx.organizationId
          ) {
            return mem;
          }
          return null;
        })()
      : await col.findOne({
          _id: new Types.ObjectId(input.noteId),
          organizationId: new Types.ObjectId(ctx.organizationId),
          projectId: new Types.ObjectId(ctx.projectId),
        });

    if (!existing || existing.deletedAt) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    const parsed = this.parseCreateOrUpdateBody(input.body, false);
    const nextTitle = parsed.title ?? existing.title;
    const nextContent = parsed.content ?? existing.whatDone;
    const nextSummary = parsed.summary ?? existing.howSolved;
    const nextCategory =
      parsed.category ?? existing.category ?? existing.whyThisWay ?? 'Decision';
    const nextTaskKey =
      parsed.taskKey !== undefined ? parsed.taskKey : (existing.taskKey ?? null);
    const nextBlocker =
      parsed.blocker !== undefined ? parsed.blocker : (existing.blocker ?? null);
    const nextUnfinished =
      parsed.unfinished !== undefined
        ? parsed.unfinished
        : (existing.unfinished ?? null);
    const nextNextStep =
      parsed.nextStep !== undefined
        ? parsed.nextStep
        : (existing.nextStep ?? null);
    const nextTags = parsed.tags ?? existing.tags;
    const nextPinned =
      parsed.pinned !== undefined ? parsed.pinned : Boolean(existing.pinned);

    const mentionUserIds = await this.resolveMentionsFromTextAndIds(
      ctx.organizationId,
      ctx.projectId,
      parsed.mentionUserIds ?? existing.mentionUserIds ?? [],
      `${nextSummary}\n${nextContent}`,
    );

    const previousMentions = new Set(existing.mentionUserIds ?? []);
    const newlyMentioned = mentionUserIds.filter(
      (id) => !previousMentions.has(id),
    );

    const now = new Date();
    const updatedRecord: StoredWorkNoteRecord = {
      ...existing,
      title: nextTitle,
      whatDone: nextContent,
      howSolved: nextSummary,
      whyThisWay: nextCategory,
      category: nextCategory,
      taskKey: nextTaskKey,
      blocker: nextBlocker,
      unfinished: nextUnfinished,
      nextStep: nextNextStep,
      tags: nextTags,
      pinned: nextPinned,
      mentionUserIds,
      updatedAt: now,
    };

    if (!col) {
      this.memoryNotes.set(existing._id.toHexString(), updatedRecord);
    } else {
      await col.updateOne(
        { _id: existing._id },
        {
          $set: {
            title: nextTitle,
            whatDone: nextContent,
            howSolved: nextSummary,
            whyThisWay: nextCategory,
            category: nextCategory,
            taskKey: nextTaskKey,
            blocker: nextBlocker,
            unfinished: nextUnfinished,
            nextStep: nextNextStep,
            tags: nextTags,
            pinned: nextPinned,
            mentionUserIds,
            updatedAt: now,
          },
        },
      );
    }

    if (newlyMentioned.length > 0) {
      await this.notificationService.notifyWorkNoteMention({
        actorId: ctx.actorId,
        mentionedUserIds: newlyMentioned,
        organizationId: ctx.organizationId,
        projectId: ctx.projectId,
        noteId: existing._id.toHexString(),
        noteTitle: nextTitle,
        eventId: `update:${now.getTime()}`,
      });
    }

    const authorsById = await this.iamBridge
      .resolveUsersById([updatedRecord.authorUserId.toHexString()])
      .catch(() => new Map<string, { id: string; fullName: string }>());

    return this.toDto(
      updatedRecord,
      authorsById.get(updatedRecord.authorUserId.toHexString())?.fullName ??
        ctx.actorName,
    );
  }

  async deleteProjectWorkNote(input: {
    authorizationHeader?: string;
    cookieHeader?: string;
    csrfHeader?: string;
    headerOrgId?: string;
    projectId: string;
    noteId: string;
  }): Promise<{ deleted: true; id: string }> {
    this.assertCsrfIfCookieAuthenticated(
      input.authorizationHeader,
      input.cookieHeader,
      input.csrfHeader,
    );
    const ctx = await this.iamBridge.resolveProjectContext(
      input.authorizationHeader,
      input.cookieHeader,
      input.projectId,
      input.headerOrgId,
    );

    if (!OBJECT_ID_REGEX.test(input.noteId)) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    const now = new Date();
    const col = this.notesCollection();
    if (!col) {
      const existing = this.memoryNotes.get(input.noteId.toLowerCase());
      if (
        !existing ||
        existing.deletedAt ||
        existing.projectId.toHexString() !== ctx.projectId ||
        existing.organizationId.toHexString() !== ctx.organizationId
      ) {
        throw new NotFoundException({
          code: 'WORK_NOTE_NOT_FOUND',
          message: 'Content is no longer available.',
        });
      }
      existing.deletedAt = now;
      existing.updatedAt = now;
      return { deleted: true, id: existing._id.toHexString() };
    }

    const result = await col.findOneAndUpdate(
      {
        _id: new Types.ObjectId(input.noteId),
        organizationId: new Types.ObjectId(ctx.organizationId),
        projectId: new Types.ObjectId(ctx.projectId),
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      },
      { $set: { deletedAt: now, updatedAt: now } },
    );

    if (!result) {
      throw new NotFoundException({
        code: 'WORK_NOTE_NOT_FOUND',
        message: 'Content is no longer available.',
      });
    }

    return { deleted: true, id: input.noteId };
  }

  private parseCreateOrUpdateBody(
    body: unknown,
    requireTitleAndContent: boolean,
  ): {
    title?: string;
    summary?: string;
    content?: string;
    category?: string;
    taskKey?: string | null;
    blocker?: string | null;
    unfinished?: string | null;
    nextStep?: string | null;
    tags?: string[];
    pinned?: boolean;
    mentionUserIds?: string[];
  } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request body must be a JSON object.',
      });
    }
    const raw = body as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title.trim() : undefined;
    const content =
      typeof raw.content === 'string'
        ? raw.content.trim()
        : typeof raw.body === 'string'
          ? raw.body.trim()
          : typeof raw.whatDone === 'string'
            ? raw.whatDone.trim()
            : undefined;
    const summary =
      typeof raw.summary === 'string'
        ? raw.summary.trim()
        : typeof raw.howSolved === 'string'
          ? raw.howSolved.trim()
          : undefined;
    const category =
      typeof raw.category === 'string'
        ? raw.category.trim()
        : typeof raw.kind === 'string'
          ? raw.kind.trim()
          : undefined;
    const taskKey =
      raw.taskKey === null
        ? null
        : typeof raw.taskKey === 'string'
          ? raw.taskKey.trim() || null
          : undefined;
    const blocker =
      raw.blocker === null
        ? null
        : typeof raw.blocker === 'string'
          ? raw.blocker.trim() || null
          : undefined;
    const unfinished =
      raw.unfinished === null
        ? null
        : typeof raw.unfinished === 'string'
          ? raw.unfinished.trim() || null
          : undefined;
    const nextStep =
      raw.nextStep === null
        ? null
        : typeof raw.nextStep === 'string'
          ? raw.nextStep.trim() || null
          : undefined;
    const pinned = typeof raw.pinned === 'boolean' ? raw.pinned : undefined;

    if (requireTitleAndContent && (!title || !content)) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'title and content are required.',
      });
    }

    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    const rawMentions = Array.isArray(raw.mentionUserIds)
      ? raw.mentionUserIds
      : Array.isArray(raw.mentionedUserIds)
        ? raw.mentionedUserIds
        : undefined;
    const mentionUserIds = rawMentions
      ? rawMentions
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean)
      : undefined;

    return {
      title,
      summary,
      content,
      category,
      taskKey,
      blocker,
      unfinished,
      nextStep,
      tags,
      pinned,
      mentionUserIds,
    };
  }

  private toDto(record: StoredWorkNoteRecord, authorName: string): WorkNoteDto {
    return {
      id: record._id.toHexString(),
      organizationId: record.organizationId.toHexString(),
      projectId: record.projectId.toHexString(),
      authorId: record.authorUserId.toHexString(),
      authorName,
      title: record.title,
      category: record.category ?? record.whyThisWay ?? 'Decision',
      summary: record.howSolved || record.whatDone.slice(0, 180),
      content: record.whatDone,
      taskKey: record.taskKey ?? null,
      blocker: record.blocker ?? null,
      unfinished: record.unfinished ?? null,
      nextStep: record.nextStep ?? null,
      tags: Array.isArray(record.tags) ? record.tags : [],
      pinned: Boolean(record.pinned),
      mentionUserIds: Array.isArray(record.mentionUserIds)
        ? record.mentionUserIds
        : [],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
