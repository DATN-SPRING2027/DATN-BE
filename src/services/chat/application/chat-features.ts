import type {
  ChatActor,
  ChatCursor,
  ChatMessage,
  ChatMessagePage,
} from './chat.repository';

export interface ChatPreferences {
  isPinned: boolean;
  isArchived: boolean;
  notificationMode: 'ALL' | 'MENTIONS' | 'NONE';
  markedUnread: boolean;
}
export interface ChatSearchFilters {
  q: string;
  conversationId?: string;
  senderId?: string;
  from?: Date;
  to?: Date;
  kind?: 'IMAGE' | 'DOCUMENT' | 'LINK';
}
export interface ChatNotification {
  id: string;
  conversationId: string;
  messageId: string;
  senderName: string;
  preview: string;
  createdAt: string;
  readAt: string | null;
}
export interface ChatFeatureRepository {
  getPreferences(
    actor: ChatActor,
    conversationId: string,
  ): Promise<ChatPreferences>;
  setPreferences(
    actor: ChatActor,
    conversationId: string,
    changes: Partial<ChatPreferences>,
  ): Promise<ChatPreferences>;
  getDraft(
    actor: ChatActor,
    conversationId: string,
  ): Promise<{
    content: string;
    mentionUserIds: string[];
    updatedAt: string | null;
  }>;
  saveDraft(
    actor: ChatActor,
    conversationId: string,
    content: string,
    mentionUserIds?: string[],
  ): Promise<{
    content: string;
    mentionUserIds: string[];
    updatedAt: string | null;
  }>;
  transferOwnership(
    actor: ChatActor,
    conversationId: string,
    userId: string,
  ): Promise<void>;
  setManager(
    actor: ChatActor,
    conversationId: string,
    userId: string,
    active: boolean,
  ): Promise<void>;
  searchAcross(
    actor: ChatActor,
    filters: ChatSearchFilters,
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage>;
  library(
    actor: ChatActor,
    conversationId: string,
    kind: 'IMAGE' | 'DOCUMENT' | 'LINK' | 'PIN',
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage>;
  pinMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    active: boolean,
  ): Promise<void>;
  forwardMessage(
    actor: ChatActor,
    conversationId: string,
    sourceConversationId: string,
    messageId: string,
    clientMessageId: string,
  ): Promise<ChatMessage>;
  receipts(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<{
    data: {
      userId: string;
      displayName: string;
      read: boolean;
      delivered: boolean;
      readAt: string | null;
      deliveredAt: string | null;
    }[];
  }>;
  notifications(
    actor: ChatActor,
    limit: number,
    before?: ChatCursor,
  ): Promise<{ data: ChatNotification[]; nextCursor: ChatCursor | null }>;
  readNotification(actor: ChatActor, notificationId: string): Promise<void>;
  setBlock(actor: ChatActor, userId: string, active: boolean): Promise<void>;
  report(
    actor: ChatActor,
    conversationId: string,
    messageId: string | undefined,
    reason: string,
  ): Promise<string>;
}
