import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { SERVICE_DATABASES } from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../../../iam/infrastructure/persistence';
import { CHAT_PERSISTENCE } from '../../../chat/infrastructure/persistence';
import { NOTIFICATION_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import {
  TASK_WORKSPACE_REPOSITORY,
  TaskWorkspaceRepository,
} from '../../../task/workspace/task-workspace.repository';
import type {
  NotificationItemDto,
  NotificationListQuery,
  NotificationListResponseDto,
  NotificationMvpType,
  NotificationResolveResponseDto,
  NotificationTarget,
} from '../../notification-center.types';

export interface NotificationDocumentRecord {
  _id: Types.ObjectId;
  recipientId: string;
  recipientUserId?: string | null;
  actorId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  conversationId?: string | null;
  type: NotificationMvpType;
  title: string;
  message: string;
  body?: string;
  actionUrl?: string;
  target?: NotificationTarget | null;
  eventKey: string;
  isRead: boolean;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertNotificationRecordInput {
  recipientId: string;
  actorId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  conversationId?: string | null;
  type: NotificationMvpType;
  title: string;
  message: string;
  target: NotificationTarget;
  eventKey: string;
}

@Injectable()
export class NotificationCenterRepository {
  private readonly memoryStore = new Map<string, NotificationDocumentRecord>();
  private readonly memoryEventIndex = new Map<string, string>();

  constructor(
    @Optional()
    @InjectConnection(NOTIFICATION_PERSISTENCE.databaseName)
    private readonly notificationConnection?: Connection,
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly iamConnection?: Connection,
    @Optional()
    @InjectConnection(CHAT_PERSISTENCE.databaseName)
    private readonly chatConnection?: Connection,
    @Optional()
    @Inject(TASK_WORKSPACE_REPOSITORY)
    private readonly taskWorkspaceRepository?: TaskWorkspaceRepository,
  ) {}

  private activeConnection(): Connection | null {
    const candidates = [
      this.notificationConnection,
      this.iamConnection,
      this.chatConnection,
    ];
    for (const conn of candidates) {
      if (conn && typeof conn.useDb === 'function') {
        return conn;
      }
    }
    return null;
  }

  private cachedAccessLookup<T>(
    cache: Map<string, Promise<unknown>> | undefined,
    key: string,
    lookup: () => Promise<T>,
  ): Promise<T> {
    if (!cache) return lookup();
    const existing = cache.get(key);
    if (existing) return existing as Promise<T>;
    const pending = lookup();
    cache.set(key, pending);
    return pending;
  }

  private notificationsModel(): Model<NotificationDocumentRecord> | null {
    const baseConnection = this.activeConnection();
    if (!baseConnection) return null;
    const db = baseConnection.useDb(SERVICE_DATABASES.notification, {
      useCache: true,
    });
    const existing = db.models['notifications'] as
      Model<NotificationDocumentRecord> | undefined;
    if (existing) return existing;
    if (typeof db.model !== 'function') return null;
    const definition = NOTIFICATION_PERSISTENCE.collections.find(
      (col) => col.name === 'notifications',
    )!;
    const schema = createCollectionSchema(definition);
    return db.model<NotificationDocumentRecord>('notifications', schema);
  }

  private dbCollection(databaseName: string, collectionName: string) {
    const baseConnection = this.activeConnection();
    if (!baseConnection) return null;
    const db = baseConnection.useDb(databaseName, { useCache: true }).db;
    if (!db) return null;
    return db.collection(collectionName);
  }

  private unknownIdToString(value: unknown): string {
    if (value instanceof Types.ObjectId) return value.toHexString();
    if (typeof value === 'string') return value;
    return '';
  }

  private assertMemoryStoreAllowed(): void {
    // BE-REL-007: Never silently fall back to process-local memoryStore outside test runs.
    if (process.env.NODE_ENV !== 'test') {
      throw new ServiceUnavailableException({
        code: 'NOTIFICATION_DATABASE_UNAVAILABLE',
        message: 'Notification database is unavailable.',
      });
    }
  }

  private isRoleAssignmentActive(
    assignment: Record<string, unknown> | null | undefined,
    now: Date,
  ): boolean {
    if (!assignment) return false;
    if (
      assignment.status !== undefined &&
      assignment.status !== null &&
      assignment.status !== 'ACTIVE'
    ) {
      return false;
    }
    if (assignment.revokedAt !== undefined && assignment.revokedAt !== null) {
      return false;
    }
    if (assignment.validFrom instanceof Date && assignment.validFrom > now) {
      return false;
    }
    if (assignment.validUntil instanceof Date && assignment.validUntil <= now) {
      return false;
    }
    return true;
  }

  private redactDeniedItem(
    item: NotificationItemDto,
    resolution: NotificationResolveResponseDto | null | undefined,
  ): NotificationItemDto {
    // SEC-AUTH-011: Strip title, actorId, and all target/resource IDs when access is revoked or deleted.
    return {
      ...item,
      actorId: null,
      projectId: null,
      taskId: null,
      noteId: null,
      conversationId: null,
      title: 'Notification unavailable',
      message:
        resolution === null || resolution === undefined
          ? 'Content is temporarily unavailable.'
          : resolution.reason === 'DELETED'
            ? 'Content is no longer available.'
            : 'This content is no longer available',
      target: item.target
        ? {
            kind: item.target.kind,
            url: '/notifications',
            organizationId: null,
            projectId: null,
            taskId: null,
            noteId: null,
            conversationId: null,
            messageId: null,
          }
        : null,
    };
  }

  async upsertNotification(
    input: UpsertNotificationRecordInput,
  ): Promise<{ item: NotificationItemDto; created: boolean }> {
    const model = this.notificationsModel();
    const now = new Date();
    const resolvedOrganizationId =
      this.normalizeOrganizationId(
        input.organizationId ?? input.target?.organizationId,
      ) ?? null;
    if (!model) {
      this.assertMemoryStoreAllowed();
      const dedupKey = `${input.recipientId}::${input.eventKey}`;
      const existingId = this.memoryEventIndex.get(dedupKey);
      if (existingId) {
        const existingDoc = this.memoryStore.get(existingId)!;
        return { item: this.toDto(existingDoc), created: false };
      }
      const id = new Types.ObjectId();
      const record: NotificationDocumentRecord = {
        _id: id,
        recipientId: input.recipientId,
        recipientUserId: input.recipientId,
        actorId: input.actorId ?? null,
        organizationId: resolvedOrganizationId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        noteId: input.noteId ?? null,
        conversationId: input.conversationId ?? null,
        type: input.type,
        title: input.title,
        message: input.message,
        body: input.message,
        actionUrl: input.target.url,
        target: input.target,
        eventKey: input.eventKey,
        isRead: false,
        readAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.memoryStore.set(id.toHexString(), record);
      this.memoryEventIndex.set(dedupKey, id.toHexString());
      return { item: this.toDto(record), created: true };
    }

    try {
      const existing = await model
        .findOne({
          recipientId: input.recipientId,
          eventKey: input.eventKey,
        })
        .lean()
        .exec();
      if (existing) {
        return { item: this.toDto(existing), created: false };
      }
      const createdDoc = await model.create({
        recipientId: input.recipientId,
        recipientUserId: input.recipientId,
        actorId: input.actorId ?? null,
        organizationId: resolvedOrganizationId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        noteId: input.noteId ?? null,
        conversationId: input.conversationId ?? null,
        type: input.type,
        title: input.title,
        message: input.message,
        body: input.message,
        actionUrl: input.target.url,
        target: input.target,
        eventKey: input.eventKey,
        isRead: false,
        readAt: null,
      });
      return {
        item: this.toDto(createdDoc.toObject()),
        created: true,
      };
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: number }).code === 11000
      ) {
        const raced = await model
          .findOne({
            recipientId: input.recipientId,
            eventKey: input.eventKey,
          })
          .lean()
          .exec();
        if (raced) {
          return { item: this.toDto(raced), created: false };
        }
      }
      throw error;
    }
  }

  private normalizeOrganizationId(
    organizationId?: string | null,
  ): string | null {
    const trimmed =
      typeof organizationId === 'string' ? organizationId.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  }

  private matchesOrganization(
    doc: NotificationDocumentRecord,
    organizationId?: string | null,
  ): boolean {
    const normalizedOrgId = this.normalizeOrganizationId(organizationId);
    const docOrgId = this.normalizeOrganizationId(doc.organizationId);
    const targetOrgId = this.normalizeOrganizationId(
      doc.target?.organizationId,
    );
    if (docOrgId && targetOrgId && docOrgId !== targetOrgId) return false;
    if (!normalizedOrgId) return true;
    return (docOrgId ?? targetOrgId) === normalizedOrgId;
  }

  private organizationConsistencyFilter(): Record<string, unknown> {
    const asString = (path: string) => ({
      $convert: {
        input: path,
        to: 'string',
        onError: '__invalid_organization_id__',
        onNull: null,
      },
    });
    return {
      $expr: {
        $or: [
          { $eq: [{ $ifNull: ['$organizationId', null] }, null] },
          { $eq: [{ $ifNull: ['$target.organizationId', null] }, null] },
          {
            $eq: [
              asString('$organizationId'),
              asString('$target.organizationId'),
            ],
          },
        ],
      },
    };
  }

  private organizationMatchFilter(
    organizationId?: string | null,
  ): Record<string, unknown> | null {
    const normalizedOrgId = this.normalizeOrganizationId(organizationId);
    if (!normalizedOrgId) return this.organizationConsistencyFilter();
    return {
      $or: [
        {
          $and: [
            { organizationId: normalizedOrgId },
            {
              $or: [
                { 'target.organizationId': { $exists: false } },
                { 'target.organizationId': null },
                { 'target.organizationId': normalizedOrgId },
              ],
            },
          ],
        },
        { organizationId: null, 'target.organizationId': normalizedOrgId },
      ],
    };
  }

  private filterByNotificationTypes(
    filter: Record<string, unknown>,
    allowedTypes?: readonly NotificationMvpType[],
  ): Record<string, unknown> {
    return allowedTypes
      ? { $and: [filter, { type: { $in: [...allowedTypes] } }] }
      : filter;
  }

  private recipientMatchFilter(
    recipientId: string,
    organizationId?: string | null,
  ): Record<string, unknown> {
    const recipientCondition = {
      $or: [{ recipientId }, { recipientUserId: recipientId }],
    };
    const orgCondition = this.organizationMatchFilter(organizationId);
    if (!orgCondition) {
      return recipientCondition;
    }
    return {
      $and: [recipientCondition, orgCondition],
    };
  }

  private unreadMatchFilter(
    recipientId: string,
    organizationId?: string | null,
  ): Record<string, unknown> {
    const clauses: Record<string, unknown>[] = [
      { $or: [{ recipientId }, { recipientUserId: recipientId }] },
      {
        $or: [
          { readAt: null, isRead: { $ne: true } },
          { readAt: { $exists: false }, isRead: { $ne: true } },
        ],
      },
    ];
    const orgCondition = this.organizationMatchFilter(organizationId);
    if (orgCondition) {
      clauses.push(orgCondition);
    }
    return { $and: clauses };
  }

  private async prefetchAccessLookupsForBatch(
    recipientId: string,
    items: readonly NotificationItemDto[],
    accessLookupCache: Map<string, Promise<unknown>>,
    activeOrganizationId?: string | null,
  ): Promise<void> {
    // BE-PERF-008: Bulk-prefetch cross-DB ACL records via $in so GET /notifications
    // executes O(1) DB queries per page instead of O(N) per-item queries.
    const baseConnection = this.activeConnection();
    if (!baseConnection || typeof baseConnection.useDb !== 'function') {
      return;
    }
    if (!Types.ObjectId.isValid(recipientId)) {
      return;
    }
    const actorObjId = new Types.ObjectId(recipientId);
    const normalizedActorId = recipientId.toLowerCase();
    const scopedOrgId = this.normalizeOrganizationId(activeOrganizationId);

    const orgIds = new Set<string>();
    const projectIds = new Set<string>();
    const projectOrgPairs = new Map<string, string | null>();
    const workNoteIds = new Set<string>();
    const workNoteProjectIds = new Set<string>();
    const workNoteItems: Array<{
      noteId: string;
      projectId: string;
      orgId: string | null;
    }> = [];
    const conversationIds = new Set<string>();
    const messageIds = new Set<string>();
    const messageItems: Array<{ messageId: string; conversationId: string }> =
      [];

    for (const item of items) {
      const target = item.target;
      if (!target) continue;
      const orgId = this.normalizeOrganizationId(
        target.organizationId ?? item.organizationId ?? scopedOrgId,
      );
      if (orgId && Types.ObjectId.isValid(orgId)) {
        orgIds.add(orgId);
      }
      if (
        target.kind === 'PROJECT' ||
        target.kind === 'TASK' ||
        target.kind === 'WORK_NOTE'
      ) {
        const pid = target.projectId ?? item.projectId;
        if (pid && Types.ObjectId.isValid(pid)) {
          projectIds.add(pid);
          projectOrgPairs.set(`${orgId ?? ''}:${pid}`, orgId);
        }
        if (target.kind === 'WORK_NOTE') {
          const nid = target.noteId ?? item.noteId;
          if (
            nid &&
            Types.ObjectId.isValid(nid) &&
            pid &&
            Types.ObjectId.isValid(pid)
          ) {
            workNoteIds.add(nid);
            workNoteProjectIds.add(pid);
            workNoteItems.push({ noteId: nid, projectId: pid, orgId });
          }
        }
      } else if (target.kind === 'CHAT') {
        const cid = target.conversationId ?? item.conversationId;
        if (cid && Types.ObjectId.isValid(cid)) {
          conversationIds.add(cid);
          if (target.messageId && Types.ObjectId.isValid(target.messageId)) {
            messageIds.add(target.messageId);
            messageItems.push({
              messageId: target.messageId,
              conversationId: cid,
            });
          }
        }
      }
    }

    const canFind = (
      coll: ReturnType<NotificationCenterRepository['dbCollection']>,
    ): coll is NonNullable<
      ReturnType<NotificationCenterRepository['dbCollection']>
    > => Boolean(coll && typeof coll.find === 'function');

    const orgsColl = this.dbCollection(SERVICE_DATABASES.iam, 'organizations');
    const projectsColl = this.dbCollection(SERVICE_DATABASES.iam, 'projects');
    const convsColl = this.dbCollection(
      SERVICE_DATABASES.chat,
      'chat_conversations',
    );
    const workNotesColl = this.dbCollection(
      SERVICE_DATABASES.capture,
      'work_notes',
    );
    const chatMembersColl = this.dbCollection(
      SERVICE_DATABASES.chat,
      'chat_members',
    );
    const chatMessagesColl = this.dbCollection(
      SERVICE_DATABASES.chat,
      'chat_conversation_messages',
    );

    // Phase 1: Batch-fetch primary entities (organizations, projects, conversations, work notes, chat members/messages)
    const [orgRows, projectRows, convRows, noteRows, chatMemberRows, msgRows] =
      await Promise.all([
        orgIds.size > 0 && canFind(orgsColl)
          ? orgsColl
              .find({
                _id: { $in: [...orgIds].map((id) => new Types.ObjectId(id)) },
              })
              .toArray()
          : Promise.resolve(null),
        projectIds.size > 0 && canFind(projectsColl)
          ? projectsColl
              .find({
                _id: {
                  $in: [...projectIds].map((id) => new Types.ObjectId(id)),
                },
              })
              .toArray()
          : Promise.resolve(null),
        conversationIds.size > 0 && canFind(convsColl)
          ? convsColl
              .find({
                _id: {
                  $in: [...conversationIds].map((id) => new Types.ObjectId(id)),
                },
              })
              .toArray()
          : Promise.resolve(null),
        workNoteIds.size > 0 && canFind(workNotesColl)
          ? workNotesColl
              .find({
                _id: {
                  $in: [...workNoteIds].map((id) => new Types.ObjectId(id)),
                },
                projectId: {
                  $in: [...workNoteProjectIds].map(
                    (id) => new Types.ObjectId(id),
                  ),
                },
                type: 'TASK_NOTE',
                status: 'CONFIRMED',
                taskId: { $type: 'objectId' },
              })
              .toArray()
          : Promise.resolve(null),
        conversationIds.size > 0 && canFind(chatMembersColl)
          ? chatMembersColl
              .find({
                conversationId: {
                  $in: [...conversationIds].map((id) => new Types.ObjectId(id)),
                },
                userId: { $in: [recipientId, normalizedActorId, actorObjId] },
                $or: [
                  { status: 'ACTIVE' },
                  { status: { $exists: false } },
                  { status: null },
                ],
              })
              .toArray()
          : Promise.resolve(null),
        messageIds.size > 0 && canFind(chatMessagesColl)
          ? chatMessagesColl
              .find({
                _id: {
                  $in: [...messageIds].map((id) => new Types.ObjectId(id)),
                },
                conversationId: {
                  $in: [...conversationIds].map((id) => new Types.ObjectId(id)),
                },
              })
              .toArray()
          : Promise.resolve(null),
      ]);

    if (orgRows) {
      const orgById = new Map(orgRows.map((row) => [String(row._id), row]));
      for (const id of orgIds) {
        accessLookupCache.set(
          `organization:${id}`,
          Promise.resolve(orgById.get(id) ?? null),
        );
      }
    }

    const effectiveOrgIds = new Set<string>(orgIds);
    const projectById = new Map<string, Record<string, unknown>>();
    if (projectRows) {
      for (const row of projectRows) {
        const pid = String(row._id);
        projectById.set(pid, row);
        if (
          row.organizationId &&
          Types.ObjectId.isValid(String(row.organizationId))
        ) {
          effectiveOrgIds.add(String(row.organizationId));
        }
      }
      for (const [pairKey, expectedOrg] of projectOrgPairs.entries()) {
        const pid = pairKey.slice(pairKey.indexOf(':') + 1);
        const found = projectById.get(pid) ?? null;
        const matched =
          found &&
          (!expectedOrg || String(found.organizationId) === expectedOrg)
            ? found
            : null;
        accessLookupCache.set(`project:${pairKey}`, Promise.resolve(matched));
      }
    }

    if (convRows) {
      const convById = new Map(convRows.map((row) => [String(row._id), row]));
      for (const cid of conversationIds) {
        const conv = convById.get(cid) ?? null;
        if (
          conv?.organizationId &&
          Types.ObjectId.isValid(String(conv.organizationId))
        ) {
          effectiveOrgIds.add(String(conv.organizationId));
        }
        accessLookupCache.set(`conversation:${cid}`, Promise.resolve(conv));
      }
    }

    if (noteRows) {
      const noteByKey = new Map(
        noteRows.map((row) => [
          `${String(row.organizationId ?? '')}:${String(row.projectId)}:${String(row._id)}`,
          row,
        ]),
      );
      for (const { noteId, projectId, orgId } of workNoteItems) {
        const proj = projectById.get(projectId);
        const resolvedOrg =
          this.unknownIdToString(proj?.organizationId) || (orgId ?? '');
        const found =
          noteByKey.get(`${resolvedOrg}:${projectId}:${noteId}`) ?? null;
        accessLookupCache.set(
          `work-note:${resolvedOrg}:${projectId}:${noteId}`,
          Promise.resolve(found),
        );
      }
    }

    if (chatMemberRows) {
      const memberByConv = new Map(
        chatMemberRows.map((row) => [String(row.conversationId), row]),
      );
      for (const cid of conversationIds) {
        accessLookupCache.set(
          `chat-member:${cid}:${recipientId}`,
          Promise.resolve(memberByConv.get(cid) ?? null),
        );
      }
    }

    if (msgRows) {
      const msgByKey = new Map(
        msgRows.map((row) => [
          `${String(row.conversationId)}:${String(row._id)}`,
          row,
        ]),
      );
      for (const { conversationId, messageId } of messageItems) {
        accessLookupCache.set(
          `chat-message:${conversationId}:${messageId}`,
          Promise.resolve(
            msgByKey.get(`${conversationId}:${messageId}`) ?? null,
          ),
        );
      }
    }

    // Phase 2: Batch-fetch memberships & admin role assignments across all referenced orgs/projects
    const orgMembershipsColl = this.dbCollection(
      SERVICE_DATABASES.iam,
      'organization_memberships',
    );
    const projectMembershipsColl = this.dbCollection(
      SERVICE_DATABASES.iam,
      'project_memberships',
    );
    const roleAssignmentsColl = this.dbCollection(
      SERVICE_DATABASES.iam,
      'role_assignments',
    );

    const orgObjIds = [...effectiveOrgIds].map((id) => new Types.ObjectId(id));
    const now = new Date();
    const [orgMemberRows, projMemberRows, adminRoleRows] = await Promise.all([
      orgObjIds.length > 0 && canFind(orgMembershipsColl)
        ? orgMembershipsColl
            .find({
              organizationId: { $in: orgObjIds },
              userId: actorObjId,
              status: 'ACTIVE',
            })
            .toArray()
        : Promise.resolve(null),
      projectIds.size > 0 &&
      orgObjIds.length > 0 &&
      canFind(projectMembershipsColl)
        ? projectMembershipsColl
            .find({
              organizationId: { $in: orgObjIds },
              projectId: {
                $in: [...projectIds].map((id) => new Types.ObjectId(id)),
              },
              userId: actorObjId,
              status: 'ACTIVE',
            })
            .toArray()
        : Promise.resolve(null),
      workNoteIds.size > 0 &&
      orgObjIds.length > 0 &&
      canFind(roleAssignmentsColl)
        ? roleAssignmentsColl
            .find({
              organizationId: { $in: orgObjIds },
              userId: actorObjId,
              roleCode: 'ADMIN',
              $and: [
                {
                  $or: [{ projectId: { $exists: false } }, { projectId: null }],
                },
                {
                  $or: [
                    { status: 'ACTIVE' },
                    { status: { $exists: false } },
                    { status: null },
                  ],
                },
                {
                  $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }],
                },
                {
                  $or: [
                    { validFrom: null },
                    { validFrom: { $exists: false } },
                    { validFrom: { $lte: now } },
                  ],
                },
                {
                  $or: [
                    { validUntil: null },
                    { validUntil: { $exists: false } },
                    { validUntil: { $gt: now } },
                  ],
                },
              ],
            })
            .toArray()
        : Promise.resolve(null),
    ]);

    if (orgMemberRows) {
      const byOrg = new Map(
        orgMemberRows.map((row) => [String(row.organizationId), row]),
      );
      for (const oid of effectiveOrgIds) {
        accessLookupCache.set(
          `organization-membership:${oid}:${recipientId}`,
          Promise.resolve(byOrg.get(oid) ?? null),
        );
      }
    }

    if (projMemberRows) {
      const byOrgProj = new Map(
        projMemberRows.map((row) => [
          `${String(row.organizationId)}:${String(row.projectId)}`,
          row,
        ]),
      );
      for (const pid of projectIds) {
        const proj = projectById.get(pid);
        const oid = this.unknownIdToString(proj?.organizationId);
        if (!oid) continue;
        accessLookupCache.set(
          `project-membership:${oid}:${pid}:${recipientId}`,
          Promise.resolve(byOrgProj.get(`${oid}:${pid}`) ?? null),
        );
      }
    }

    if (adminRoleRows) {
      const byOrg = new Map<string, Record<string, unknown>>();
      for (const row of adminRoleRows) {
        if (this.isRoleAssignmentActive(row, now)) {
          byOrg.set(String(row.organizationId), row);
        }
      }
      for (const oid of effectiveOrgIds) {
        accessLookupCache.set(
          `admin-role:${oid}:${recipientId}`,
          Promise.resolve(byOrg.get(oid) ?? null),
        );
      }
    }
  }

  async sanitizeItemsForListing(
    recipientId: string,
    items: NotificationItemDto[],
    activeOrganizationId?: string | null,
  ): Promise<NotificationItemDto[]> {
    if (items.length === 0) {
      return items;
    }
    if (!this.activeConnection()) {
      if (process.env.NODE_ENV === 'test') {
        return items;
      }
      const denied: NotificationResolveResponseDto = {
        available: false,
        reason: 'FORBIDDEN',
        message: 'This content is no longer available',
        target: null,
      };
      return items.map((item) => this.redactDeniedItem(item, denied));
    }

    const targetKey = (item: NotificationItemDto) =>
      JSON.stringify([
        item.type,
        item.organizationId,
        item.projectId,
        item.taskId,
        item.noteId,
        item.conversationId,
        item.target,
      ]);
    const uniqueTargets = new Map<
      string,
      { item: NotificationItemDto; key: string }
    >();
    for (const item of items) {
      const key = targetKey(item);
      if (!uniqueTargets.has(key)) uniqueTargets.set(key, { item, key });
    }

    const resolutions = new Map<
      string,
      NotificationResolveResponseDto | null
    >();
    const accessLookupCache = new Map<string, Promise<unknown>>();
    const targets = [...uniqueTargets.values()];
    await this.prefetchAccessLookupsForBatch(
      recipientId,
      targets.map((entry) => entry.item),
      accessLookupCache,
      activeOrganizationId,
    );
    const maxConcurrentAclChecks = 12;
    for (
      let offset = 0;
      offset < targets.length;
      offset += maxConcurrentAclChecks
    ) {
      const batch = targets.slice(offset, offset + maxConcurrentAclChecks);
      const batchResults = await Promise.all(
        batch.map(async ({ item, key }) => {
          try {
            return [
              key,
              await this.resolveTargetAccess(
                recipientId,
                item,
                accessLookupCache,
                activeOrganizationId,
              ),
            ] as const;
          } catch {
            return [key, null] as const;
          }
        }),
      );
      for (const [key, result] of batchResults) resolutions.set(key, result);
    }

    return items.map((item) => {
      const resolution = resolutions.get(targetKey(item));
      if (resolution?.available) return item;
      return this.redactDeniedItem(item, resolution);
    });
  }

  async listByRecipient(
    recipientId: string,
    query: NotificationListQuery,
    organizationId?: string | null,
    allowedTypes?: readonly NotificationMvpType[],
  ): Promise<NotificationListResponseDto> {
    const scopedOrgId = this.normalizeOrganizationId(
      organizationId ?? query.organizationId,
    );
    const allowedProjectSet =
      query.allowedProjectIds != null && Array.isArray(query.allowedProjectIds)
        ? new Set(
            (query.allowedProjectIds as readonly string[]).map((id: string) =>
              id.trim().toLowerCase(),
            ),
          )
        : null;
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const parsedCursor = this.parseCursor(query.cursor);
    const model = this.notificationsModel();

    if (!model) {
      this.assertMemoryStoreAllowed();
      const allForRecipient = [...this.memoryStore.values()]
        .filter(
          (doc) =>
            (doc.recipientId === recipientId ||
              doc.recipientUserId === recipientId) &&
            this.matchesOrganization(doc, scopedOrgId) &&
            (!allowedTypes || allowedTypes.includes(doc.type)) &&
            (!allowedProjectSet ||
              (typeof doc.projectId === 'string' &&
                allowedProjectSet.has(doc.projectId.toLowerCase()))),
        )
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b._id.toHexString().localeCompare(a._id.toHexString()),
        );
      const unreadCount = allForRecipient.filter(
        (doc) => !doc.readAt && !doc.isRead,
      ).length;
      const filtered = allForRecipient.filter((doc) => {
        if (query.unreadOnly && (doc.readAt || doc.isRead)) return false;
        if (!parsedCursor) return true;
        const docTime = doc.createdAt.getTime();
        const cursorTime = parsedCursor.createdAt.getTime();
        return (
          docTime < cursorTime ||
          (docTime === cursorTime &&
            doc._id.toHexString() < parsedCursor.id.toHexString())
        );
      });
      const slice = filtered.slice(0, limit + 1);
      const hasMore = slice.length > limit;
      const pageItems = hasMore ? slice.slice(0, limit) : slice;
      const last = pageItems.at(-1);
      const sanitizedItems = await this.sanitizeItemsForListing(
        recipientId,
        pageItems.map((doc) => this.toDto(doc)),
        scopedOrgId,
      );
      return {
        items: sanitizedItems,
        nextCursor:
          hasMore && last ? this.encodeCursor(last.createdAt, last._id) : null,
        unreadCount,
      };
    }

    const baseFilter = query.unreadOnly
      ? this.unreadMatchFilter(recipientId, scopedOrgId)
      : this.recipientMatchFilter(recipientId, scopedOrgId);

    const typeFilteredBase = this.filterByNotificationTypes(
      baseFilter,
      allowedTypes,
    );
    const projectFilteredBase: Record<string, unknown> = allowedProjectSet
      ? {
          $and: [
            typeFilteredBase,
            { projectId: { $in: [...allowedProjectSet] } },
          ],
        }
      : typeFilteredBase;
    const filter: Record<string, unknown> = parsedCursor
      ? {
          $and: [
            projectFilteredBase,
            {
              $or: [
                { createdAt: { $lt: parsedCursor.createdAt } },
                {
                  createdAt: parsedCursor.createdAt,
                  _id: { $lt: parsedCursor.id },
                },
              ],
            },
          ],
        }
      : projectFilteredBase;

    const unreadCountFilter: Record<string, unknown> = allowedProjectSet
      ? {
          $and: [
            this.filterByNotificationTypes(
              this.unreadMatchFilter(recipientId, scopedOrgId),
              allowedTypes,
            ),
            { projectId: { $in: [...allowedProjectSet] } },
          ],
        }
      : this.filterByNotificationTypes(
          this.unreadMatchFilter(recipientId, scopedOrgId),
          allowedTypes,
        );

    const [rows, unreadCount] = await Promise.all([
      model
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean()
        .exec(),
      model.countDocuments(unreadCountFilter).exec(),
    ]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    const sanitizedItems = await this.sanitizeItemsForListing(
      recipientId,
      pageRows.map((row) => this.toDto(row)),
      scopedOrgId,
    );

    return {
      items: sanitizedItems,
      nextCursor:
        hasMore && last ? this.encodeCursor(last.createdAt, last._id) : null,
      unreadCount,
    };
  }

  async countUnread(
    recipientId: string,
    organizationId?: string | null,
    allowedProjectIds?: readonly string[] | null,
  ): Promise<number> {
    const scopedOrgId = this.normalizeOrganizationId(organizationId);
    const allowedProjectSet =
      allowedProjectIds != null && Array.isArray(allowedProjectIds)
        ? new Set(
            (allowedProjectIds as readonly string[]).map((id: string) =>
              id.trim().toLowerCase(),
            ),
          )
        : null;
    const model = this.notificationsModel();
    if (!model) {
      this.assertMemoryStoreAllowed();
      return [...this.memoryStore.values()].filter(
        (doc) =>
          (doc.recipientId === recipientId ||
            doc.recipientUserId === recipientId) &&
          this.matchesOrganization(doc, scopedOrgId) &&
          (!allowedProjectSet ||
            (typeof doc.projectId === 'string' &&
              allowedProjectSet.has(doc.projectId.toLowerCase()))) &&
          !doc.readAt &&
          !doc.isRead,
      ).length;
    }
    const baseFilter = this.unreadMatchFilter(recipientId, scopedOrgId);
    const filter = allowedProjectSet
      ? { $and: [baseFilter, { projectId: { $in: [...allowedProjectSet] } }] }
      : baseFilter;
    return model.countDocuments(filter).exec();
  }

  async markRead(
    recipientId: string,
    notificationId: string,
    organizationIdOrNow?: string | Date | null,
    maybeNow?: Date,
  ): Promise<NotificationItemDto | null> {
    const scopedOrgId =
      organizationIdOrNow instanceof Date
        ? null
        : this.normalizeOrganizationId(organizationIdOrNow);
    const now =
      organizationIdOrNow instanceof Date
        ? organizationIdOrNow
        : (maybeNow ?? new Date());
    if (!Types.ObjectId.isValid(notificationId)) {
      return null;
    }
    const model = this.notificationsModel();
    if (!model) {
      this.assertMemoryStoreAllowed();
      const doc = this.memoryStore.get(notificationId);
      if (
        !doc ||
        (doc.recipientId !== recipientId &&
          doc.recipientUserId !== recipientId) ||
        !this.matchesOrganization(doc, scopedOrgId)
      ) {
        return null;
      }
      if (!doc.readAt) {
        doc.recipientId = recipientId;
        doc.recipientUserId = recipientId;
        doc.readAt = now;
        doc.isRead = true;
        doc.updatedAt = now;
      }
      return this.toDto(doc);
    }

    const existing = await model
      .findOne({
        _id: new Types.ObjectId(notificationId),
        ...this.recipientMatchFilter(recipientId, scopedOrgId),
      })
      .lean()
      .exec();
    if (!existing) return null;
    if (existing.readAt || existing.isRead) {
      return this.toDto(existing);
    }

    const updated = await model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(notificationId),
          ...this.unreadMatchFilter(recipientId, scopedOrgId),
        },
        {
          $set: {
            recipientId,
            recipientUserId: recipientId,
            isRead: true,
            readAt: now,
          },
        },
        { new: true },
      )
      .lean()
      .exec();

    return this.toDto(updated ?? { ...existing, isRead: true, readAt: now });
  }

  async markAllRead(
    recipientId: string,
    organizationIdOrNow?: string | Date | null,
    maybeNow?: Date,
  ): Promise<{ updatedCount: number; readAt: string }> {
    const scopedOrgId =
      organizationIdOrNow instanceof Date
        ? null
        : this.normalizeOrganizationId(organizationIdOrNow);
    const now =
      organizationIdOrNow instanceof Date
        ? organizationIdOrNow
        : (maybeNow ?? new Date());
    const model = this.notificationsModel();
    if (!model) {
      this.assertMemoryStoreAllowed();
      let updatedCount = 0;
      for (const doc of this.memoryStore.values()) {
        if (
          (doc.recipientId === recipientId ||
            doc.recipientUserId === recipientId) &&
          this.matchesOrganization(doc, scopedOrgId) &&
          !doc.readAt &&
          !doc.isRead
        ) {
          doc.recipientId = recipientId;
          doc.recipientUserId = recipientId;
          doc.readAt = now;
          doc.isRead = true;
          doc.updatedAt = now;
          updatedCount += 1;
        }
      }
      return { updatedCount, readAt: now.toISOString() };
    }

    const result = await model
      .updateMany(this.unreadMatchFilter(recipientId, scopedOrgId), {
        $set: {
          recipientId,
          recipientUserId: recipientId,
          isRead: true,
          readAt: now,
        },
      })
      .exec();

    return {
      updatedCount: result.modifiedCount ?? 0,
      readAt: now.toISOString(),
    };
  }

  async findByIdForRecipient(
    recipientId: string,
    notificationId: string,
    organizationId?: string | null,
  ): Promise<NotificationItemDto | null> {
    const scopedOrgId = this.normalizeOrganizationId(organizationId);
    if (!Types.ObjectId.isValid(notificationId)) {
      return null;
    }
    const model = this.notificationsModel();
    if (!model) {
      this.assertMemoryStoreAllowed();
      const doc = this.memoryStore.get(notificationId);
      if (
        !doc ||
        (doc.recipientId !== recipientId &&
          doc.recipientUserId !== recipientId) ||
        !this.matchesOrganization(doc, scopedOrgId)
      ) {
        return null;
      }
      return this.toDto(doc);
    }
    const doc = await model
      .findOne({
        _id: new Types.ObjectId(notificationId),
        ...this.recipientMatchFilter(recipientId, scopedOrgId),
      })
      .lean()
      .exec();
    return doc ? this.toDto(doc) : null;
  }

  async findOrganizationName(organizationId: string): Promise<string> {
    try {
      if (!Types.ObjectId.isValid(organizationId)) return 'Organization';
      const orgs = this.dbCollection(SERVICE_DATABASES.iam, 'organizations');
      if (!orgs) return 'Organization';
      const doc = await orgs.findOne(
        { _id: new Types.ObjectId(organizationId) },
        { projection: { name: 1 } },
      );
      return typeof doc?.name === 'string' && doc.name.trim()
        ? doc.name.trim()
        : 'Organization';
    } catch {
      return 'Organization';
    }
  }

  async findActiveUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; fullName: string } | null> {
    try {
      const normalized = email.trim().toLowerCase();
      if (!normalized) return null;
      const users = this.dbCollection(SERVICE_DATABASES.iam, 'users');
      if (!users) return null;
      const doc = await users.findOne(
        { email: normalized, status: 'ACTIVE' },
        { projection: { _id: 1, email: 1, fullName: 1 } },
      );
      if (!doc?._id) return null;
      return {
        id: String(doc._id),
        email: typeof doc.email === 'string' ? doc.email : normalized,
        fullName: typeof doc.fullName === 'string' ? doc.fullName : normalized,
      };
    } catch {
      return null;
    }
  }

  async findInvitationContext(
    organizationId: string,
    invitationId: string,
  ): Promise<{ email: string; recipientUserId: string | null } | null> {
    try {
      if (
        !Types.ObjectId.isValid(organizationId) ||
        !Types.ObjectId.isValid(invitationId)
      ) {
        return null;
      }
      const invitations = this.dbCollection(
        SERVICE_DATABASES.iam,
        'organization_invitations',
      );
      if (!invitations) return null;
      const inv = await invitations.findOne(
        {
          _id: new Types.ObjectId(invitationId),
          organizationId: new Types.ObjectId(organizationId),
        },
        { projection: { email: 1, targetUserId: 1 } },
      );
      if (!inv) return null;
      const email = typeof inv.email === 'string' ? inv.email : '';
      if (inv.targetUserId) {
        return { email, recipientUserId: String(inv.targetUserId) };
      }
      const user = email ? await this.findActiveUserByEmail(email) : null;
      return { email, recipientUserId: user?.id ?? null };
    } catch {
      return null;
    }
  }

  async findProjectName(
    organizationId: string,
    projectId: string,
  ): Promise<string> {
    try {
      if (
        !Types.ObjectId.isValid(organizationId) ||
        !Types.ObjectId.isValid(projectId)
      ) {
        return 'Project';
      }
      const projects = this.dbCollection(SERVICE_DATABASES.iam, 'projects');
      if (!projects) return 'Project';
      const doc = await projects.findOne(
        {
          _id: new Types.ObjectId(projectId),
          organizationId: new Types.ObjectId(organizationId),
        },
        { projection: { name: 1 } },
      );
      return typeof doc?.name === 'string' && doc.name.trim()
        ? doc.name.trim()
        : 'Project';
    } catch {
      return 'Project';
    }
  }

  async findProjectMembershipUserId(
    organizationId: string,
    projectId: string,
    membershipId: string,
  ): Promise<string | null> {
    try {
      const memberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'project_memberships',
      );
      if (!memberships) return membershipId;
      if (
        !Types.ObjectId.isValid(organizationId) ||
        !Types.ObjectId.isValid(projectId) ||
        !Types.ObjectId.isValid(membershipId)
      ) {
        return null;
      }
      const doc = await memberships.findOne(
        {
          _id: new Types.ObjectId(membershipId),
          organizationId: new Types.ObjectId(organizationId),
          projectId: new Types.ObjectId(projectId),
        },
        { projection: { userId: 1 } },
      );
      return doc?.userId ? String(doc.userId) : null;
    } catch {
      return null;
    }
  }

  async filterActiveOrganizationRecipients(
    organizationId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    try {
      const memberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'organization_memberships',
      );
      if (!memberships) return [...userIds];
      if (!Types.ObjectId.isValid(organizationId)) return [];
      const validObjectIds = userIds
        .map((id) => String(id ?? '').trim())
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (validObjectIds.length === 0) return [];
      const docs = await memberships
        .find(
          {
            organizationId: new Types.ObjectId(organizationId),
            userId: { $in: validObjectIds },
            status: 'ACTIVE',
          },
          { projection: { userId: 1 } },
        )
        .toArray();
      return docs.map((d) => String(d.userId));
    } catch {
      return [];
    }
  }

  async filterActiveProjectRecipients(
    organizationId: string,
    projectId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    // SEC-AUTH-016: Verify recipient holds both ACTIVE org membership and ACTIVE project membership.
    try {
      const baseConnection = this.activeConnection();
      if (!baseConnection) {
        return process.env.NODE_ENV === 'test' ? [...userIds] : [];
      }
      if (
        !Types.ObjectId.isValid(organizationId) ||
        !Types.ObjectId.isValid(projectId)
      ) {
        return [];
      }
      const orgMemberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'organization_memberships',
      );
      const projectMemberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'project_memberships',
      );
      if (!orgMemberships || !projectMemberships) {
        return [];
      }
      const normalized = [
        ...new Set(
          userIds
            .map((id) => String(id ?? '').trim())
            .filter((id) => Types.ObjectId.isValid(id)),
        ),
      ];
      if (normalized.length === 0) return [];
      const userObjIds = normalized.map((id) => new Types.ObjectId(id));
      const orgObjId = new Types.ObjectId(organizationId);
      const projObjId = new Types.ObjectId(projectId);

      const [orgDocs, projDocs] = await Promise.all([
        typeof orgMemberships.find === 'function'
          ? orgMemberships
              .find(
                {
                  organizationId: orgObjId,
                  userId: { $in: userObjIds },
                  status: 'ACTIVE',
                },
                { projection: { userId: 1 } },
              )
              .toArray()
          : Promise.all(
              userObjIds.map((uid) =>
                orgMemberships.findOne({
                  organizationId: orgObjId,
                  userId: uid,
                  status: 'ACTIVE',
                }),
              ),
            ).then((rows) => rows.filter(Boolean)),
        typeof projectMemberships.find === 'function'
          ? projectMemberships
              .find(
                {
                  organizationId: orgObjId,
                  projectId: projObjId,
                  userId: { $in: userObjIds },
                  status: 'ACTIVE',
                },
                { projection: { userId: 1 } },
              )
              .toArray()
          : Promise.all(
              userObjIds.map((uid) =>
                projectMemberships.findOne({
                  organizationId: orgObjId,
                  projectId: projObjId,
                  userId: uid,
                  status: 'ACTIVE',
                }),
              ),
            ).then((rows) => rows.filter(Boolean)),
      ]);

      const activeOrgSet = new Set(
        orgDocs.map((d) =>
          String((d as { userId?: unknown }).userId).toLowerCase(),
        ),
      );
      const activeProjSet = new Set(
        projDocs.map((d) =>
          String((d as { userId?: unknown }).userId).toLowerCase(),
        ),
      );
      return normalized.filter(
        (id) =>
          activeOrgSet.has(id.toLowerCase()) &&
          activeProjSet.has(id.toLowerCase()),
      );
    } catch {
      return [];
    }
  }

  async findExistingEventKeys(
    pairs: ReadonlyArray<{ recipientId: string; eventKey: string }>,
  ): Promise<Set<string>> {
    const existing = new Set<string>();
    if (pairs.length === 0) return existing;
    const model = this.notificationsModel();
    if (!model) {
      this.assertMemoryStoreAllowed();
      for (const pair of pairs) {
        const key = `${pair.recipientId}::${pair.eventKey}`;
        if (this.memoryEventIndex.has(key)) {
          existing.add(key);
        }
      }
      return existing;
    }

    const recipients = [...new Set(pairs.map((p) => p.recipientId))];
    const eventKeys = [...new Set(pairs.map((p) => p.eventKey))];
    const rows = await model
      .find(
        {
          recipientId: { $in: recipients },
          eventKey: { $in: eventKeys },
        },
        { recipientId: 1, eventKey: 1 },
      )
      .lean()
      .exec();
    for (const row of rows) {
      existing.add(`${row.recipientId}::${row.eventKey}`);
    }
    return existing;
  }

  async filterActiveTaskDeadlineMemberships(
    entries: ReadonlyArray<{
      organizationId: string;
      projectId: string;
      assigneeUserId: string;
    }>,
  ): Promise<Set<string>> {
    const active = new Set<string>();
    if (entries.length === 0) return active;
    const baseConnection = this.activeConnection();
    if (!baseConnection) {
      if (process.env.NODE_ENV === 'test') {
        for (const e of entries) {
          active.add(
            `${e.organizationId.toLowerCase()}:${e.projectId.toLowerCase()}:${e.assigneeUserId.toLowerCase()}`,
          );
        }
      }
      return active;
    }

    const orgMemberships = this.dbCollection(
      SERVICE_DATABASES.iam,
      'organization_memberships',
    );
    const projectMemberships = this.dbCollection(
      SERVICE_DATABASES.iam,
      'project_memberships',
    );
    if (!orgMemberships || !projectMemberships) {
      return active;
    }

    const validEntries = entries.filter(
      (e) =>
        Types.ObjectId.isValid(e.organizationId) &&
        Types.ObjectId.isValid(e.projectId) &&
        Types.ObjectId.isValid(e.assigneeUserId),
    );
    if (validEntries.length === 0) return active;

    const orgIds = [
      ...new Set(validEntries.map((e) => e.organizationId.toLowerCase())),
    ];
    const projIds = [
      ...new Set(validEntries.map((e) => e.projectId.toLowerCase())),
    ];
    const userIds = [
      ...new Set(validEntries.map((e) => e.assigneeUserId.toLowerCase())),
    ];

    try {
      const [orgRows, projRows] = await Promise.all([
        typeof orgMemberships.find === 'function'
          ? orgMemberships
              .find(
                {
                  organizationId: {
                    $in: orgIds.map((id) => new Types.ObjectId(id)),
                  },
                  userId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
                  status: 'ACTIVE',
                },
                { projection: { organizationId: 1, userId: 1 } },
              )
              .toArray()
          : Promise.resolve([]),
        typeof projectMemberships.find === 'function'
          ? projectMemberships
              .find(
                {
                  organizationId: {
                    $in: orgIds.map((id) => new Types.ObjectId(id)),
                  },
                  projectId: {
                    $in: projIds.map((id) => new Types.ObjectId(id)),
                  },
                  userId: { $in: userIds.map((id) => new Types.ObjectId(id)) },
                  status: 'ACTIVE',
                },
                { projection: { organizationId: 1, projectId: 1, userId: 1 } },
              )
              .toArray()
          : Promise.resolve([]),
      ]);

      const orgSet = new Set(
        orgRows.map(
          (row) =>
            `${String(row.organizationId).toLowerCase()}:${String(row.userId).toLowerCase()}`,
        ),
      );
      const projSet = new Set(
        projRows.map(
          (row) =>
            `${String(row.organizationId).toLowerCase()}:${String(row.projectId).toLowerCase()}:${String(row.userId).toLowerCase()}`,
        ),
      );

      for (const e of validEntries) {
        const o = e.organizationId.toLowerCase();
        const p = e.projectId.toLowerCase();
        const u = e.assigneeUserId.toLowerCase();
        if (orgSet.has(`${o}:${u}`) && projSet.has(`${o}:${p}:${u}`)) {
          active.add(`${o}:${p}:${u}`);
        }
      }
      return active;
    } catch {
      return new Set<string>();
    }
  }

  async resolveTargetAccess(
    actorUserId: string,
    notification: NotificationItemDto,
    accessLookupCache?: Map<string, Promise<unknown>>,
    activeOrganizationId?: string | null,
  ): Promise<NotificationResolveResponseDto> {
    const scopedOrgId = this.normalizeOrganizationId(activeOrganizationId);
    const notificationOrgId = this.normalizeOrganizationId(
      notification.organizationId,
    );
    const targetOrgId = this.normalizeOrganizationId(
      notification.target?.organizationId,
    );
    if (notificationOrgId && targetOrgId && notificationOrgId !== targetOrgId) {
      return {
        available: false,
        reason: 'FORBIDDEN',
        message: 'This content is no longer available',
        target: null,
      };
    }
    const notifOrgId = notificationOrgId ?? targetOrgId;
    if (scopedOrgId && notifOrgId && scopedOrgId !== notifOrgId) {
      return {
        available: false,
        reason: 'FORBIDDEN',
        message: 'This content is no longer available',
        target: null,
      };
    }

    const target = notification.target;
    if (!target) {
      return {
        available: false,
        reason: 'DELETED',
        message: 'Content is no longer available.',
        target: null,
      };
    }

    const baseConnection = this.activeConnection();
    if (!baseConnection) {
      // SEC-AUTH-011: Fail closed when database connection is unavailable.
      return {
        available: false,
        reason: 'FORBIDDEN',
        message: 'This content is no longer available',
        target: null,
      };
    }

    if (target.kind === 'ORGANIZATION') {
      const orgId = target.organizationId ?? notification.organizationId;
      if (
        notification.type === 'ORGANIZATION_MEMBER_INVITED' ||
        notification.type === 'ORGANIZATION_MEMBER_REMOVED'
      ) {
        if (!orgId || !Types.ObjectId.isValid(orgId)) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
        const orgs = this.dbCollection(SERVICE_DATABASES.iam, 'organizations');
        if (!orgs) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
        const org = await this.cachedAccessLookup(
          accessLookupCache,
          `organization:${orgId}`,
          () => orgs.findOne({ _id: new Types.ObjectId(orgId) }),
        );
        if (
          !org ||
          (org.deletedAt !== null && org.deletedAt !== undefined) ||
          org.status === 'DELETED'
        ) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
        return { available: true, reason: 'OK', target };
      }
      if (!orgId || !Types.ObjectId.isValid(orgId)) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }
      const orgs = this.dbCollection(SERVICE_DATABASES.iam, 'organizations');
      const memberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'organization_memberships',
      );
      if (!orgs || !memberships || !Types.ObjectId.isValid(actorUserId)) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      const [org, membership] = await Promise.all([
        this.cachedAccessLookup(
          accessLookupCache,
          `organization:${orgId}`,
          () => orgs.findOne({ _id: new Types.ObjectId(orgId) }),
        ),
        this.cachedAccessLookup(
          accessLookupCache,
          `organization-membership:${orgId}:${actorUserId}`,
          () =>
            memberships.findOne({
              organizationId: new Types.ObjectId(orgId),
              userId: new Types.ObjectId(actorUserId),
              status: 'ACTIVE',
            }),
        ),
      ]);
      if (
        !org ||
        (org.deletedAt !== null && org.deletedAt !== undefined) ||
        org.status === 'DELETED'
      ) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }
      if (!membership) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      return { available: true, reason: 'OK', target };
    }

    if (
      target.kind === 'PROJECT' ||
      target.kind === 'TASK' ||
      target.kind === 'WORK_NOTE'
    ) {
      const projectId = target.projectId ?? notification.projectId;
      const orgId =
        target.organizationId ?? notification.organizationId ?? scopedOrgId;
      if (
        !projectId ||
        !Types.ObjectId.isValid(projectId) ||
        !Types.ObjectId.isValid(actorUserId)
      ) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }

      const projects = this.dbCollection(SERVICE_DATABASES.iam, 'projects');
      if (!projects) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      const project = await this.cachedAccessLookup(
        accessLookupCache,
        `project:${orgId ?? ''}:${projectId}`,
        () =>
          projects.findOne({
            _id: new Types.ObjectId(projectId),
            ...(orgId && Types.ObjectId.isValid(orgId)
              ? { organizationId: new Types.ObjectId(orgId) }
              : {}),
          }),
      );
      if (
        !project ||
        (project.deletedAt !== null && project.deletedAt !== undefined) ||
        project.status === 'DELETED' ||
        project.status === 'ARCHIVED'
      ) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }

      const projectOrgId = project.organizationId as Types.ObjectId;
      if (scopedOrgId && String(projectOrgId) !== scopedOrgId) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      const memberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'organization_memberships',
      );
      const roleAssignments = this.dbCollection(
        SERVICE_DATABASES.iam,
        'role_assignments',
      );
      const projectMemberships = this.dbCollection(
        SERVICE_DATABASES.iam,
        'project_memberships',
      );

      if (!memberships || !projectMemberships) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }

      const now = new Date();
      const adminFilter = {
        organizationId: projectOrgId,
        userId: new Types.ObjectId(actorUserId),
        roleCode: 'ADMIN',
        $and: [
          { $or: [{ projectId: { $exists: false } }, { projectId: null }] },
          {
            $or: [
              { status: 'ACTIVE' },
              { status: { $exists: false } },
              { status: null },
            ],
          },
          { $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }] },
          {
            $or: [
              { validFrom: null },
              { validFrom: { $exists: false } },
              { validFrom: { $lte: now } },
            ],
          },
          {
            $or: [
              { validUntil: null },
              { validUntil: { $exists: false } },
              { validUntil: { $gt: now } },
            ],
          },
        ],
      };

      const adminRoleCollection =
        target.kind === 'WORK_NOTE' ? roleAssignments : null;
      const [orgMembership, rawAdminAssignment, projectMembership] =
        await Promise.all([
          this.cachedAccessLookup(
            accessLookupCache,
            `organization-membership:${String(projectOrgId)}:${actorUserId}`,
            () =>
              memberships.findOne({
                organizationId: projectOrgId,
                userId: new Types.ObjectId(actorUserId),
                status: 'ACTIVE',
              }),
          ),
          adminRoleCollection
            ? this.cachedAccessLookup(
                accessLookupCache,
                `admin-role:${String(projectOrgId)}:${actorUserId}`,
                () => adminRoleCollection.findOne(adminFilter),
              )
            : Promise.resolve(null),
          this.cachedAccessLookup(
            accessLookupCache,
            `project-membership:${String(projectOrgId)}:${projectId}:${actorUserId}`,
            () =>
              projectMemberships.findOne({
                organizationId: projectOrgId,
                projectId: new Types.ObjectId(projectId),
                userId: new Types.ObjectId(actorUserId),
                status: 'ACTIVE',
              }),
          ),
        ]);
      const validAdminAssignment = this.isRoleAssignmentActive(
        rawAdminAssignment,
        now,
      );

      if (!orgMembership) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }

      const isPublic =
        project.visibility === 'PUBLIC' || project.visibility === 'INTERNAL';
      const requiresExplicitProjectMembership =
        notification.type === 'PROJECT_MEMBER_REMOVED' ||
        target.kind === 'TASK' ||
        target.kind === 'WORK_NOTE';
      // SEC-AUTH-011: Drop unchecked legacy user_role_assignments bypass and never grant
      // blanket Org ADMIN access to TASK or private PROJECT targets; only validated active
      // Org ADMIN assignments apply to WORK_NOTE targets per policy.
      const adminAllowedForTarget =
        target.kind === 'WORK_NOTE' && validAdminAssignment;
      if (
        (requiresExplicitProjectMembership || !isPublic) &&
        !adminAllowedForTarget &&
        !projectMembership
      ) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }

      if (target.kind === 'TASK') {
        const taskId = target.taskId ?? notification.taskId;
        if (!taskId || !Types.ObjectId.isValid(taskId)) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
        const taskAvailable = this.taskWorkspaceRepository
          ? await this.cachedAccessLookup(
              accessLookupCache,
              `task:${projectId}:${taskId}`,
              () =>
                this.taskWorkspaceRepository!.isTaskAvailableForNotificationTarget(
                  taskId,
                  projectId,
                ),
            )
          : false;
        if (!taskAvailable) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
      }

      if (target.kind === 'WORK_NOTE') {
        const noteId = target.noteId ?? notification.noteId;
        if (!noteId || !Types.ObjectId.isValid(noteId)) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
        const notes = this.dbCollection(
          SERVICE_DATABASES.capture,
          'work_notes',
        );
        if (!notes) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
        const note = await this.cachedAccessLookup(
          accessLookupCache,
          `work-note:${String(projectOrgId)}:${projectId}:${noteId}`,
          () =>
            notes.findOne({
              _id: new Types.ObjectId(noteId),
              organizationId: projectOrgId,
              projectId: new Types.ObjectId(projectId),
              type: 'TASK_NOTE',
              status: 'CONFIRMED',
              taskId: { $type: 'objectId' },
            }),
        );
        if (
          !note ||
          (note.deletedAt !== null && note.deletedAt !== undefined) ||
          note.status === 'ARCHIVED'
        ) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
      }

      return { available: true, reason: 'OK', target };
    }

    if (target.kind === 'CHAT') {
      const conversationId =
        target.conversationId ?? notification.conversationId;
      if (!conversationId || !Types.ObjectId.isValid(conversationId)) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }
      const conversations = this.dbCollection(
        SERVICE_DATABASES.chat,
        'chat_conversations',
      );
      if (!conversations) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      const conv = await this.cachedAccessLookup(
        accessLookupCache,
        `conversation:${conversationId}`,
        () =>
          conversations.findOne({ _id: new Types.ObjectId(conversationId) }),
      );
      if (
        !conv ||
        (conv.deletedAt !== null && conv.deletedAt !== undefined) ||
        conv.status === 'ARCHIVED'
      ) {
        return {
          available: false,
          reason: 'DELETED',
          message: 'Content is no longer available.',
          target: null,
        };
      }

      const convOrgId = conv.organizationId
        ? String(conv.organizationId)
        : null;
      if (scopedOrgId && convOrgId && convOrgId !== scopedOrgId) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }

      const chatOrgId =
        target.organizationId ?? notification.organizationId ?? convOrgId;
      if (
        chatOrgId &&
        Types.ObjectId.isValid(chatOrgId) &&
        Types.ObjectId.isValid(actorUserId)
      ) {
        const orgMemberships = this.dbCollection(
          SERVICE_DATABASES.iam,
          'organization_memberships',
        );
        if (!orgMemberships) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
        const orgMembership = await this.cachedAccessLookup(
          accessLookupCache,
          `organization-membership:${chatOrgId}:${actorUserId}`,
          () =>
            orgMemberships.findOne({
              organizationId: new Types.ObjectId(chatOrgId),
              userId: new Types.ObjectId(actorUserId),
              status: 'ACTIVE',
            }),
        );
        if (!orgMembership) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
      }

      const normalizedActorId = actorUserId.toLowerCase();
      let isMember = false;
      if (Array.isArray(conv.members)) {
        isMember = conv.members.some(
          (m: { userId?: unknown; status?: unknown; deletedAt?: unknown }) => {
            const id =
              typeof m?.userId === 'string'
                ? m.userId.toLowerCase()
                : m?.userId instanceof Types.ObjectId
                  ? m.userId.toHexString().toLowerCase()
                  : '';
            const statusOk =
              m?.status === undefined ||
              m?.status === null ||
              m?.status === 'ACTIVE';
            const notDeleted =
              m?.deletedAt === undefined || m?.deletedAt === null;
            return id === normalizedActorId && statusOk && notDeleted;
          },
        );
      } else {
        const chatMembers = this.dbCollection(
          SERVICE_DATABASES.chat,
          'chat_members',
        );
        if (!chatMembers) {
          // SEC-AUTH-011: Fail closed when chat_members collection handle is missing.
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
        const memberDoc = await this.cachedAccessLookup(
          accessLookupCache,
          `chat-member:${conversationId}:${actorUserId}`,
          () =>
            chatMembers.findOne({
              conversationId: new Types.ObjectId(conversationId),
              ...(chatOrgId && Types.ObjectId.isValid(chatOrgId)
                ? { organizationId: new Types.ObjectId(chatOrgId) }
                : {}),
              userId: Types.ObjectId.isValid(actorUserId)
                ? {
                    $in: [
                      actorUserId,
                      normalizedActorId,
                      new Types.ObjectId(actorUserId),
                    ],
                  }
                : actorUserId,
              $or: [
                { status: 'ACTIVE' },
                { status: { $exists: false } },
                { status: null },
              ],
            }),
        );
        const statusOk =
          memberDoc &&
          (memberDoc.status === undefined ||
            memberDoc.status === null ||
            memberDoc.status === 'ACTIVE');
        isMember = Boolean(
          memberDoc &&
          statusOk &&
          (memberDoc.deletedAt === null || memberDoc.deletedAt === undefined),
        );
      }
      if (!isMember) {
        return {
          available: false,
          reason: 'FORBIDDEN',
          message: 'This content is no longer available',
          target: null,
        };
      }
      if (target.messageId && Types.ObjectId.isValid(target.messageId)) {
        const messageObjectId = new Types.ObjectId(target.messageId);
        const convMessages = this.dbCollection(
          SERVICE_DATABASES.chat,
          'chat_conversation_messages',
        );
        const legacyMessages = this.dbCollection(
          SERVICE_DATABASES.chat,
          'chat_messages',
        );
        if (!convMessages && !legacyMessages) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
        let msg = convMessages
          ? await this.cachedAccessLookup(
              accessLookupCache,
              `chat-message:${conversationId}:${target.messageId}`,
              () =>
                convMessages.findOne({
                  _id: messageObjectId,
                  conversationId: new Types.ObjectId(conversationId),
                  ...(chatOrgId && Types.ObjectId.isValid(chatOrgId)
                    ? { organizationId: new Types.ObjectId(chatOrgId) }
                    : {}),
                }),
            )
          : null;
        if (!msg && legacyMessages) {
          msg = await legacyMessages.findOne({
            _id: messageObjectId,
            conversationId: new Types.ObjectId(conversationId),
            ...(chatOrgId && Types.ObjectId.isValid(chatOrgId)
              ? { organizationId: new Types.ObjectId(chatOrgId) }
              : {}),
          });
        }
        if (!msg || (msg.deletedAt !== null && msg.deletedAt !== undefined)) {
          return {
            available: false,
            reason: 'DELETED',
            message: 'Content is no longer available.',
            target: null,
          };
        }
      }
      return { available: true, reason: 'OK', target };
    }

    return {
      available: false,
      reason: 'FORBIDDEN',
      message: 'This content is no longer available',
      target: null,
    };
  }

  private encodeCursor(createdAt: Date, id: Types.ObjectId): string {
    return `${createdAt.toISOString()}_${id.toHexString()}`;
  }

  private parseCursor(
    cursor?: string,
  ): { createdAt: Date; id: Types.ObjectId } | null {
    if (!cursor || typeof cursor !== 'string') return null;
    const separatorIndex = cursor.lastIndexOf('_');
    if (separatorIndex <= 0) return null;
    const rawDate = cursor.slice(0, separatorIndex);
    const rawId = cursor.slice(separatorIndex + 1);
    const createdAt = new Date(rawDate);
    if (Number.isNaN(createdAt.getTime()) || !Types.ObjectId.isValid(rawId)) {
      return null;
    }
    return { createdAt, id: new Types.ObjectId(rawId) };
  }

  private toDto(doc: NotificationDocumentRecord): NotificationItemDto {
    const target: NotificationTarget | null = doc.target
      ? {
          kind: doc.target.kind,
          url: doc.target.url,
          organizationId:
            doc.target.organizationId ?? doc.organizationId ?? null,
          projectId: doc.target.projectId ?? doc.projectId ?? null,
          taskId: doc.target.taskId ?? doc.taskId ?? null,
          noteId: doc.target.noteId ?? doc.noteId ?? null,
          conversationId:
            doc.target.conversationId ?? doc.conversationId ?? null,
          messageId: doc.target.messageId ?? null,
          ...(doc.target.reportId ? { reportId: doc.target.reportId } : {}),
        }
      : doc.actionUrl
        ? {
            kind: 'ORGANIZATION',
            url: doc.actionUrl,
            organizationId: doc.organizationId ?? null,
          }
        : null;

    const resolvedReadAt = doc.readAt
      ? new Date(doc.readAt).toISOString()
      : doc.isRead
        ? new Date(doc.updatedAt ?? doc.createdAt).toISOString()
        : null;

    return {
      id: doc._id.toHexString(),
      recipientId: doc.recipientId || doc.recipientUserId || '',
      actorId: doc.actorId ?? null,
      organizationId: doc.organizationId ?? doc.target?.organizationId ?? null,
      projectId: doc.projectId ?? null,
      taskId: doc.taskId ?? null,
      noteId: doc.noteId ?? null,
      conversationId: doc.conversationId ?? null,
      type: doc.type,
      title: doc.title,
      message: doc.message || doc.body || '',
      target,
      readAt: resolvedReadAt,
      createdAt: new Date(doc.createdAt).toISOString(),
    };
  }
}
