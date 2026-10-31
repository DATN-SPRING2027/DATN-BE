export type AiChatThreadDto = Readonly<{
  id: string;
  title: string;
  isBranched?: boolean;
  parentThreadId?: string | null;
  parentThreadTitle?: string | null;
  branchPointMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AiChatCitationDto = Readonly<{
  number: number;
  sourceId: string;
  sourceName?: string;
  documentId: string;
  sagDocumentId?: string;
  documentName?: string;
  chunkId?: string;
  sectionPath?: string;
  versionNo?: number;
  heading?: string;
  snippet?: string;
  label?: string;
  pageFrom?: number;
  pageTo?: number;
  mapped?: boolean;
  claimLevel?: 'claim' | 'run';
}>;

export type AiChatSessionCitationDto = Readonly<{
  ref: string;
  source: 'selected_group' | 'recent_continuity';
  groupId: string | null;
  turnIds: readonly string[];
  turnRange?: readonly [number, number];
  summaryExcerpt: string;
  mapped?: boolean;
  claimLevel?: 'claim' | 'run';
}>;

export type AiChatStepStatus = 'running' | 'completed' | 'failed';

export type AiChatRetrievalStepDto = Readonly<{
  id?: string;
  status?: AiChatStepStatus;
  kind: 'session_context' | 'tool' | 'thinking' | 'answer';
  label: string;
  durationMs: number;
  count?: number;
  mode?: string;
}>;

export type AiChatMessageDto = Readonly<{
  id: string;
  replyToMessageId?: string;
  regeneratedFromMessageId?: string;
  isInherited?: boolean;
  role: 'user' | 'assistant';
  content: string;
  status: 'ok' | 'failed' | 'cancelled';
  errorCode?: string;
  citations: readonly AiChatCitationDto[];
  sessionCitations: readonly AiChatSessionCitationDto[];
  retrievalSteps: readonly AiChatRetrievalStepDto[];
  createdAt: string;
}>;

export type AiChatMessagePageDto = Readonly<{
  items: readonly AiChatMessageDto[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

export type AiChatStartedEventData = Readonly<{
  runId: string;
  threadId: string;
  userMessageId?: string;
}>;

export type AiChatStepEventData = AiChatRetrievalStepDto;

export type AiChatDeltaEventData = Readonly<{
  text: string;
}>;

export type AiChatCompletedEventData = Readonly<{
  messageId: string;
  replyToMessageId?: string;
  regeneratedFromMessageId?: string;
  content: string;
  answerStatus: 'answered' | 'no_answer';
  citations: readonly AiChatCitationDto[];
  sessionCitations: readonly AiChatSessionCitationDto[];
  retrievalSteps: readonly AiChatRetrievalStepDto[];
}>;

export type AiChatFailedEventData = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  messageId?: string;
  replyToMessageId?: string;
  regeneratedFromMessageId?: string;
}>;

export type AiChatFeedbackRating = 'LIKE' | 'DISLIKE';

export const AI_CHAT_FEEDBACK_REASON_CATEGORIES = [
  'INACCURATE',
  'OUTDATED',
  'IRRELEVANT_CITATION',
  'INCOMPLETE',
  'OTHER',
] as const;

export type AiChatFeedbackReasonCategory =
  (typeof AI_CHAT_FEEDBACK_REASON_CATEGORIES)[number];

export type AiChatFeedbackInputDto = Readonly<{
  rating: AiChatFeedbackRating;
  reasonCategory?: AiChatFeedbackReasonCategory;
  reasonText?: string;
}>;

export type AiChatFeedbackDto = Readonly<{
  messageId: string;
  rating: AiChatFeedbackRating;
  reasonCategory?: AiChatFeedbackReasonCategory;
  reasonText?: string;
  updatedAt: string;
}>;

export type AiChatOwnFeedbackDto = Readonly<{
  feedback: AiChatFeedbackDto | null;
}>;

export type AiChatShareDto = Readonly<{
  id: string;
  projectId: string;
  messageId: string;
  createdAt: string;
}>;

export type AiChatSharedAnswerDto = Readonly<{
  share: AiChatShareDto;
  question: Readonly<{ content: string }>;
  answer: Readonly<{
    id: string;
    content: string;
    citations: readonly AiChatCitationDto[];
  }>;
}>;

export type PlatformAiFeedbackQueryDto = Readonly<{
  organizationId?: string;
  projectId?: string;
  rating?: AiChatFeedbackRating;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
}>;

export type PlatformAiFeedbackRowDto = Readonly<{
  id: string;
  organizationId: string;
  projectId: string;
  messageId: string;
  rating: AiChatFeedbackRating;
  reasonCategory?: AiChatFeedbackReasonCategory;
  reasonText?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type PlatformAiFeedbackPageDto = Readonly<{
  totals: Readonly<{ likes: number; dislikes: number }>;
  items: readonly PlatformAiFeedbackRowDto[];
  nextCursor: string | null;
}>;

export type AiChatMindMapStatus = 'ready' | 'empty' | 'uninitialized';

export type AiChatMindMapGenerationMode = 'llm' | 'outline_fallback' | 'none';

export type AiChatMindMapFallbackReason =
  'LLM_UNAVAILABLE' | 'LLM_INVALID_OUTPUT' | null;

export type AiChatMindMapInputDto = Readonly<{
  topic?: string;
  refresh?: boolean;
}>;

export type AiChatMindMapCoverageDto = Readonly<{
  accessibleReadyDocumentCount: number;
  usedDocumentCount: number;
  omittedDocumentCount: number;
  pendingDocumentCount: number;
  truncatedDocumentCount: number;
  evidenceUnitCount: number;
}>;

export type AiChatMindMapNodeDto = Readonly<{
  id: string;
  label: string;
  summary: string | null;
  citationNumbers: readonly number[];
  children: readonly AiChatMindMapNodeDto[];
}>;

export type AiChatMindMapResponseDto = Readonly<{
  projectId: string;
  topic: string | null;
  status: AiChatMindMapStatus;
  generationMode: AiChatMindMapGenerationMode;
  fallbackReason: AiChatMindMapFallbackReason;
  scopeFingerprint: string;
  cached: boolean;
  hasSourceUpdates: boolean;
  coverage: AiChatMindMapCoverageDto;
  tree: AiChatMindMapNodeDto | null;
  citations: readonly AiChatCitationDto[];
  generatedAt: string;
}>;

export type AiChatSseFrame =
  | Readonly<{ event: 'started'; data: AiChatStartedEventData }>
  | Readonly<{ event: 'step'; data: AiChatStepEventData }>
  | Readonly<{ event: 'delta'; data: AiChatDeltaEventData }>
  | Readonly<{ event: 'completed'; data: AiChatCompletedEventData }>
  | Readonly<{ event: 'failed'; data: AiChatFailedEventData }>;

export type AiChatRequestHeaders = Readonly<{
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  organizationId?: string;
  requestId?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = 4096): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function positiveInt(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }
  return undefined;
}

function nonNegativeInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return 0;
}

export function mapSagCitation(raw: unknown): AiChatCitationDto | null {
  if (!isRecord(raw)) return null;
  const number = positiveInt(raw.n ?? raw.number);
  const sourceId = nonEmptyString(raw.source_id ?? raw.sourceId, 128);
  const rawDocumentId = nonEmptyString(raw.document_id ?? raw.documentId, 128);
  const publicDocumentId = nonEmptyString(
    raw.public_document_id ?? raw.publicDocumentId,
    128,
  );
  const documentId = publicDocumentId ?? rawDocumentId;
  if (!number || !sourceId || !documentId) return null;
  const sagDocumentId =
    rawDocumentId && rawDocumentId !== documentId
      ? rawDocumentId
      : nonEmptyString(raw.sag_document_id ?? raw.sagDocumentId, 128);

  const sourceName = nonEmptyString(raw.source_name ?? raw.sourceName, 240);
  const documentName = nonEmptyString(
    raw.document_name ?? raw.documentName ?? raw.doc_name,
    240,
  );
  const chunkId = nonEmptyString(
    raw.chunk_id ?? raw.chunkId ?? raw.search_unit_id ?? raw.searchUnitId,
    128,
  );
  const sectionPath = nonEmptyString(raw.section_path ?? raw.sectionPath, 240);
  const versionNo = positiveInt(raw.version_no ?? raw.versionNo);
  const heading = nonEmptyString(raw.heading ?? raw.section, 240);
  const snippet = nonEmptyString(raw.snippet ?? raw.excerpt, 2400);
  const pageFrom = positiveInt(raw.page_from ?? raw.pageFrom);
  const pageTo = positiveInt(raw.page_to ?? raw.pageTo);
  const mapped = typeof raw.mapped === 'boolean' ? raw.mapped : undefined;
  const claimLevel =
    raw.claim_level === 'claim' || raw.claim_level === 'run'
      ? raw.claim_level
      : undefined;

  const labelParts = [documentName ?? sourceName, heading].filter(
    (part): part is string => Boolean(part),
  );
  const explicitLabel = nonEmptyString(raw.label, 300);
  const label =
    explicitLabel ??
    (labelParts.length > 0 ? labelParts.join(' · ') : undefined);

  return {
    number,
    sourceId,
    ...(sourceName ? { sourceName } : {}),
    documentId,
    ...(sagDocumentId ? { sagDocumentId } : {}),
    ...(documentName ? { documentName } : {}),
    ...(chunkId ? { chunkId } : {}),
    ...(sectionPath ? { sectionPath } : {}),
    ...(versionNo ? { versionNo } : {}),
    ...(heading ? { heading } : {}),
    ...(snippet ? { snippet } : {}),
    ...(label ? { label } : {}),
    ...(pageFrom ? { pageFrom } : {}),
    ...(pageTo ? { pageTo } : {}),
    ...(mapped !== undefined ? { mapped } : {}),
    ...(claimLevel ? { claimLevel } : {}),
  };
}

export function sanitizeContinuumActorHeaderName(rawName: string): string {
  const ascii = rawName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return ascii || 'Continuum user';
}

export function sanitizeContinuumActorDisplayName(rawName: string): string {
  const utf8 = rawName
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  if (!utf8 || !/[\p{L}\p{N}]/u.test(utf8)) {
    return 'Continuum user';
  }
  return utf8;
}

export type SessionCitationAuditHint = Readonly<{
  inferredSource?: 'selected_group' | 'recent_continuity';
  inferredGroupId?: string | null;
}>;

export function mapSagSessionCitation(
  raw: unknown,
  hint?: SessionCitationAuditHint,
): AiChatSessionCitationDto | null {
  if (!isRecord(raw)) return null;
  const ref = nonEmptyString(raw.ref, 16);
  if (!ref || !/^S[1-9]\d*$/.test(ref)) return null;

  const source =
    raw.source === 'selected_group' || raw.source === 'recent_continuity'
      ? raw.source
      : (hint?.inferredSource ?? 'selected_group');
  const groupIdRaw = raw.group_id ?? raw.groupId;
  const groupId =
    typeof groupIdRaw === 'string' && groupIdRaw.trim()
      ? groupIdRaw.trim().slice(0, 128)
      : groupIdRaw === null
        ? null
        : source === 'selected_group'
          ? (hint?.inferredGroupId ?? null)
          : null;

  const rawTurnIds = Array.isArray(raw.turn_ids)
    ? raw.turn_ids
    : Array.isArray(raw.turnIds)
      ? raw.turnIds
      : Array.isArray(raw.message_ids)
        ? raw.message_ids
        : Array.isArray(raw.messageIds)
          ? raw.messageIds
          : [];
  const parsedTurnIds = rawTurnIds
    .filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0,
    )
    .map((id) => id.trim().slice(0, 128));
  const primaryId = nonEmptyString(
    raw.primary_message_id ?? raw.primaryMessageId,
    128,
  );
  const turnIds = primaryId
    ? [
        primaryId,
        ...Array.from(new Set(parsedTurnIds.filter((id) => id !== primaryId))),
      ]
    : Array.from(new Set(parsedTurnIds));

  const rawRange = Array.isArray(raw.turn_range)
    ? raw.turn_range
    : Array.isArray(raw.turnRange)
      ? raw.turnRange
      : undefined;
  const rawOrdinals = Array.isArray(raw.turn_ordinals)
    ? raw.turn_ordinals
    : Array.isArray(raw.turnOrdinals)
      ? raw.turnOrdinals
      : undefined;
  const validOrdinals = rawOrdinals
    ? rawOrdinals.filter(
        (num): num is number =>
          typeof num === 'number' &&
          Number.isInteger(num) &&
          Number.isSafeInteger(num) &&
          num >= 0,
      )
    : [];
  const turnRange =
    rawRange &&
    rawRange.length === 2 &&
    typeof rawRange[0] === 'number' &&
    typeof rawRange[1] === 'number' &&
    Number.isInteger(rawRange[0]) &&
    Number.isInteger(rawRange[1]) &&
    rawRange[0] >= 0 &&
    rawRange[1] >= rawRange[0]
      ? ([rawRange[0], rawRange[1]] as const)
      : validOrdinals.length > 0
        ? ([Math.min(...validOrdinals), Math.max(...validOrdinals)] as const)
        : undefined;

  const explicitExcerpt = nonEmptyString(
    raw.summary_excerpt ?? raw.summaryExcerpt,
    600,
  );
  const rawEpistemic = nonEmptyString(
    raw.epistemic_status ?? raw.epistemicStatus,
    32,
  );
  const safeEpistemic =
    rawEpistemic &&
    /^[A-Z_]{2,24}$/.test(rawEpistemic) &&
    rawEpistemic !== 'INFO'
      ? rawEpistemic
      : undefined;
  const rangeLabel = turnRange
    ? turnRange[0] === turnRange[1]
      ? `Turn #${turnRange[0]}`
      : `Turns #${turnRange[0]}–#${turnRange[1]}`
    : undefined;
  const fallbackExcerpt =
    [rangeLabel, safeEpistemic]
      .filter((part): part is string => Boolean(part))
      .join(' · ') || 'Session conversation memory';
  const summaryExcerpt = explicitExcerpt ?? fallbackExcerpt;

  const mapped = typeof raw.mapped === 'boolean' ? raw.mapped : undefined;
  const claimLevel =
    raw.claim_level === 'claim' || raw.claim_level === 'run'
      ? raw.claim_level
      : undefined;

  return {
    ref,
    source,
    groupId,
    turnIds,
    ...(turnRange ? { turnRange } : {}),
    summaryExcerpt,
    ...(mapped !== undefined ? { mapped } : {}),
    ...(claimLevel ? { claimLevel } : {}),
  };
}

