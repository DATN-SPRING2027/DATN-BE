import type {
  NotificationMvpType,
  NotificationTargetKind,
} from './infrastructure/mongodb/mongodb.schemas';

export type { NotificationMvpType, NotificationTargetKind };

export type NotificationTarget = Readonly<{
  kind: NotificationTargetKind;
  url: string;
  organizationId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}>;

export type NotificationItemDto = Readonly<{
  id: string;
  recipientId: string;
  actorId: string | null;
  organizationId: string | null;
  projectId: string | null;
  taskId: string | null;
  noteId: string | null;
  conversationId: string | null;
  type: NotificationMvpType;
  title: string;
  message: string;
  target: NotificationTarget | null;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationListQuery = Readonly<{
  cursor?: string;
  limit?: number;
  unreadOnly?: boolean;
}>;

export type NotificationListResponseDto = Readonly<{
  items: readonly NotificationItemDto[];
  nextCursor: string | null;
  unreadCount: number;
}>;

export type NotificationResolveResponseDto = Readonly<{
  available: boolean;
  reason?: 'OK' | 'DELETED' | 'FORBIDDEN';
  message?: string;
  target: NotificationTarget | null;
}>;

export type NotificationRecipientInput = Readonly<{
  userId: string;
  title?: string;
  message?: string;
}>;

export type EmitNotificationInput = Readonly<{
  type: NotificationMvpType;
  actorId?: string | null;
  recipients: readonly (string | NotificationRecipientInput)[];
  title: string;
  message: string;
  organizationId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  noteId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  target: NotificationTarget;
  eventKey: string;
}>;
