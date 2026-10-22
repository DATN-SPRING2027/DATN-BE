import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  ChatConversationPage,
  ChatDeliveryState,
  ChatMessagePage,
  ChatMessageWrite,
  ChatReadState,
  ChatUpload,
  ChatRepository,
} from '../../application/chat.repository';

@Injectable()
export class UnavailableChatRepository implements ChatRepository {
  private unavailable(): Promise<never> {
    return Promise.reject(
      new ServiceUnavailableException({
        code: 'CHAT_PERSISTENCE_UNAVAILABLE',
        message: 'Chat storage is not enabled.',
      }),
    );
  }

  getConversation(): Promise<never> {
    return this.unavailable();
  }
  getPreferences(): Promise<never> {
    return this.unavailable();
  }
  setPreferences(): Promise<never> {
    return this.unavailable();
  }
  getDraft(): Promise<never> {
    return this.unavailable();
  }
  saveDraft(): Promise<never> {
    return this.unavailable();
  }
  transferOwnership(): Promise<never> {
    return this.unavailable();
  }
  setManager(): Promise<never> {
    return this.unavailable();
  }
  searchAcross(): Promise<never> {
    return this.unavailable();
  }
  library(): Promise<never> {
    return this.unavailable();
  }
  pinMessage(): Promise<never> {
    return this.unavailable();
  }
  forwardMessage(): Promise<never> {
    return this.unavailable();
  }
  receipts(): Promise<never> {
    return this.unavailable();
  }
  notifications(): Promise<never> {
    return this.unavailable();
  }
  readNotification(): Promise<never> {
    return this.unavailable();
  }
  setBlock(): Promise<never> {
    return this.unavailable();
  }
  report(): Promise<never> {
    return this.unavailable();
  }

  listConversations(): Promise<ChatConversationPage> {
    return this.unavailable();
  }

  createDirect(): Promise<string> {
    return this.unavailable();
  }

  createRoom(): Promise<string> {
    return this.unavailable();
  }

  renameRoom(): Promise<string[]> {
    return this.unavailable();
  }

  addRoomMembers(): Promise<string[]> {
    return this.unavailable();
  }

  removeRoomMember(): Promise<string[]> {
    return this.unavailable();
  }

  leaveRoom(): Promise<string[]> {
    return this.unavailable();
  }

  listMessages(): Promise<ChatMessagePage> {
    return this.unavailable();
  }

  searchMessages(): Promise<ChatMessagePage> {
    return this.unavailable();
  }

  messagesAround(): Promise<ChatMessagePage> {
    return this.unavailable();
  }

  createUpload(): Promise<void> {
    return this.unavailable();
  }

  getUpload(): Promise<ChatUpload | null> {
    return this.unavailable();
  }

  completeUpload(): Promise<ChatUpload | null> {
    return this.unavailable();
  }

  getAttachmentObject(): Promise<{
    provider: 'S3' | 'R2';
    objectKey: string;
    name: string;
    contentType: string;
    kind: 'IMAGE' | 'DOCUMENT';
  } | null> {
    return this.unavailable();
  }

  markDelivered(): Promise<ChatDeliveryState> {
    return this.unavailable();
  }

  sendMessage(): Promise<ChatMessageWrite> {
    return this.unavailable();
  }

  editMessage(): Promise<ChatMessageWrite> {
    return this.unavailable();
  }

  deleteMessage(): Promise<ChatMessageWrite> {
    return this.unavailable();
  }

  setReaction(): Promise<ChatMessageWrite> {
    return this.unavailable();
  }

  markRead(): Promise<ChatReadState> {
    return this.unavailable();
  }

  isMember(): Promise<boolean> {
    return this.unavailable();
  }

  memberIds(): Promise<string[]> {
    return this.unavailable();
  }

  directContactIds(): Promise<Set<string>> {
    return this.unavailable();
  }
}
