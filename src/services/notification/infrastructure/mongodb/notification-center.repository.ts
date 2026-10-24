import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { SERVICE_DATABASES } from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../../../iam/infrastructure/persistence';
import { CHAT_PERSISTENCE } from '../../../chat/infrastructure/persistence';
import { NOTIFICATION_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
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

  private notificationsModel(): Model<NotificationDocumentRecord> | null {
    const baseConnection = this.activeConnection();
    if (!baseConnection) return null;
    const db = baseConnection.useDb(SERVICE_DATABASES.notification, {
      useCache: true,
    });
    const existing = db.models['notifications'] as
      Model<NotificationDocumentRecord> | undefined;
    if (existing) return existing;
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

  async upsertNotification(
    input: UpsertNotificationRecordInput,
  ): Promise<{ item: NotificationItemDto; created: boolean }> {
    const model = this.notificationsModel();
    const now = new Date();
    if (!model) {
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
        organizationId: input.organizationId ?? null,
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
        organizationId: input.organizationId ?? null,
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

  async listByRecipient(
    recipientId: string,
    query: NotificationListQuery,
  ): Promise<NotificationListResponseDto> {
    const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
    const parsedCursor = this.parseCursor(query.cursor);
    const model = this.notificationsModel();

    if (!model) {
      const allForRecipient = [...this.memoryStore.values()]
        .filter((doc) => doc.recipientId === recipientId)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b._id.toHexString().localeCompare(a._id.toHexString()),
        );
      const unreadCount = allForRecipient.filter((doc) => !doc.readAt).length;
      const filtered = allForRecipient.filter((doc) => {
        if (query.unreadOnly && doc.readAt) return false;
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
      return {
        items: pageItems.map((doc) => this.toDto(doc)),
        nextCursor:
          hasMore && last ? this.encodeCursor(last.createdAt, last._id) : null,
        unreadCount,
      };
    }

    const filter: Record<string, unknown> = { recipientId };
    if (query.unreadOnly) {
      filter.readAt = null;
    }
    if (parsedCursor) {
      filter.$or = [
        { createdAt: { $lt: parsedCursor.createdAt } },
        {
          createdAt: parsedCursor.createdAt,
          _id: { $lt: parsedCursor.id },
        },
      ];
    }

    const [rows, unreadCount] = await Promise.all([
      model
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1)
        .lean()
        .exec(),
      model.countDocuments({ recipientId, readAt: null }).exec(),
    ]);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);

    return {
      items: pageRows.map((row) => this.toDto(row)),
      nextCursor:
        hasMore && last ? this.encodeCursor(last.createdAt, last._id) : null,
      unreadCount,
    };
  }

  async countUnread(recipientId: string): Promise<number> {
    const model = this.notificationsModel();
    if (!model) {
      return [...this.memoryStore.values()].filter(
        (doc) => doc.recipientId === recipientId && !doc.readAt,
      ).length;
    }
    return model.countDocuments({ recipientId, readAt: null }).exec();
  }

  async markRead(
    recipientId: string,
    notificationId: string,
    now = new Date(),
  ): Promise<NotificationItemDto | null> {
    if (!Types.ObjectId.isValid(notificationId)) {
      return null;
    }
    const model = this.notificationsModel();
    if (!model) {
      const doc = this.memoryStore.get(notificationId);
      if (!doc || doc.recipientId !== recipientId) return null;
      if (!doc.readAt) {
        doc.readAt = now;
        doc.isRead = true;
        doc.updatedAt = now;
      }
      return this.toDto(doc);
    }

    const existing = await model
      .findOne({ _id: new Types.ObjectId(notificationId), recipientId })
      .lean()
      .exec();
    if (!existing) return null;
    if (existing.readAt) {
      return this.toDto(existing);
    }

    const updated = await model
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(notificationId),
          recipientId,
          readAt: null,
        },
        {
          $set: {
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
    now = new Date(),
  ): Promise<{ updatedCount: number; readAt: string }> {
    const model = this.notificationsModel();
    if (!model) {
      let updatedCount = 0;
      for (const doc of this.memoryStore.values()) {
        if (doc.recipientId === recipientId && !doc.readAt) {
          doc.readAt = now;
          doc.isRead = true;
          doc.updatedAt = now;
          updatedCount += 1;
        }
      }
      return { updatedCount, readAt: now.toISOString() };
    }

    const result = await model
      .updateMany(
        { recipientId, readAt: null },
        { $set: { isRead: true, readAt: now } },
      )
      .exec();

    return {
      updatedCount: result.modifiedCount ?? 0,
      readAt: now.toISOString(),
    };
  }

  async findByIdForRecipient(
    recipientId: string,
    notificationId: string,
  ): Promise<NotificationItemDto | null> {
    if (!Types.ObjectId.isValid(notificationId)) {
      return null;
    }
    const model = this.notificationsModel();
    if (!model) {
      const doc = this.memoryStore.get(notificationId);
      if (!doc || doc.recipientId !== recipientId) return null;
      return this.toDto(doc);
    }
    const doc = await model
      .findOne({ _id: new Types.ObjectId(notificationId), recipientId })
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

  async resolveTargetAccess(
    actorUserId: string,
    notification: NotificationItemDto,
  ): Promise<NotificationResolveResponseDto> {
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
      return {
        available: true,
        reason: 'OK',
        target,
      };
    }

    if (target.kind === 'ORGANIZATION') {
      const orgId = target.organizationId ?? notification.organizationId;
      if (
        notification.type === 'ORGANIZATION_MEMBER_INVITED' ||
        notification.type === 'ORGANIZATION_MEMBER_REMOVED'
      ) {
        if (orgId && Types.ObjectId.isValid(orgId)) {
          const orgs = this.dbCollection(SERVICE_DATABASES.iam, 'organizations');
          if (orgs) {
            const org = await orgs.findOne({ _id: new Types.ObjectId(orgId) });
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
          }
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
      if (orgs && memberships && Types.ObjectId.isValid(actorUserId)) {
        const [org, membership] = await Promise.all([
          orgs.findOne({ _id: new Types.ObjectId(orgId) }),
          memberships.findOne({
            organizationId: new Types.ObjectId(orgId),
            userId: new Types.ObjectId(actorUserId),
            status: 'ACTIVE',
          }),
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
      }
      return { available: true, reason: 'OK', target };
    }

    if (
      target.kind === 'PROJECT' ||
      target.kind === 'TASK' ||
      target.kind === 'WORK_NOTE'
    ) {
      const projectId = target.projectId ?? notification.projectId;
      const orgId = target.organizationId ?? notification.organizationId;
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
      if (projects) {
        const project = await projects.findOne({
          _id: new Types.ObjectId(projectId),
          ...(orgId && Types.ObjectId.isValid(orgId)
            ? { organizationId: new Types.ObjectId(orgId) }
            : {}),
        });
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
        const memberships = this.dbCollection(
          SERVICE_DATABASES.iam,
          'organization_memberships',
        );
        const roleAssignments = this.dbCollection(
          SERVICE_DATABASES.iam,
          'role_assignments',
        );
        const legacyRoleAssignments = this.dbCollection(
          SERVICE_DATABASES.iam,
          'user_role_assignments',
        );
        const projectMemberships = this.dbCollection(
          SERVICE_DATABASES.iam,
          'project_memberships',
        );

        const adminFilter = {
          organizationId: projectOrgId,
          userId: new Types.ObjectId(actorUserId),
          roleCode: 'ADMIN',
          $or: [{ projectId: { $exists: false } }, { projectId: null }],
        };

        const [
          orgMembership,
          adminAssignmentPrimary,
          adminAssignmentLegacy,
          projectMembership,
        ] = await Promise.all([
          memberships?.findOne({
            organizationId: projectOrgId,
            userId: new Types.ObjectId(actorUserId),
            status: 'ACTIVE',
          }),
          roleAssignments?.findOne(adminFilter),
          legacyRoleAssignments?.findOne({
            organizationId: projectOrgId,
            projectId: null,
            userId: new Types.ObjectId(actorUserId),
            roleCode: 'ADMIN',
          }),
          projectMemberships?.findOne({
            organizationId: projectOrgId,
            projectId: new Types.ObjectId(projectId),
            userId: new Types.ObjectId(actorUserId),
            status: 'ACTIVE',
          }),
        ]);
        const adminAssignment =
          adminAssignmentPrimary ?? adminAssignmentLegacy ?? null;

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
        if (
          (requiresExplicitProjectMembership || !isPublic) &&
          !adminAssignment &&
          !projectMembership
        ) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
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
        const tasks = this.dbCollection('continuum_task', 'tasks');
        if (tasks) {
          const task = await tasks.findOne({
            _id: new Types.ObjectId(taskId),
            projectId: new Types.ObjectId(projectId),
          });
          if (
            !task ||
            (task.deletedAt !== null && task.deletedAt !== undefined) ||
            task.status === 'CANCELLED'
          ) {
            return {
              available: false,
              reason: 'DELETED',
              message: 'Content is no longer available.',
              target: null,
            };
          }
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
        if (notes) {
          const note = await notes.findOne({
            _id: new Types.ObjectId(noteId),
            projectId: new Types.ObjectId(projectId),
          });
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
      if (conversations) {
        const conv = await conversations.findOne({
          _id: new Types.ObjectId(conversationId),
        });
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
        const normalizedActorId = actorUserId.toLowerCase();
        let isMember = false;
        if (Array.isArray(conv.members)) {
          isMember = conv.members.some((m: { userId?: unknown }) => {
            const id =
              typeof m?.userId === 'string'
                ? m.userId.toLowerCase()
                : m?.userId instanceof Types.ObjectId
                  ? m.userId.toHexString().toLowerCase()
                  : '';
            return id === normalizedActorId;
          });
        } else {
          const chatMembers = this.dbCollection(
            SERVICE_DATABASES.chat,
            'chat_members',
          );
          if (chatMembers) {
            const memberDoc = await chatMembers.findOne({
              conversationId: new Types.ObjectId(conversationId),
              userId: Types.ObjectId.isValid(actorUserId)
                ? {
                    $in: [
                      actorUserId,
                      normalizedActorId,
                      new Types.ObjectId(actorUserId),
                    ],
                  }
                : actorUserId,
            });
            isMember = Boolean(
              memberDoc &&
                (memberDoc.deletedAt === null ||
                  memberDoc.deletedAt === undefined),
            );
          } else {
            isMember = true;
          }
        }
        if (!isMember) {
          return {
            available: false,
            reason: 'FORBIDDEN',
            message: 'This content is no longer available',
            target: null,
          };
        }
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
        let msg = convMessages
          ? await convMessages.findOne({
              _id: messageObjectId,
              conversationId: new Types.ObjectId(conversationId),
            })
          : null;
        if (!msg && legacyMessages) {
          msg = await legacyMessages.findOne({
            _id: messageObjectId,
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

    return { available: true, reason: 'OK', target };
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
        }
      : doc.actionUrl
        ? {
            kind: 'ORGANIZATION',
            url: doc.actionUrl,
            organizationId: doc.organizationId ?? null,
          }
        : null;

    return {
      id: doc._id.toHexString(),
      recipientId: doc.recipientId,
      actorId: doc.actorId ?? null,
      organizationId: doc.organizationId ?? null,
      projectId: doc.projectId ?? null,
      taskId: doc.taskId ?? null,
      noteId: doc.noteId ?? null,
      conversationId: doc.conversationId ?? null,
      type: doc.type,
      title: doc.title,
      message: doc.message || doc.body || '',
      target,
      readAt: doc.readAt ? new Date(doc.readAt).toISOString() : null,
      createdAt: new Date(doc.createdAt).toISOString(),
    };
  }
}
