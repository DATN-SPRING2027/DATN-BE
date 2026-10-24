import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationCenterRepository } from './infrastructure/mongodb/notification-center.repository';
import { NotificationRealtimeBus } from './notification-realtime.bus';
import type {
  EmitNotificationInput,
  NotificationItemDto,
  NotificationListQuery,
  NotificationListResponseDto,
  NotificationResolveResponseDto,
} from './notification-center.types';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repository: NotificationCenterRepository,
    private readonly realtimeBus: NotificationRealtimeBus,
  ) {}

  getHealth(): { service: string; status: string } {
    return { service: 'notification', status: 'ok' };
  }

  async emit(input: EmitNotificationInput): Promise<NotificationItemDto[]> {
    const actorId = input.actorId ? String(input.actorId).trim() : null;
    const deduplicatedRecipients = new Map<
      string,
      { userId: string; title: string; message: string }
    >();

    for (const rawRecipient of input.recipients) {
      const normalized =
        typeof rawRecipient === 'string'
          ? {
              userId: rawRecipient.trim(),
              title: input.title,
              message: input.message,
            }
          : {
              userId: String(rawRecipient.userId ?? '').trim(),
              title: rawRecipient.title ?? input.title,
              message: rawRecipient.message ?? input.message,
            };

      if (!normalized.userId) continue;
      // Rule 1: Never notify actor for their own action
      if (actorId && normalized.userId === actorId) continue;
      // Rule 2: Deduplicate recipients within the same business event
      if (!deduplicatedRecipients.has(normalized.userId)) {
        deduplicatedRecipients.set(normalized.userId, normalized);
      }
    }

    if (deduplicatedRecipients.size === 0) {
      return [];
    }

    const persistedItems: NotificationItemDto[] = [];
    for (const recipient of deduplicatedRecipients.values()) {
      const { item, created } = await this.repository.upsertNotification({
        recipientId: recipient.userId,
        actorId,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        noteId: input.noteId ?? null,
        conversationId: input.conversationId ?? null,
        type: input.type,
        title: recipient.title,
        message: recipient.message,
        target: input.target,
        eventKey: input.eventKey,
      });
      persistedItems.push(item);

      // Rule 6: Attempt realtime delivery after DB persistence; failure must not lose notification
      if (created) {
        try {
          this.realtimeBus.publishCreated(item);
        } catch (error) {
          this.logger.warn(
            `Realtime notification delivery failed for ${item.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    return persistedItems;
  }

  async emitSafe(input: EmitNotificationInput): Promise<NotificationItemDto[]> {
    try {
      return await this.emit(input);
    } catch (error) {
      this.logger.error(
        `Failed to emit notification (${input.type}, eventKey=${input.eventKey}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  async listForUser(
    userId: string,
    query: NotificationListQuery = {},
  ): Promise<NotificationListResponseDto> {
    return this.repository.listByRecipient(userId, query);
  }

  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.repository.countUnread(userId);
    return { count };
  }

  async markAsRead(
    userId: string,
    notificationId: string,
  ): Promise<NotificationItemDto> {
    const updated = await this.repository.markRead(userId, notificationId);
    if (!updated) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found.',
      });
    }
    if (updated.readAt) {
      this.realtimeBus.publishRead({
        organizationId: updated.organizationId,
        recipientId: userId,
        notificationId: updated.id,
        readAt: updated.readAt,
      });
    }
    return updated;
  }

  async markAllAsRead(
    userId: string,
    organizationId: string | null = null,
  ): Promise<{ updatedCount: number; readAt: string }> {
    const result = await this.repository.markAllRead(userId);
    if (result.updatedCount > 0) {
      this.realtimeBus.publishReadAll({
        organizationId,
        recipientId: userId,
        readAt: result.readAt,
      });
    }
    return result;
  }

  async resolveTarget(
    userId: string,
    notificationId: string,
  ): Promise<NotificationResolveResponseDto> {
    const notification = await this.repository.findByIdForRecipient(
      userId,
      notificationId,
    );
    if (!notification) {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found.',
      });
    }
    return this.repository.resolveTargetAccess(userId, notification);
  }

  // ============================================================
  // 13 MVP BUSINESS EVENT HELPERS
  // ============================================================

  async notifyOrganizationMemberInvited(input: {
    actorId: string;
    recipientUserId?: string | null;
    recipientEmail?: string | null;
    organizationId: string;
    organizationName?: string;
    invitationId: string;
  }): Promise<NotificationItemDto[]> {
    let recipientId = input.recipientUserId ?? null;
    if (!recipientId && input.recipientEmail) {
      const user = await this.repository.findActiveUserByEmail(
        input.recipientEmail,
      );
      recipientId = user?.id ?? null;
    }
    if (!recipientId) {
      const ctx = await this.repository.findInvitationContext(
        input.organizationId,
        input.invitationId,
      );
      recipientId = ctx?.recipientUserId ?? null;
    }
    if (!recipientId) return [];

    const orgName =
      input.organizationName ??
      (await this.repository.findOrganizationName(input.organizationId));

    return this.emitSafe({
      type: 'ORGANIZATION_MEMBER_INVITED',
      actorId: input.actorId,
      recipients: [recipientId],
      title: 'Organization invitation',
      message: `You have been invited to join Organization ${orgName}`,
      organizationId: input.organizationId,
      target: {
        kind: 'ORGANIZATION',
        url: '/select-organization',
        organizationId: input.organizationId,
      },
      eventKey: `org_member_invited:${input.organizationId}:${input.invitationId}`,
    });
  }

  async notifyOrganizationMemberAdded(input: {
    actorId?: string | null;
    recipientUserId: string;
    organizationId: string;
    organizationName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const orgName =
      input.organizationName ??
      (await this.repository.findOrganizationName(input.organizationId));

    return this.emitSafe({
      type: 'ORGANIZATION_MEMBER_ADDED',
      actorId: input.actorId ?? null,
      recipients: [input.recipientUserId],
      title: 'Added to organization',
      message: `You were added to Organization ${orgName}`,
      organizationId: input.organizationId,
      target: {
        kind: 'ORGANIZATION',
        url: '/organization/members',
        organizationId: input.organizationId,
      },
      eventKey: `org_member_added:${input.organizationId}:${input.eventId}`,
    });
  }

  async notifyOrganizationMemberRemoved(input: {
    actorId: string;
    recipientUserId: string;
    organizationId: string;
    organizationName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const orgName =
      input.organizationName ??
      (await this.repository.findOrganizationName(input.organizationId));

    return this.emitSafe({
      type: 'ORGANIZATION_MEMBER_REMOVED',
      actorId: input.actorId,
      recipients: [input.recipientUserId],
      title: 'Removed from organization',
      message: `You were removed from Organization ${orgName}`,
      organizationId: input.organizationId,
      target: {
        kind: 'ORGANIZATION',
        url: '/select-organization',
        organizationId: input.organizationId,
      },
      eventKey: `org_member_removed:${input.organizationId}:${input.eventId}`,
    });
  }

  async notifyProjectMemberAdded(input: {
    actorId: string;
    recipientUserIds: readonly string[];
    organizationId: string;
    projectId: string;
    projectName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const projectName =
      input.projectName ??
      (await this.repository.findProjectName(
        input.organizationId,
        input.projectId,
      ));

    return this.emitSafe({
      type: 'PROJECT_MEMBER_ADDED',
      actorId: input.actorId,
      recipients: input.recipientUserIds,
      title: 'Added to project',
      message: `You were added to Project ${projectName}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      target: {
        kind: 'PROJECT',
        url: `/projects/${input.projectId}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      eventKey: `project_member_added:${input.projectId}:${input.eventId}`,
    });
  }

  async notifyProjectMemberRemoved(input: {
    actorId: string;
    recipientUserId?: string | null;
    membershipId?: string;
    organizationId: string;
    projectId: string;
    projectName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const resolvedRecipientId =
      input.recipientUserId ??
      (input.membershipId
        ? await this.repository.findProjectMembershipUserId(
            input.organizationId,
            input.projectId,
            input.membershipId,
          )
        : null);
    if (!resolvedRecipientId) return [];

    const projectName =
      input.projectName ??
      (await this.repository.findProjectName(
        input.organizationId,
        input.projectId,
      ));

    return this.emitSafe({
      type: 'PROJECT_MEMBER_REMOVED',
      actorId: input.actorId,
      recipients: [resolvedRecipientId],
      title: 'Removed from project',
      message: `You were removed from Project ${projectName}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      target: {
        kind: 'PROJECT',
        url: `/projects/${input.projectId}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      eventKey: `project_member_removed:${input.projectId}:${input.eventId}`,
    });
  }

  async notifyProjectLeaderAssigned(input: {
    actorId: string;
    recipientUserIds: readonly string[];
    organizationId: string;
    projectId: string;
    projectName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const projectName =
      input.projectName ??
      (await this.repository.findProjectName(
        input.organizationId,
        input.projectId,
      ));

    return this.emitSafe({
      type: 'PROJECT_LEADER_ASSIGNED',
      actorId: input.actorId,
      recipients: input.recipientUserIds,
      title: 'Assigned as Project Leader',
      message: `You were assigned as Project Leader of Project ${projectName}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      target: {
        kind: 'PROJECT',
        url: `/projects/${input.projectId}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      eventKey: `project_leader_assigned:${input.projectId}:${input.eventId}`,
    });
  }

  async notifyProjectLeaderChanged(input: {
    actorId: string;
    previousLeaderUserId: string;
    nextLeaderUserId: string;
    organizationId: string;
    projectId: string;
    projectName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const projectName =
      input.projectName ??
      (await this.repository.findProjectName(
        input.organizationId,
        input.projectId,
      ));

    return this.emitSafe({
      type: 'PROJECT_LEADER_CHANGED',
      actorId: input.actorId,
      recipients: [
        {
          userId: input.nextLeaderUserId,
          title: 'Project Leader updated',
          message: `You were appointed Project Leader of Project ${projectName}`,
        },
        {
          userId: input.previousLeaderUserId,
          title: 'Project Leader updated',
          message: `You are no longer Project Leader of Project ${projectName}`,
        },
      ],
      title: 'Project Leader updated',
      message: `Project Leader of Project ${projectName} was updated`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      target: {
        kind: 'PROJECT',
        url: `/projects/${input.projectId}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      eventKey: `project_leader_changed:${input.projectId}:${input.eventId}`,
    });
  }

  async notifyProjectLeaderRevoked(input: {
    actorId: string;
    recipientUserId: string;
    organizationId: string;
    projectId: string;
    projectName?: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    const projectName =
      input.projectName ??
      (await this.repository.findProjectName(
        input.organizationId,
        input.projectId,
      ));

    return this.emitSafe({
      type: 'PROJECT_LEADER_REVOKED',
      actorId: input.actorId,
      recipients: [input.recipientUserId],
      title: 'Project Leader role revoked',
      message: `You are no longer Project Leader of Project ${projectName}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      target: {
        kind: 'PROJECT',
        url: `/projects/${input.projectId}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      eventKey: `project_leader_revoked:${input.projectId}:${input.eventId}`,
    });
  }

  async notifyTaskAssigned(input: {
    actorId: string;
    assigneeUserId: string;
    organizationId: string;
    projectId: string;
    taskId: string;
    taskTitle: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    return this.emitSafe({
      type: 'TASK_ASSIGNED',
      actorId: input.actorId,
      recipients: [input.assigneeUserId],
      title: 'Task assigned',
      message: `You were assigned to Task ${input.taskTitle}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      target: {
        kind: 'TASK',
        url: `/projects/${input.projectId}/work?taskId=${encodeURIComponent(input.taskId)}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        taskId: input.taskId,
      },
      eventKey: `task_assigned:${input.taskId}:${input.eventId}`,
    });
  }

  async notifyTaskDeadlineApproaching(input: {
    assigneeUserId: string;
    organizationId: string;
    projectId: string;
    taskId: string;
    taskTitle: string;
    dueDateIso: string;
  }): Promise<NotificationItemDto[]> {
    return this.emitSafe({
      type: 'TASK_DEADLINE_APPROACHING',
      actorId: null,
      recipients: [input.assigneeUserId],
      title: 'Task deadline approaching',
      message: `Task ${input.taskTitle} is approaching its deadline`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      target: {
        kind: 'TASK',
        url: `/projects/${input.projectId}/work?taskId=${encodeURIComponent(input.taskId)}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        taskId: input.taskId,
      },
      eventKey: `task_deadline_approaching:${input.taskId}:${input.dueDateIso}`,
    });
  }

  async notifyTaskDeadlineOverdue(input: {
    assigneeUserId: string;
    organizationId: string;
    projectId: string;
    taskId: string;
    taskTitle: string;
    dueDateIso: string;
  }): Promise<NotificationItemDto[]> {
    return this.emitSafe({
      type: 'TASK_DEADLINE_OVERDUE',
      actorId: null,
      recipients: [input.assigneeUserId],
      title: 'Task overdue',
      message: `Task ${input.taskTitle} is overdue`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: input.taskId,
      target: {
        kind: 'TASK',
        url: `/projects/${input.projectId}/work?taskId=${encodeURIComponent(input.taskId)}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        taskId: input.taskId,
      },
      eventKey: `task_deadline_overdue:${input.taskId}:${input.dueDateIso}`,
    });
  }

  async notifyWorkNoteMention(input: {
    actorId: string;
    mentionedUserIds: readonly string[];
    organizationId: string;
    projectId: string;
    noteId: string;
    noteTitle: string;
    eventId: string;
  }): Promise<NotificationItemDto[]> {
    return this.emitSafe({
      type: 'WORK_NOTE_MENTION',
      actorId: input.actorId,
      recipients: input.mentionedUserIds,
      title: 'Mentioned in a work note',
      message: `You were mentioned in Work Note ${input.noteTitle}`,
      organizationId: input.organizationId,
      projectId: input.projectId,
      noteId: input.noteId,
      target: {
        kind: 'WORK_NOTE',
        url: `/projects/${input.projectId}/work-notes?noteId=${encodeURIComponent(input.noteId)}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        noteId: input.noteId,
      },
      eventKey: `work_note_mention:${input.noteId}:${input.eventId}`,
    });
  }

  async notifyChatMention(input: {
    actorId: string;
    mentionedUserIds: readonly string[];
    organizationId: string;
    conversationId: string;
    messageId: string;
  }): Promise<NotificationItemDto[]> {
    return this.emitSafe({
      type: 'CHAT_MENTION',
      actorId: input.actorId,
      recipients: input.mentionedUserIds,
      title: 'Mentioned in chat',
      message: 'You were mentioned in a chat',
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      target: {
        kind: 'CHAT',
        url: `/chat?conversation=${encodeURIComponent(input.conversationId)}&message=${encodeURIComponent(input.messageId)}`,
        organizationId: input.organizationId,
        conversationId: input.conversationId,
        messageId: input.messageId,
      },
      eventKey: `chat_mention:${input.conversationId}:${input.messageId}`,
    });
  }
}
