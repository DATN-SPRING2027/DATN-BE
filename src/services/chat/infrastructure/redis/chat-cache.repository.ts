import { createHash } from 'node:crypto';
import { pageNeedsAssistantReEnrichment } from '../../application/chat-dm-assistant.types';
import type {
  ChatActor,
  ChatMessage,
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
const messagePageReads = new Set([
  'listMessages',
  'searchMessages',
  'messagesAround',
  'library',
  'searchAcross',
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

interface CachedPageShape {
  data?: { id?: string; conversationId?: string }[];
  nextCursor?: { createdAt: string | Date } | null;
}

interface VersionedMessagePageEnvelope {
  __v: 2;
  contextRevisions: Record<string, number>;
  payload: CachedPageShape;
}

function isVersionedEnvelope(
  value: unknown,
): value is VersionedMessagePageEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__v === 2 &&
    typeof (value as Record<string, unknown>).contextRevisions === 'object' &&
    (value as Record<string, unknown>).contextRevisions !== null &&
    typeof (value as Record<string, unknown>).payload === 'object' &&
    (value as Record<string, unknown>).payload !== null
  );
}

function resolveScopedConversationId(
  keyName: string,
  args: unknown[],
): string | undefined {
  if (!unscopedReads.has(keyName)) {
    return typeof args[1] === 'string' && args[1].length > 0
      ? args[1]
      : undefined;
  }
  if (keyName === 'searchAcross') {
    const filters = args[1];
    if (
      typeof filters === 'object' &&
      filters !== null &&
      !Array.isArray(filters) &&
      typeof (filters as { conversationId?: unknown }).conversationId ===
        'string'
    ) {
      return (filters as { conversationId: string }).conversationId;
    }
  }
  return undefined;
}

function extractConversationIdsFromPage(
  page: CachedPageShape | undefined,
): string[] {
  if (!Array.isArray(page?.data)) return [];
  return [
    ...new Set(
      page.data
        .map((item) =>
          typeof item?.conversationId === 'string' ? item.conversationId : '',
        )
        .filter((convId) => convId.length > 0),
    ),
  ];
}

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
      const keyName = String(key);
      if (!reads.has(keyName) && !writes.has(keyName))
        return original.bind(target) as unknown;
      return async (...args: unknown[]) => {
        const actor = args[0] as ChatActor;
        const draft = keyName === 'getDraft' || keyName === 'saveDraft';
        const generation = draft
          ? `${prefix}:chat:draft-generation:${actor.organizationId}:${actor.id}:${String(args[1])}`
          : historyReads.has(keyName)
            ? `${prefix}:chat:history-version:${actor.organizationId}:${String(args[1])}`
            : `${prefix}:chat:cache-generation:${actor.organizationId}`;
        if (reads.has(keyName)) {
          if (
            !unscopedReads.has(keyName) &&
            !(await target.isMember(actor, String(args[1])))
          ) {
            // Preserve the repository's structured membership error.
            return original.apply(target, args) as unknown;
          }
          const isMessagePageRead = messagePageReads.has(keyName);
          const canCheckRevisions =
            isMessagePageRead &&
            typeof target.getConversationContextRevisions === 'function';
          const scopedConvId = isMessagePageRead
            ? resolveScopedConversationId(keyName, args)
            : undefined;

          const writeCacheEntry = async (
            cacheKey: string | undefined,
            value: unknown,
            preCapturedRevisions?: Map<string, number>,
          ): Promise<void> => {
            if (!cacheKey) return;
            try {
              if (canCheckRevisions) {
                const pageValue = value as CachedPageShape | undefined;
                const convIds = scopedConvId
                  ? [scopedConvId]
                  : extractConversationIdsFromPage(pageValue);
                let revisionsMap = preCapturedRevisions;
                if (
                  !revisionsMap ||
                  convIds.some((cid) => !revisionsMap!.has(cid))
                ) {
                  revisionsMap =
                    convIds.length > 0
                      ? await target.getConversationContextRevisions!(
                          actor,
                          convIds,
                        )
                      : new Map<string, number>();
                }
                if (convIds.every((cid) => revisionsMap.has(cid))) {
                  const envelope: VersionedMessagePageEnvelope = {
                    __v: 2,
                    contextRevisions: Object.fromEntries(revisionsMap),
                    payload: pageValue ?? {},
                  };
                  await redis.set(cacheKey, JSON.stringify(envelope), 15);
                }
                return;
              }
              await redis.set(cacheKey, JSON.stringify(value), 15);
            } catch {
              // Cache write failures must never break persisted reads.
            }
          };

          let cacheKey: string | undefined;
          let cached: string | null = null;
          try {
            const version = (await redis.get(generation)) ?? '0';
            const digest = createHash('sha256')
              .update(JSON.stringify(args))
              .digest('hex');
            cacheKey = `${prefix}:chat:read:${keyName}:${actor.organizationId}:${actor.id}:${version}:${digest}`;
            cached = await redis.get(cacheKey);
          } catch {
            // Soft-degrade to MongoDB when Redis is unavailable.
          }

          let preFetchRevisions: Map<string, number> | undefined;
          if (canCheckRevisions && scopedConvId && cacheKey) {
            preFetchRevisions = await target.getConversationContextRevisions!(
              actor,
              [scopedConvId],
            );
          }

          if (cached) {
            let result: CachedPageShape | undefined;
            let cachedRevisions: Record<string, number> | undefined;
            try {
              const parsed = JSON.parse(cached) as unknown;
              if (isVersionedEnvelope(parsed)) {
                cachedRevisions = parsed.contextRevisions;
                result = parsed.payload;
              } else if (
                typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed)
              ) {
                result = parsed;
              }
            } catch {
              result = undefined;
            }
            if (result) {
              if (result.nextCursor)
                result.nextCursor.createdAt = new Date(
                  result.nextCursor.createdAt,
                );
              if (unscopedReads.has(keyName) && result.data) {
                const permitted = await Promise.all(
                  result.data.map((item) =>
                    target.isMember(
                      actor,
                      keyName === 'listConversations'
                        ? String(item.id)
                        : String(item.conversationId),
                    ),
                  ),
                );
                // Regenerate pagination from live membership instead of returning an incomplete page.
                if (permitted.some((value) => !value))
                  return original.apply(target, args) as unknown;
              }
              if (isMessagePageRead && Array.isArray(result.data)) {
                let staleByRevision = false;
                if (canCheckRevisions) {
                  const convIdsToCheck = scopedConvId
                    ? [scopedConvId]
                    : extractConversationIdsFromPage(result);
                  if (cachedRevisions === undefined) {
                    staleByRevision = true;
                  } else if (convIdsToCheck.length > 0) {
                    const liveRevisions =
                      scopedConvId && preFetchRevisions
                        ? preFetchRevisions
                        : await target.getConversationContextRevisions!(
                            actor,
                            convIdsToCheck,
                          );
                    staleByRevision = !convIdsToCheck.every(
                      (cid) =>
                        typeof cachedRevisions[cid] === 'number' &&
                        liveRevisions.has(cid) &&
                        liveRevisions.get(cid) === cachedRevisions[cid],
                    );
                  }
                }
                if (staleByRevision) {
                  // Authoritative contextRevision mismatch: bypass stale cache and re-populate from MongoDB.
                  const fresh: unknown = await original.apply(target, args);
                  await writeCacheEntry(cacheKey, fresh, preFetchRevisions);
                  return fresh;
                }
                const cachedMessages = result.data as ChatMessage[];
                const needsReconcile =
                  pageNeedsAssistantReEnrichment(cachedMessages) ||
                  (!scopedConvId && cachedMessages.length > 0);
                if (needsReconcile) {
                  if (typeof target.reconcileCachedMessages === 'function') {
                    const convId = unscopedReads.has(keyName)
                      ? undefined
                      : String(args[1]);
                    result.data = await target.reconcileCachedMessages(
                      actor,
                      convId,
                      cachedMessages,
                    );
                  } else if (pageNeedsAssistantReEnrichment(cachedMessages)) {
                    return original.apply(target, args) as unknown;
                  }
                }
              }
              return result;
            }
          }
          const result: unknown = await original.apply(target, args);
          await writeCacheEntry(cacheKey, result, preFetchRevisions);
          return result;
        }
        const result: unknown = await original.apply(target, args);
        try {
          await redis.increment(generation, 86400);
          if (historyWrites.has(keyName)) {
            await redis.increment(
              `${prefix}:chat:history-version:${actor.organizationId}:${String(args[1])}`,
              86400,
            );
          }
        } catch {
          // Cache invalidation failures must never fail persisted writes.
        }
        return result;
      };
    },
  });
}