export function extractSanitizedStepsAndSessionCitations(rawSteps: unknown): {
  retrievalSteps: AiChatRetrievalStepDto[];
  sessionCitations: AiChatSessionCitationDto[];
} {
  const retrievalSteps: AiChatRetrievalStepDto[] = [];
  const sessionCitations: AiChatSessionCitationDto[] = [];

  if (!Array.isArray(rawSteps)) {
    return { retrievalSteps, sessionCitations };
  }

  for (const step of rawSteps) {
    if (!isRecord(step)) continue;
    const kind = step.kind;
    if (kind === 'session_context') {
      const mode = nonEmptyString(step.mode, 32);
      retrievalSteps.push({
        kind: 'session_context',
        label: 'Session Memory (ECCE)',
        durationMs: nonNegativeInt(step.ms ?? step.duration_ms),
        ...(mode ? { mode } : {}),
      });
      const selectedGroupTags = new Set<string>();
      let hasAuditTrace = false;
      if (isRecord(step.audit)) {
        if (Array.isArray(step.audit.selected_groups)) {
          hasAuditTrace = true;
          for (const grp of step.audit.selected_groups) {
            if (isRecord(grp) && typeof grp.citation_tag === 'string') {
              const tag = grp.citation_tag.trim();
              if (tag) selectedGroupTags.add(tag);
            }
          }
        }
        if (Array.isArray(step.audit.recent_turn_ids)) {
          hasAuditTrace = true;
        }
      }
      if (Array.isArray(step.session_citations)) {
        for (const sc of step.session_citations) {
          if (isRecord(sc) && sc.mapped === false) {
            continue;
          }
          const rawRef = isRecord(sc) ? nonEmptyString(sc.ref, 16) : undefined;
          const isSelectedGroup = Boolean(
            rawRef && selectedGroupTags.has(rawRef),
          );
          const inferredSource:
            'selected_group' | 'recent_continuity' | undefined = hasAuditTrace
            ? isSelectedGroup
              ? 'selected_group'
              : 'recent_continuity'
            : undefined;
          const mapped = mapSagSessionCitation(sc, {
            inferredSource,
            inferredGroupId: isSelectedGroup ? (rawRef ?? null) : null,
          });
          if (mapped) sessionCitations.push(mapped);
        }
      }
    } else if (kind === 'tool') {
      const label =
        nonEmptyString(step.label, 160) ??
        nonEmptyString(step.name, 120) ??
        'Knowledge Retrieval';
      const count =
        typeof step.count === 'number' &&
        Number.isInteger(step.count) &&
        step.count >= 0
          ? step.count
          : undefined;
      const hasError =
        (typeof step.error === 'string' && step.error.trim().length > 0) ||
        isRecord(step.error);
      retrievalSteps.push({
        ...(hasError ? { status: 'failed' } : {}),
        kind: 'tool',
        label,
        durationMs: nonNegativeInt(step.ms ?? step.duration_ms),
        ...(count !== undefined ? { count } : {}),
      });
    } else if (kind === 'thinking') {
      retrievalSteps.push({
        kind: 'thinking',
        label: 'Reasoning',
        durationMs: nonNegativeInt(step.ms ?? step.duration_ms),
      });
    } else if (kind === 'answer') {
      retrievalSteps.push({
        kind: 'answer',
        label: 'Answer Synthesis',
        durationMs: nonNegativeInt(step.ms ?? step.duration_ms),
      });
    }
  }

  return { retrievalSteps, sessionCitations };
}

