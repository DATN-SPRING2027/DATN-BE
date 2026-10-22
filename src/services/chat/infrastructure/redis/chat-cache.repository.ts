import { createHash } from 'node:crypto';
import type {
  ChatActor,
  ChatRepository,
} from '../../application/chat.repository';
import { RedisService } from './redis.service';

const reads = new Set([
  'getConversation',
  'listConversations',
  'listMessages',
  'searchMessages',
  'messagesAround',
  'getPreferences',
  'getDraft',
  'searchAcross',
  'library',
  'receipts',
  'notifications',
]);
const unscopedReads = new Set([
  'listConversations',
  'searchAcross',
  'notifications',
]);
const historyReads = new Set([
  'listMessages',
  'searchMessages',
  'messagesAround',
  'library',
]);
const historyWrites = new Set([
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'setReaction',
  'pinMessage',
  'forwardMessage',
]);
const writes = new Set([
  'createDirect',
  'createRoom',
  'renameRoom',
  'addRoomMembers',
  'removeRoomMember',
  'leaveRoom',
  'createUpload',
  'completeUpload',
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'setReaction',
  'markRead',
  'markDelivered',
  'setPreferences',
  'saveDraft',
  'transferOwnership',
  'setManager',
  'pinMessage',
  'forwardMessage',
  'readNotification',
  'setBlock',
  'report',
]);

// Every cached result is actor/organization scoped; authorization runs before a hit.
export function cachedChatRepository(
  repository: ChatRepository,
  redis: RedisService,
  prefix: string,
): ChatRepository {
  return new Proxy(repository, {
    get(target, key, receiver) {
      const original: unknown = Reflect.get(target, key, receiver);
      if (typeof original !== 'function') return original;
      if (!reads.has(String(key)) && !writes.has(String(key)))
        return original.bind(target) as unknown;
      return async (...args: unknown[]) => {
        const actor = args[0] as ChatActor;
        const draft = String(key) === 'getDraft' || String(key) === 'saveDraft';
        const generation = draft
          ? `${prefix}:chat:draft-generation:${actor.organizationId}:${actor.id}:${String(args[1])}`
          : historyReads.has(String(key))
            ? `${prefix}:chat:history-version:${actor.organizationId}:${String(args[1])}`
            : `${prefix}:chat:cache-generation:${actor.organizationId}`;
        if (reads.has(String(key))) {
          if (
            !unscopedReads.has(String(key)) &&
            !(await target.isMember(actor, String(args[1])))
          ) {
            // Preserve the repository's structured membership error.
            return original.apply(target, args) as unknown;
          }
          const version = (await redis.get(generation)) ?? '0';
          const digest = createHash('sha256')
            .update(JSON.stringify(args))
            .digest('hex');
          const cacheKey = `${prefix}:chat:read:${String(key)}:${actor.organizationId}:${actor.id}:${version}:${digest}`;
          const cached = await redis.get(cacheKey);
          if (cached) {
            const result = JSON.parse(cached) as {
              data?: { id?: string; conversationId?: string }[];
              nextCursor?: { createdAt: string | Date };
            };
            if (result.nextCursor)
              result.nextCursor.createdAt = new Date(
                result.nextCursor.createdAt,
              );
            if (unscopedReads.has(String(key)) && result.data) {
              const permitted = await Promise.all(
                result.data.map((item) =>
                  target.isMember(
                    actor,
                    String(key) === 'listConversations'
                      ? String(item.id)
                      : String(item.conversationId),
                  ),
                ),
              );
              // Regenerate pagination from live membership instead of returning an incomplete page.
              if (permitted.some((value) => !value))
                return original.apply(target, args) as unknown;
            }
            return result;
          }
          const result: unknown = await original.apply(target, args);
          await redis.set(cacheKey, JSON.stringify(result), 15);
          return result;
        }
        const result: unknown = await original.apply(target, args);
        await redis.increment(generation, 86400);
        if (historyWrites.has(String(key)))
          await redis.increment(
            `${prefix}:chat:history-version:${actor.organizationId}:${String(args[1])}`,
            86400,
          );
        return result;
      };
    },
  });
}
