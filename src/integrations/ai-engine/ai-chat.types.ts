export type AiChatThreadDto = Readonly<{
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}>;

export type AiChatCitationDto = Readonly<{
  number: number;
  sourceId: string;
  sourceName?: string;
  documentId: string;
  documentName?: string;
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

export type AiChatRetrievalStepDto = Readonly<{
  kind: 'session_context' | 'tool' | 'thinking' | 'answer';
  label: string;
  durationMs: number;
  count?: number;
  mode?: string;
}>;

export type AiChatMessageDto = Readonly<{
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'ok' | 'failed' | 'cancelled';
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
  const documentId = nonEmptyString(raw.document_id ?? raw.documentId, 128);
  if (!number || !sourceId || !documentId) return null;

  const sourceName = nonEmptyString(raw.source_name ?? raw.sourceName, 240);
  const documentName = nonEmptyString(
    raw.document_name ?? raw.documentName ?? raw.doc_name,
    240,
  );
  const versionNo = positiveInt(raw.version_no ?? raw.versionNo);
  const heading = nonEmptyString(raw.heading ?? raw.section, 240);
  const snippet = nonEmptyString(raw.snippet ?? raw.excerpt, 1200);
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
    ...(documentName ? { documentName } : {}),
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
      retrievalSteps.push({
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
  return { id, title, createdAt, updatedAt };
}

export function mapSagMessage(raw: unknown): AiChatMessageDto | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id, 128);
  const role =
    raw.role === 'user' || raw.role === 'assistant' ? raw.role : null;
  const createdAt = nonEmptyString(raw.created_at ?? raw.createdAt, 64);
  if (!id || !role || !createdAt) return null;

  const content = typeof raw.content === 'string' ? raw.content : '';
  const status =
    raw.status === 'failed' || raw.status === 'cancelled' ? raw.status : 'ok';
  const citations = Array.isArray(raw.citations)
    ? raw.citations
        .map(mapSagCitation)
        .filter((item): item is AiChatCitationDto => item !== null)
    : [];
  const { retrievalSteps, sessionCitations } =
    extractSanitizedStepsAndSessionCitations(raw.steps);

  return {
    id,
    role,
    content,
    status,
    citations,
    sessionCitations,
    retrievalSteps,
    createdAt,
  };
}