export function mapSagThread(raw: unknown): AiChatThreadDto | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id, 128);
  const createdAt = nonEmptyString(raw.created_at ?? raw.createdAt, 64);
  const updatedAt = nonEmptyString(raw.updated_at ?? raw.updatedAt, 64);
  if (!id || !createdAt || !updatedAt) return null;
  const title = nonEmptyString(raw.title, 200) ?? 'New chat';

  const rawIsBranched = 'is_branched' in raw ? raw.is_branched : raw.isBranched;
  const rawParentThreadId =
    'parent_thread_id' in raw ? raw.parent_thread_id : raw.parentThreadId;
  const rawParentThreadTitle =
    'parent_thread_title' in raw
      ? raw.parent_thread_title
      : raw.parentThreadTitle;
  const rawBranchPointMessageId =
    'branch_point_message_id' in raw
      ? raw.branch_point_message_id
      : raw.branchPointMessageId;

  const hasParentIdField = rawParentThreadId !== undefined;
  const parentThreadId =
    rawParentThreadId === null
      ? null
      : (nonEmptyString(rawParentThreadId, 128) ?? null);
  const hasParentTitleField = rawParentThreadTitle !== undefined;
  const parentThreadTitle =
    rawParentThreadTitle === null
      ? null
      : (nonEmptyString(rawParentThreadTitle, 200) ?? null);
  const hasBranchPointField = rawBranchPointMessageId !== undefined;
  const branchPointMessageId =
    rawBranchPointMessageId === null
      ? null
      : (nonEmptyString(rawBranchPointMessageId, 128) ?? null);
  const isBranched =
    typeof rawIsBranched === 'boolean'
      ? rawIsBranched
      : typeof branchPointMessageId === 'string'
        ? true
        : undefined;

  return {
    id,
    title,
    ...(isBranched !== undefined ? { isBranched } : {}),
    ...(hasParentIdField ? { parentThreadId } : {}),
    ...(hasParentTitleField ? { parentThreadTitle } : {}),
    ...(hasBranchPointField ? { branchPointMessageId } : {}),
    createdAt,
    updatedAt,
  };
}

