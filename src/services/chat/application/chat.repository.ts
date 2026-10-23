export const CHAT_REPOSITORY = Symbol('CHAT_REPOSITORY');
import type { ChatFeatureRepository } from './chat-features';

export interface ChatActor {
  id: string;
  organizationId: string;
  name: string;
  avatarUrl: string | null;
}

export interface ChatCandidate {
  id: string;
  fullName: string;
  email?: string;
  avatarUrl: string | null;
  isOnline?: boolean;
}

export interface ChatCursor {
  isPinned?: boolean;
  createdAt: Date;
  id: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: 'IMAGE' | 'DOCUMENT';
}

export interface ChatUpload {
  id: string;
  conversationId: string;
  uploaderId: string;
  name: string;
  contentType: string;
  size: number;
  kind: 'IMAGE' | 'DOCUMENT';
  provider: 'S3' | 'R2';
  objectKey: string;
  status: 'PENDING' | 'READY' | 'ATTACHED';
  expiresAt: Date;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  content: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  reactions: ChatMessageReaction[];
  replyToMessageId: string | null;
  replyTo: ChatReplyPreview | null;
  attachments: ChatAttachment[];
  mentionUserIds?: string[];
  isPinned?: boolean;
  forwardedFrom?: { senderName: string } | null;
}

export interface ChatReplyPreview {
  id: string;
  senderName: string;
  preview: string;
  deleted: boolean;
}

export interface ChatMessageReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface ChatParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'MANAGER' | 'MEMBER';
  lastReadMessageId: string | null;
  lastReadAt: string | null;
  lastDeliveredMessageId: string | null;
  lastDeliveredAt: string | null;
  isOnline?: boolean;
}

export interface ChatConversation {
  id: string;
  type: 'DIRECT' | 'ROOM';
  title: string | null;
  createdBy: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  lastMessageSenderId: string | null;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
  unreadCount: number;
  members: ChatParticipant[];
  isPinned?: boolean;
  isArchived?: boolean;
  notificationMode?: 'ALL' | 'MENTIONS' | 'NONE';
  markedUnread?: boolean;
}

export interface ChatConversationPage {
  data: ChatConversation[];
  hasMore: boolean;
  nextCursor: ChatCursor | null;
}

export interface ChatMessagePage {
  data: ChatMessage[];
  hasMore: boolean;
  nextCursor: ChatCursor | null;
}

export interface ChatMessageWrite {
  message: ChatMessage;
  recipientIds: string[];
}

export interface ChatReadState {
  conversationId: string;
  userId: string;
  lastReadMessageId: string;
  lastReadAt: string;
}

export interface ChatDeliveryState {
  conversationId: string;
  userId: string;
  lastDeliveredMessageId: string;
  lastDeliveredAt: string;
}

export interface ChatRepository extends ChatFeatureRepository {
  getConversation(
    actor: ChatActor,
    conversationId: string,
  ): Promise<ChatConversation | null>;
  listConversations(
    actor: ChatActor,
    limit: number,
    before?: ChatCursor,
    search?: string,
    archived?: boolean,
    conversationId?: string,
  ): Promise<ChatConversationPage>;
  createDirect(actor: ChatActor, recipient: ChatCandidate): Promise<string>;
  createRoom(
    actor: ChatActor,
    title: string,
    recipients: ChatCandidate[],
    clientRoomId: string,
  ): Promise<string>;
  renameRoom(
    actor: ChatActor,
    conversationId: string,
    title: string,
  ): Promise<string[]>;
  addRoomMembers(
    actor: ChatActor,
    conversationId: string,
    members: ChatCandidate[],
  ): Promise<string[]>;
  removeRoomMember(
    actor: ChatActor,
    conversationId: string,
    userId: string,
  ): Promise<string[]>;
  leaveRoom(actor: ChatActor, conversationId: string): Promise<string[]>;
  listMessages(
    actor: ChatActor,
    conversationId: string,
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage>;
  searchMessages(
    actor: ChatActor,
    conversationId: string,
    query: string,
    limit: number,
    before?: ChatCursor,
  ): Promise<ChatMessagePage>;
  messagesAround(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    limit: number,
  ): Promise<ChatMessagePage>;
  createUpload(actor: ChatActor, upload: ChatUpload): Promise<void>;
  getUpload(
    actor: ChatActor,
    conversationId: string,
    uploadId: string,
  ): Promise<ChatUpload | null>;
  completeUpload(
    actor: ChatActor,
    conversationId: string,
    uploadId: string,
  ): Promise<ChatUpload | null>;
  getAttachmentObject(
    actor: ChatActor,
    conversationId: string,
    attachmentId: string,
  ): Promise<Pick<
    ChatUpload,
    'provider' | 'objectKey' | 'name' | 'contentType' | 'kind'
  > | null>;
  markDelivered(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatDeliveryState>;
  sendMessage(
    actor: ChatActor,
    conversationId: string,
    clientMessageId: string,
    content: string,
    attachments?: string[],
    replyToMessageId?: string,
    mentionUserIds?: string[],
  ): Promise<ChatMessageWrite>;
  editMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    content: string,
    mentionUserIds?: string[],
  ): Promise<ChatMessageWrite>;
  deleteMessage(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatMessageWrite>;
  setReaction(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ): Promise<ChatMessageWrite>;
  markRead(
    actor: ChatActor,
    conversationId: string,
    messageId: string,
  ): Promise<ChatReadState>;
  isMember(actor: ChatActor, conversationId: string): Promise<boolean>;
  memberIds(actor: ChatActor, conversationId: string): Promise<string[]>;
  directContactIds(actor: ChatActor, targetIds: string[]): Promise<Set<string>>;
}
