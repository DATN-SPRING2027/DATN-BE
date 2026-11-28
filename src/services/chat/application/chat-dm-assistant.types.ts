import type { ConfigService } from '@nestjs/config';
import {
  CONTINUUM_AI_DISPLAY_NAME,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
} from '../infrastructure/mongodb/mongodb.schemas';

export {
  CONTINUUM_AI_DISPLAY_NAME,
  CONTINUUM_AI_HANDLE,
  CONTINUUM_AI_SENDER_ID,
};

export const CHAT_ORG_MEMBERSHIP_CHECKER = Symbol(
  'CHAT_ORG_MEMBERSHIP_CHECKER',
);

export const DEFAULT_DM_ASSISTANT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const DM_ASSISTANT_SAG_ANSWER_PATH =
  '/api/v1/internal/dm-assistant/answer';

export type ChatMessageAuthorType = 'USER' | 'ASSISTANT';

export type ChatAssistantStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CANCELLED'
  | 'FAILED';

export type ChatAssistantPostedStatus = 'COMPLETED' | 'INSUFFICIENT_EVIDENCE';

export type ChatAssistantFailureCode =
  | 'SOURCE_CHANGED'
  | 'TRIGGER_DELETED'
  | 'ACCESS_REVOKED'
  | 'SERVICE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_MODEL_OUTPUT';

export type ChatAssistantQueryMode = 'TIME_WINDOW' | 'KEYWORD' | 'HYBRID';

export type ChatAssistantSourceStatus = 'ACTIVE' | 'EDITED' | 'DELETED';

export type ChatAssistantSourceAggregateState =
  'FRESH' | 'HAS_EDITED' | 'HAS_DELETED' | 'HAS_EDITED_AND_DELETED';

export interface ChatConversationCapabilities {
  dmAssistantEnabled: boolean;
}

export interface ChatAssistantMentionNormalized {
  handle: typeof CONTINUUM_AI_HANDLE;
  query: string;
  timezone: string;
  maxAttempts?: number;
}

export interface ChatAssistantSourceReference {
  refId: string;
  messageId: string;
  senderName: string;
  createdAt: string;
  quoteSnippet: string;
  status: ChatAssistantSourceStatus;
}

export interface ChatAssistantMeta {
  handle: typeof CONTINUUM_AI_HANDLE;
  queryMode: ChatAssistantQueryMode;
  partialCoverage: boolean;
  coverageNote: string | null;
  sourceState: ChatAssistantSourceAggregateState;
}

export interface ChatAssistantJobState {
  jobId: string;
  status: ChatAssistantStatus;
  failureCode: ChatAssistantFailureCode | null;
  responseMessageId: string | null;
  updatedAt: string;
}

export interface AssistantStatusEvent {
  conversationId: string;
  triggerMessageId: string;
  jobId: string;
  status: ChatAssistantStatus;
  failureCode: ChatAssistantFailureCode | null;
  responseMessageId: string | null;
  updatedAt: string;
}

export interface ChatOrgMembershipChecker {
  isActiveOrganizationMember(
    organizationId: string,
    userId: string,
  ): Promise<boolean>;
}

export interface SagDmAssistantMessageInput {
  refId: string;
  senderLabel: string;
  sentAtIso: string;
  text: string;
}

export interface SagDmAssistantAnswerRequest {
  question: string;
  timezone: string;
  referenceNowIso: string;
  queryMode: ChatAssistantQueryMode;
  partialCoverage: boolean;
  coverageHint: string | null;
  messages: SagDmAssistantMessageInput[];
}

export interface SagDmAssistantUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
}

export interface SagDmAssistantAnswerResponse {
  status: 'ANSWERED' | 'INSUFFICIENT_EVIDENCE';
  answerText: string;
  citedRefIds: string[];
  coverageNote: string | null;
  model: string | null;
  usage: SagDmAssistantUsage;
}

export function readBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

export function readBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function isDmAssistantAvailable(config?: ConfigService): boolean {
  if (!config) return false;
  const enabled =
    readBooleanFlag(config.get<unknown>('CHAT_DM_ASSISTANT_ENABLED')) === true;
  if (!enabled) return false;
  const sagApiBaseUrl = config.get<string>('SAG_API_BASE_URL')?.trim();
  const sagServiceToken = config.get<string>('SAG_BFF_SERVICE_TOKEN')?.trim();
  return Boolean(sagApiBaseUrl) && Boolean(sagServiceToken);
}

export function isDmAssistantWorkerEnabled(config?: ConfigService): boolean {
  if (!config) return false;
  const workerOverride = readBooleanFlag(
    config.get<unknown>('CHAT_DM_ASSISTANT_WORKER_ENABLED'),
  );
  if (workerOverride !== undefined) return workerOverride;
  return (
    readBooleanFlag(config.get<unknown>('CHAT_DM_ASSISTANT_ENABLED')) === true
  );
}

export function isValidIanaTimezone(timezone: string): boolean {
  const trimmed = timezone.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

export function extractAssistantQuery(
  content: string,
  explicitQuery?: string,
): string {
  if (explicitQuery !== undefined) {
    return explicitQuery.trim();
  }
  return content
    .replace(/(^|\s)@continuumAI\b[:,\s-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function computeSourceAggregateState(
  references: readonly Pick<ChatAssistantSourceReference, 'status'>[],
): ChatAssistantSourceAggregateState {
  let hasEdited = false;
  let hasDeleted = false;
  for (const ref of references) {
    if (ref.status === 'EDITED') hasEdited = true;
    else if (ref.status === 'DELETED') hasDeleted = true;
  }
  if (hasEdited && hasDeleted) return 'HAS_EDITED_AND_DELETED';
  if (hasDeleted) return 'HAS_DELETED';
  if (hasEdited) return 'HAS_EDITED';
  return 'FRESH';
}

export interface AssistantCacheCheckMessage {
  authorType?: string;
  senderId?: string;
  sourceReferences?: readonly unknown[];
  assistantState?: { status?: string } | null;
}

export function messageNeedsAssistantReEnrichment(
  message: AssistantCacheCheckMessage | null | undefined,
): boolean {
  if (!message || typeof message !== 'object') return false;
  const isAssistantWithRefs =
    (message.authorType === 'ASSISTANT' ||
      message.senderId === CONTINUUM_AI_SENDER_ID) &&
    Array.isArray(message.sourceReferences) &&
    message.sourceReferences.length > 0;
  if (isAssistantWithRefs) return true;

  const stateStatus = message.assistantState?.status;
  return stateStatus === 'PENDING' || stateStatus === 'PROCESSING';
}

export function pageNeedsAssistantReEnrichment(
  messages: readonly AssistantCacheCheckMessage[] | undefined,
): boolean {
  return (
    Array.isArray(messages) && messages.some(messageNeedsAssistantReEnrichment)
  );
}