const WHITELISTED_MESSAGE_ERROR_CODES = new Set<string>([
  'SEARCH_UNAVAILABLE',
  'LLM_TIMEOUT',
  'LLM_RATE_LIMIT',
  'LLM_UNAVAILABLE',
  'CONFIGURATION_ERROR',
  'STREAM_INTERRUPTED',
  'STREAM_ERROR',
]);

export function mapSagMessage(raw: unknown): AiChatMessageDto | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id, 128);
  const role =
    raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
  const createdAt = nonEmptyString(raw.created_at ?? raw.createdAt, 64);
  if (!id || !role || !createdAt) return null;

  const replyToMessageId = nonEmptyString(
    raw.reply_to_message_id ?? raw.replyToMessageId,
    128,
  );
  const regeneratedFromMessageId = nonEmptyString(
    raw.regenerated_from_message_id ?? raw.regeneratedFromMessageId,
    128,
  );
  const rawIsInherited = raw.is_inherited ?? raw.isInherited;
  const isInherited =
    typeof rawIsInherited === 'boolean' ? rawIsInherited : undefined;
  const content = typeof raw.content === 'string' ? raw.content : '';
  const status =
    raw.status === 'failed' || raw.status === 'cancelled' ? raw.status : 'ok';
  const rawErrorCode =
    status === 'failed' &&
    isRecord(raw.error) &&
    typeof raw.error.code === 'string'
      ? raw.error.code.trim().toUpperCase()
      : undefined;
  const errorCode =
    rawErrorCode && WHITELISTED_MESSAGE_ERROR_CODES.has(rawErrorCode)
      ? rawErrorCode
      : undefined;
  const citations = Array.isArray(raw.citations)
    ? raw.citations
        .map(mapSagCitation)
        .filter((item): item is AiChatCitationDto => item !== null)
    : [];
  const { retrievalSteps, sessionCitations } =
    extractSanitizedStepsAndSessionCitations(raw.steps);

  return {
    id,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(regeneratedFromMessageId ? { regeneratedFromMessageId } : {}),
    ...(isInherited !== undefined ? { isInherited } : {}),
    role,
    content,
    status,
    ...(errorCode ? { errorCode } : {}),
    citations,
    sessionCitations,
    retrievalSteps,
    createdAt,
  };
}

function isFeedbackRating(value: unknown): value is AiChatFeedbackRating {
  return value === 'LIKE' || value === 'DISLIKE';
}

function isFeedbackReasonCategory(
  value: unknown,
): value is AiChatFeedbackReasonCategory {
  return (
    typeof value === 'string' &&
    (AI_CHAT_FEEDBACK_REASON_CATEGORIES as readonly string[]).includes(value)
  );
}

export function mapSagFeedback(raw: unknown): AiChatFeedbackDto | null {
  if (!isRecord(raw)) return null;
  const messageId = nonEmptyString(raw.message_id ?? raw.messageId, 64);
  const rating = isFeedbackRating(raw.rating) ? raw.rating : null;
  const updatedAt = nonEmptyString(raw.updated_at ?? raw.updatedAt, 64);
  if (!messageId || !rating || !updatedAt) return null;

  const rawCategory = raw.reason_category ?? raw.reasonCategory;
  const reasonCategory = isFeedbackReasonCategory(rawCategory)
    ? rawCategory
    : undefined;
  const rawReasonText = raw.reason_text ?? raw.reasonText;
  const reasonText = nonEmptyString(rawReasonText, 1000);

  return {
    messageId,
    rating,
    ...(reasonCategory ? { reasonCategory } : {}),
    ...(reasonText ? { reasonText } : {}),
    updatedAt,
  };
}

export function mapSagOwnFeedback(raw: unknown): AiChatOwnFeedbackDto | null {
  if (!isRecord(raw)) return null;
  if (raw.feedback === null || raw.feedback === undefined) {
    return { feedback: null };
  }
  const mapped = mapSagFeedback(raw.feedback);
  if (!mapped) return null;
  return { feedback: mapped };
}

export function mapSagShare(raw: unknown): AiChatShareDto | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id, 64);
  const projectId = nonEmptyString(raw.project_id ?? raw.projectId, 64);
  const messageId = nonEmptyString(raw.message_id ?? raw.messageId, 64);
  const createdAt = nonEmptyString(raw.created_at ?? raw.createdAt, 64);
  if (!id || !projectId || !messageId || !createdAt) return null;
  return { id, projectId, messageId, createdAt };
}

export function mapSagSharedAnswer(raw: unknown): AiChatSharedAnswerDto | null {
  if (!isRecord(raw)) return null;
  const share = mapSagShare(raw.share);
  const questionRec = isRecord(raw.question) ? raw.question : null;
  const answerRec = isRecord(raw.answer) ? raw.answer : null;
  if (!share || !questionRec || !answerRec) return null;

  const answerId = nonEmptyString(answerRec.id, 64);
  if (
    !answerId ||
    typeof questionRec.content !== 'string' ||
    typeof answerRec.content !== 'string'
  ) {
    return null;
  }

  const citations = Array.isArray(answerRec.citations)
    ? answerRec.citations
        .map(mapSagCitation)
        .filter((item): item is AiChatCitationDto => item !== null)
    : [];

  return {
    share,
    question: { content: questionRec.content },
    answer: {
      id: answerId,
      content: answerRec.content,
      citations,
    },
  };
}

export function mapSagAdminFeedbackPage(
  raw: unknown,
): PlatformAiFeedbackPageDto | null {
  if (!isRecord(raw) || !isRecord(raw.totals) || !Array.isArray(raw.items)) {
    return null;
  }
  const likes = nonNegativeInt(raw.totals.likes);
  const dislikes = nonNegativeInt(raw.totals.dislikes);

  const items: PlatformAiFeedbackRowDto[] = [];
  for (const rawRow of raw.items) {
    if (!isRecord(rawRow)) return null;
    const id = nonEmptyString(rawRow.id, 64);
    const organizationId = nonEmptyString(
      rawRow.organization_id ?? rawRow.organizationId,
      64,
    );
    const projectId = nonEmptyString(rawRow.project_id ?? rawRow.projectId, 64);
    const messageId = nonEmptyString(rawRow.message_id ?? rawRow.messageId, 64);
    const rating = isFeedbackRating(rawRow.rating) ? rawRow.rating : null;
    const createdAt = nonEmptyString(rawRow.created_at ?? rawRow.createdAt, 64);
    const updatedAt = nonEmptyString(rawRow.updated_at ?? rawRow.updatedAt, 64);
    if (
      !id ||
      !organizationId ||
      !projectId ||
      !messageId ||
      !rating ||
      !createdAt ||
      !updatedAt
    ) {
      return null;
    }
    const rawCategory = rawRow.reason_category ?? rawRow.reasonCategory;
    const reasonCategory = isFeedbackReasonCategory(rawCategory)
      ? rawCategory
      : undefined;
    const reasonText = nonEmptyString(
      rawRow.reason_text ?? rawRow.reasonText,
      1000,
    );
    items.push({
      id,
      organizationId,
      projectId,
      messageId,
      rating,
      ...(reasonCategory ? { reasonCategory } : {}),
      ...(reasonText ? { reasonText } : {}),
      createdAt,
      updatedAt,
    });
  }

  const rawCursor = raw.next_cursor ?? raw.nextCursor;
  const nextCursor =
    typeof rawCursor === 'string' && rawCursor.trim()
      ? rawCursor.trim().slice(0, 1024)
      : null;

  return {
    totals: { likes, dislikes },
    items,
    nextCursor,
  };
}

const SAFE_MIND_MAP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MIND_MAP_DEPTH = 3;
const MAX_MIND_MAP_CHILDREN = 8;
const MAX_MIND_MAP_TOTAL_NODES = 60;

function nonNegativeSafeInteger(value: unknown): number | null {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  return null;
}

function mapSagMindMapNode(
  raw: unknown,
  depth: number,
  validCitationNumbers: ReadonlySet<number>,
  state: { count: number; seenIds: Set<string> },
): AiChatMindMapNodeDto | null {
  if (!isRecord(raw) || depth > MAX_MIND_MAP_DEPTH) {
    return null;
  }
  state.count += 1;
  if (state.count > MAX_MIND_MAP_TOTAL_NODES) {
    return null;
  }

  const id = nonEmptyString(raw.id, 64);
  const label = nonEmptyString(raw.label, 80);
  if (
    !id ||
    !SAFE_MIND_MAP_ID_PATTERN.test(id) ||
    state.seenIds.has(id) ||
    !label
  ) {
    return null;
  }
  state.seenIds.add(id);

  let summary: string | null = null;
  if (raw.summary !== null && raw.summary !== undefined) {
    if (typeof raw.summary !== 'string') return null;
    summary = nonEmptyString(raw.summary, 320) ?? null;
  }

  const rawCitationNumbers = raw.citationNumbers ?? raw.citation_numbers;
  if (!Array.isArray(rawCitationNumbers)) return null;
  const citationNumbers: number[] = [];
  const seenCites = new Set<number>();
  for (const num of rawCitationNumbers) {
    const parsed = positiveInt(num);
    if (!parsed || !validCitationNumbers.has(parsed)) {
      return null;
    }
    if (!seenCites.has(parsed)) {
      seenCites.add(parsed);
      citationNumbers.push(parsed);
    }
  }

  if (
    !Array.isArray(raw.children) ||
    raw.children.length > MAX_MIND_MAP_CHILDREN
  ) {
    return null;
  }
  if (depth === MAX_MIND_MAP_DEPTH && raw.children.length > 0) {
    return null;
  }
  const children: AiChatMindMapNodeDto[] = [];
  for (const rawChild of raw.children) {
    const child = mapSagMindMapNode(
      rawChild,
      depth + 1,
      validCitationNumbers,
      state,
    );
    if (!child) return null;
    children.push(child);
  }

  return {
    id,
    label,
    summary,
    citationNumbers,
    children,
  };
}

export function mapSagMindMapResponse(
  raw: unknown,
): AiChatMindMapResponseDto | null {
  if (!isRecord(raw)) return null;

  const projectId = nonEmptyString(raw.projectId ?? raw.project_id, 64);
  if (!projectId || !SAFE_MIND_MAP_ID_PATTERN.test(projectId)) return null;

  let topic: string | null = null;
  if (raw.topic !== null && raw.topic !== undefined) {
    if (typeof raw.topic !== 'string') return null;
    topic = nonEmptyString(raw.topic, 200) ?? null;
  }

  const status =
    raw.status === 'ready' ||
    raw.status === 'empty' ||
    raw.status === 'uninitialized'
      ? raw.status
      : null;
  const rawMode = raw.generationMode ?? raw.generation_mode;
  const generationMode =
    rawMode === 'llm' || rawMode === 'outline_fallback' || rawMode === 'none'
      ? rawMode
      : null;
  if (!status || !generationMode) return null;

  const rawFallbackReason = raw.fallbackReason ?? raw.fallback_reason ?? null;
  if (
    rawFallbackReason !== null &&
    rawFallbackReason !== 'LLM_UNAVAILABLE' &&
    rawFallbackReason !== 'LLM_INVALID_OUTPUT'
  ) {
    return null;
  }
  const fallbackReason: AiChatMindMapFallbackReason = rawFallbackReason;

  if (raw.cached !== undefined && typeof raw.cached !== 'boolean') {
    return null;
  }
  const cached = raw.cached === true;

  const rawHasSourceUpdates =
    raw.hasSourceUpdates ?? raw.has_source_updates ?? undefined;
  if (
    rawHasSourceUpdates !== undefined &&
    typeof rawHasSourceUpdates !== 'boolean'
  ) {
    return null;
  }
  const hasSourceUpdates = rawHasSourceUpdates === true;

  const rawFingerprint = raw.scopeFingerprint ?? raw.scope_fingerprint;
  if (
    typeof rawFingerprint !== 'string' ||
    rawFingerprint.trim().length < 16 ||
    rawFingerprint.trim().length > 128
  ) {
    return null;
  }
  const scopeFingerprint = rawFingerprint.trim();

  if (!isRecord(raw.coverage)) return null;
  const accessibleReadyDocumentCount = nonNegativeSafeInteger(
    raw.coverage.accessibleReadyDocumentCount ??
      raw.coverage.accessible_ready_document_count,
  );
  const usedDocumentCount = nonNegativeSafeInteger(
    raw.coverage.usedDocumentCount ?? raw.coverage.used_document_count,
  );
  const omittedDocumentCount = nonNegativeSafeInteger(
    raw.coverage.omittedDocumentCount ?? raw.coverage.omitted_document_count,
  );
  const pendingDocumentCount = nonNegativeSafeInteger(
    raw.coverage.pendingDocumentCount ?? raw.coverage.pending_document_count,
  );
  const truncatedDocumentCount = nonNegativeSafeInteger(
    raw.coverage.truncatedDocumentCount ??
      raw.coverage.truncated_document_count,
  );
  const evidenceUnitCount = nonNegativeSafeInteger(
    raw.coverage.evidenceUnitCount ?? raw.coverage.evidence_unit_count,
  );
  if (
    accessibleReadyDocumentCount === null ||
    usedDocumentCount === null ||
    omittedDocumentCount === null ||
    pendingDocumentCount === null ||
    truncatedDocumentCount === null ||
    evidenceUnitCount === null
  ) {
    return null;
  }

  if (!Array.isArray(raw.citations)) return null;
  const citations: AiChatCitationDto[] = [];
  const validCitationNumbers = new Set<number>();
  for (const rawCite of raw.citations) {
    const mappedCite = mapSagCitation(rawCite);
    if (!mappedCite || validCitationNumbers.has(mappedCite.number)) {
      return null;
    }
    validCitationNumbers.add(mappedCite.number);
    citations.push(mappedCite);
  }

  const generatedAt = nonEmptyString(raw.generatedAt ?? raw.generated_at, 64);
  if (!generatedAt) return null;

  let tree: AiChatMindMapNodeDto | null = null;
  if (status === 'empty' || status === 'uninitialized') {
    if (
      generationMode !== 'none' ||
      fallbackReason !== null ||
      raw.tree !== null ||
      citations.length > 0 ||
      cached ||
      hasSourceUpdates
    ) {
      return null;
    }
  } else {
    if (
      (generationMode !== 'llm' && generationMode !== 'outline_fallback') ||
      raw.tree === null ||
      raw.tree === undefined
    ) {
      return null;
    }
    if (generationMode === 'llm' && fallbackReason !== null) {
      return null;
    }
    tree = mapSagMindMapNode(raw.tree, 0, validCitationNumbers, {
      count: 0,
      seenIds: new Set<string>(),
    });
    if (!tree) return null;
  }

  return {
    projectId,
    topic,
    status,
    generationMode,
    fallbackReason,
    scopeFingerprint,
    cached,
    hasSourceUpdates,
    coverage: {
      accessibleReadyDocumentCount,
      usedDocumentCount,
      omittedDocumentCount,
      pendingDocumentCount,
      truncatedDocumentCount,
      evidenceUnitCount,
    },
    tree,
    citations,
    generatedAt,
  };
}
