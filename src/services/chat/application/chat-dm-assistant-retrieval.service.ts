import { Injectable, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, type Model, type PipelineStage, Types } from 'mongoose';
import { CHAT_SEARCH_INDEX } from '../../../common/search/indexed-search';
import { normalizeSearchText } from '../../../common/search/literal-search';
import { CHAT_PERSISTENCE } from '../infrastructure/persistence';
import { CONTINUUM_AI_SENDER_ID } from '../infrastructure/mongodb/mongodb.schemas';
import type { MessageDocument } from '../infrastructure/mongodb/mongo-chat.repository';
import {
  DEFAULT_DM_ASSISTANT_TIMEZONE,
  isValidIanaTimezone,
  type ChatAssistantQueryMode,
} from './chat-dm-assistant.types';

const MODEL_PREFIX = `${CHAT_PERSISTENCE.databaseName}_`;
const MAX_SINGLE_MESSAGE_CHARS = 1200;
const MAX_QUOTE_SNIPPET_CHARS = 160;
const MAX_KEYWORD_CANDIDATES = 25;
const MAX_NEIGHBOR_SEEDS = 15;
const NEIGHBOR_RADIUS = 2;
const FOLDED_FALLBACK_SCAN_LIMIT = 500;

const CODE_TOKEN_PATTERN = /\b[a-z]{2,12}[-_]\d{1,8}\b/gi;

const STOPWORDS = new Set([
  // Vietnamese (diacritic-folded)
  'hom',
  'qua',
  'nay',
  'kia',
  'tuan',
  'truoc',
  'ngay',
  'thang',
  'nam',
  'gan',
  'day',
  'hai',
  'nguoi',
  'chung',
  'ta',
  'minh',
  'ban',
  'anh',
  'chi',
  'em',
  'chot',
  'nhung',
  'gi',
  'la',
  'khi',
  'nao',
  'cua',
  've',
  'co',
  'khong',
  'duoc',
  'the',
  'tom',
  'tat',
  'noi',
  'trao',
  'doi',
  'ban',
  'hoi',
  'cho',
  'biet',
  'voi',
  'trong',
  'hay',
  'hoac',
  'va',
  'cac',
  'mot',
  'nhieu',
  'nhe',
  'nha',
  'roi',
  'chua',
  'da',
  'dang',
  'se',
  'de',
  'den',
  'tu',
  'tai',
  'nhu',
  'bao',
  'nhieu',
  'ai',
  'dau',
  'sao',
  'giup',
  'xem',
  'lai',
  'tin',
  'nhan',
  'cuoc',
  'tro',
  'chuyen',
  'hoi',
  'thoai',
  // English
  'the',
  'what',
  'when',
  'where',
  'who',
  'how',
  'which',
  'did',
  'does',
  'do',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'we',
  'you',
  'they',
  'our',
  'your',
  'about',
  'for',
  'of',
  'in',
  'on',
  'at',
  'to',
  'from',
  'and',
  'or',
  'with',
  'last',
  'past',
  'this',
  'days',
  'day',
  'week',
  'yesterday',
  'today',
  'before',
  'summary',
  'summarize',
  'recap',
  'agree',
  'agreed',
  'decide',
  'decided',
  'decision',
  'decisions',
  'talk',
  'talked',
  'discuss',
  'discussed',
  'please',
  'tell',
  'me',
  'us',
]);

const TIME_WINDOW_GENERIC_WORDS = new Set([
  'thong',
  'nhat',
  'thao',
  'luan',
  'bac',
  'dong',
  'quyet',
  'dinh',
  'ket',
  'noi',
  'dung',
  'cong',
  'viec',
  'dau',
  'chinh',
  'quan',
  'trong',
  'key',
  'points',
  'main',
  'topics',
  'action',
  'items',
]);

export interface ParsedTimeWindow {
  from: Date;
  to: Date;
  label: string;
}

export interface ParsedAssistantQuery {
  queryMode: ChatAssistantQueryMode;
  timeWindow: ParsedTimeWindow | null;
  codes: string[];
  keywords: string[];
  searchText: string;
}

export interface RetrievedMessageSnapshot {
  refId: string;
  messageId: Types.ObjectId;
  senderName: string;
  createdAt: Date;
  sourceVersion: number;
  sourceEditedAtMs: number | null;
  quoteSnippet: string;
  textForSag: string;
}

export interface DmAssistantRetrievalResult {
  queryMode: ChatAssistantQueryMode;
  retrievalPath: string;
  candidateCount: number;
  partialCoverage: boolean;
  coverageHint: string | null;
  messages: RetrievedMessageSnapshot[];
}

export interface RetrieveDmContextInput {
  organizationId: Types.ObjectId;
  conversationId: Types.ObjectId;
  triggerMessageId: Types.ObjectId;
  triggerCreatedAt: Date;
  question: string;
  timezone: string;
  maxMessages: number;
  maxChars: number;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayIndex: number; // 0 = Sun, 1 = Mon, ..., 6 = Sat
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getLocalDateParts(date: Date, timezone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const valueOf = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    year: Number(valueOf('year')),
    month: Number(valueOf('month')),
    day: Number(valueOf('day')),
    hour: Number(valueOf('hour')) % 24,
    minute: Number(valueOf('minute')),
    second: Number(valueOf('second')),
    weekdayIndex: WEEKDAY_MAP[valueOf('weekday')] ?? 0,
  };
}

function addLocalDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function localMidnightToUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  let guessMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const parts = getLocalDateParts(new Date(guessMs), timezone);
    const localAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const desiredAsUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const diffMs = desiredAsUtcMs - localAsUtcMs;
    if (diffMs === 0) break;
    guessMs += diffMs;
  }
  return new Date(guessMs);
}

function localDayBounds(
  year: number,
  month: number,
  day: number,
  timezone: string,
): { from: Date; to: Date } {
  const from = localMidnightToUtc(year, month, day, timezone);
  const nextDay = addLocalDays(year, month, day, 1);
  const nextMidnight = localMidnightToUtc(
    nextDay.year,
    nextDay.month,
    nextDay.day,
    timezone,
  );
  return { from, to: new Date(nextMidnight.getTime() - 1) };
}

function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() + 1 === month &&
    check.getUTCDate() === day
  );
}

export function parseAssistantQuery(
  question: string,
  timezone: string,
  referenceNow: Date,
): ParsedAssistantQuery {
  const safeTz = isValidIanaTimezone(timezone)
    ? timezone
    : DEFAULT_DM_ASSISTANT_TIMEZONE;
  const normalized = normalizeSearchText(question);
  const anchor = getLocalDateParts(referenceNow, safeTz);

  let timeWindow: ParsedTimeWindow | null = null;
  let stripped = normalized;

  const consumeMatch = (
    regex: RegExp,
    build: (match: RegExpExecArray) => ParsedTimeWindow | null,
  ): boolean => {
    const match = regex.exec(stripped);
    if (!match) return false;
    const built = build(match);
    if (!built) return false;
    timeWindow = built;
    stripped = stripped.replace(match[0], ' ').replace(/\s+/g, ' ').trim();
    return true;
  };

  // 1. Explicit ISO date YYYY-MM-DD
  if (
    !consumeMatch(/\b(20\d{2})-(\d{2})-(\d{2})\b/, (m) => {
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (!isValidCalendarDate(year, month, day)) return null;
      const bounds = localDayBounds(year, month, day, safeTz);
      return { ...bounds, label: `${year}-${m[2]}-${m[3]}` };
    })
  ) {
    // 2. Explicit Vietnamese dd/mm[/yyyy]
    consumeMatch(
      /(?:^|\s)(?:ngay\s+)?(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?(?=\s|$|[.,?!])/,
      (m) => {
        const day = Number(m[1]);
        const month = Number(m[2]);
        let year = m[3] ? Number(m[3]) : anchor.year;
        if (!isValidCalendarDate(year, month, day)) return null;
        let bounds = localDayBounds(year, month, day, safeTz);
        if (
          !m[3] &&
          bounds.from.getTime() > referenceNow.getTime() + 7 * 86_400_000
        ) {
          year -= 1;
          if (!isValidCalendarDate(year, month, day)) return null;
          bounds = localDayBounds(year, month, day, safeTz);
        }
        return { ...bounds, label: `${day}/${month}/${year}` };
      },
    );
  }

  // 3. Relative Vietnamese / English expressions
  if (!timeWindow) {
    consumeMatch(/\b(?:hom kia|day before yesterday)\b/, () => {
      const target = addLocalDays(anchor.year, anchor.month, anchor.day, -2);
      return {
        ...localDayBounds(target.year, target.month, target.day, safeTz),
        label: 'hom_kia',
      };
    });
  }
  if (!timeWindow) {
    consumeMatch(/\b(?:hom qua|ngay hom qua|yesterday)\b/, () => {
      const target = addLocalDays(anchor.year, anchor.month, anchor.day, -1);
      return {
        ...localDayBounds(target.year, target.month, target.day, safeTz),
        label: 'hom_qua',
      };
    });
  }
  if (!timeWindow) {
    consumeMatch(/\b(?:hom nay|ngay hom nay|today)\b/, () => {
      const from = localMidnightToUtc(
        anchor.year,
        anchor.month,
        anchor.day,
        safeTz,
      );
      return { from, to: referenceNow, label: 'hom_nay' };
    });
  }
  if (!timeWindow) {
    consumeMatch(/\b(?:tuan truoc|last week)\b/, () => {
      // ISO week: Monday = 1 ... Sunday = 0 (offset 6)
      const daysSinceMonday = (anchor.weekdayIndex + 6) % 7;
      const lastMonday = addLocalDays(
        anchor.year,
        anchor.month,
        anchor.day,
        -(daysSinceMonday + 7),
      );
      const thisMonday = addLocalDays(
        anchor.year,
        anchor.month,
        anchor.day,
        -daysSinceMonday,
      );
      const from = localMidnightToUtc(
        lastMonday.year,
        lastMonday.month,
        lastMonday.day,
        safeTz,
      );
      const to = new Date(
        localMidnightToUtc(
          thisMonday.year,
          thisMonday.month,
          thisMonday.day,
          safeTz,
        ).getTime() - 1,
      );
      return { from, to, label: 'tuan_truoc' };
    });
  }
  if (!timeWindow) {
    consumeMatch(/\b(?:tuan nay|this week)\b/, () => {
      const daysSinceMonday = (anchor.weekdayIndex + 6) % 7;
      const thisMonday = addLocalDays(
        anchor.year,
        anchor.month,
        anchor.day,
        -daysSinceMonday,
      );
      const from = localMidnightToUtc(
        thisMonday.year,
        thisMonday.month,
        thisMonday.day,
        safeTz,
      );
      return { from, to: referenceNow, label: 'tuan_nay' };
    });
  }
  if (!timeWindow) {
    consumeMatch(
      /\b(?:(\d{1,2})\s+ngay\s+(?:qua|gan day|vua qua)|(?:last|past)\s+(\d{1,2})\s+days?)\b/,
      (m) => {
        const days = Number(m[1] ?? m[2]);
        if (!Number.isInteger(days) || days < 1 || days > 90) return null;
        const startDay = addLocalDays(
          anchor.year,
          anchor.month,
          anchor.day,
          -days,
        );
        const from = localMidnightToUtc(
          startDay.year,
          startDay.month,
          startDay.day,
          safeTz,
        );
        return { from, to: referenceNow, label: `last_${days}_days` };
      },
    );
  }

  // Extract explicit ticket/task codes (e.g. PAY-123, E2E-EDIT-401)
  const rawCodes = [
    ...new Set(
      (normalized.match(CODE_TOKEN_PATTERN) ?? []).map((code) =>
        code.toLowerCase(),
      ),
    ),
  ];

  // Extract remaining substantive keyword tokens
  const rawTokens = stripped
    .split(/[^a-z0-9_-]+/g)
    .map((token) => token.replace(/^[-_]+|[-_]+$/g, ''))
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));

  const keywords = [...new Set([...rawCodes, ...rawTokens])];
  const topicKeywordsForWindow = rawTokens.filter(
    (token) => !TIME_WINDOW_GENERIC_WORDS.has(token),
  );
  const hasTopicKeywords =
    rawCodes.length > 0 || topicKeywordsForWindow.length > 0;

  let queryMode: ChatAssistantQueryMode;
  if (timeWindow && !hasTopicKeywords) {
    queryMode = 'TIME_WINDOW';
  } else if (timeWindow && hasTopicKeywords) {
    queryMode = 'HYBRID';
  } else {
    queryMode = 'KEYWORD';
  }

  const searchText =
    keywords.length > 0 ? keywords.join(' ') : stripped || normalized;

  return {
    queryMode,
    timeWindow,
    codes: rawCodes,
    keywords,
    searchText,
  };
}

function buildMongoTextSearchQuery(parsed: ParsedAssistantQuery): string {
  const parts: string[] = [];
  for (const code of parsed.codes) {
    // Quote hyphenated codes so MongoDB $text does not interpret '-123' as negation.
    parts.push(`"${code}"`);
  }
  for (const token of parsed.keywords) {
    if (parsed.codes.includes(token)) continue;
    const sanitized = token.replace(/["\\]/g, '').replace(/^-+/, '');
    if (!sanitized) continue;
    if (sanitized.includes('-')) {
      parts.push(`"${sanitized}"`);
    } else {
      parts.push(sanitized);
    }
  }
  if (parts.length === 0) {
    return parsed.searchText.replace(/["\\]/g, '').replace(/(^|\s)-+/g, '$1');
  }
  return parts.join(' ');
}

function isAtlasSearchUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: number; codeName?: string; message?: string };
  if (err.code === 31082 || err.code === 40324 || err.code === 291) return true;
  const msg = String(err.message ?? '');
  return /\$search|SearchNotEnabled|unrecognized pipeline stage|Atlas Search|index.*not found/i.test(
    msg,
  );
}

function isTextIndexUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: number; message?: string };
  if (err.code === 27 || err.code === 291) return true;
  return /text index required/i.test(String(err.message ?? ''));
}

function scoreFoldedMessage(
  content: string,
  parsed: ParsedAssistantQuery,
): number {
  const folded = normalizeSearchText(content);
  if (!folded) return 0;

  const msgTokens = new Set(
    folded
      .split(/[^a-z0-9_-]+/g)
      .map((t) => t.replace(/^[-_]+|[-_]+$/g, ''))
      .filter((t) => t.length >= 2),
  );

  let score = 0;
  let codeMatches = 0;
  for (const code of parsed.codes) {
    if (folded.includes(code)) {
      score += 12;
      codeMatches += 1;
    }
  }

  let tokenMatches = 0;
  let strongTokenMatches = 0;
  const nonCodeKeywords = parsed.keywords.filter(
    (token) => !parsed.codes.includes(token),
  );
  for (const token of nonCodeKeywords) {
    if (msgTokens.has(token)) {
      tokenMatches += 1;
      if (token.length >= 4) {
        strongTokenMatches += 1;
        score += 3;
      } else {
        score += 2;
      }
    }
  }

  // Bigram phrase bonus
  for (let i = 0; i < nonCodeKeywords.length - 1; i += 1) {
    const bigram = `${nonCodeKeywords[i]} ${nonCodeKeywords[i + 1]}`;
    if (folded.includes(bigram)) {
      score += 4;
    }
  }

  if (parsed.codes.length > 0) {
    if (codeMatches === 0 && strongTokenMatches < 2) {
      return 0;
    }
    return score;
  }

  if (nonCodeKeywords.length === 0) return 0;
  if (nonCodeKeywords.length === 1) {
    return tokenMatches >= 1 ? score : 0;
  }
  return strongTokenMatches >= 1 || tokenMatches >= 2 ? score : 0;
}

function buildQuoteSnippet(content: string): string {
  const collapsed = content.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= MAX_QUOTE_SNIPPET_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_QUOTE_SNIPPET_CHARS - 1)}…`;
}

function compareChronological(a: MessageDocument, b: MessageDocument): number {
  const diff = a.createdAt.getTime() - b.createdAt.getTime();
  if (diff !== 0) return diff;
  return String(a._id).localeCompare(String(b._id));
}

@Injectable()
export class DmAssistantRetrievalService {
  private readonly messagesModel?: Model<MessageDocument>;

  constructor(
    @Optional()
    @InjectConnection(CHAT_PERSISTENCE.databaseName)
    connection?: Connection,
  ) {
    if (connection && typeof connection.model === 'function') {
      try {
        this.messagesModel = connection.model<MessageDocument>(
          `${MODEL_PREFIX}chat_conversation_messages`,
        );
      } catch {
        this.messagesModel = undefined;
      }
    }
  }

  async retrieveContext(
    input: RetrieveDmContextInput,
    messagesModelOverride?: Model<MessageDocument>,
  ): Promise<DmAssistantRetrievalResult> {
    const model = messagesModelOverride ?? this.messagesModel;
    if (!model) {
      throw new Error('Chat messages model is unavailable for retrieval.');
    }

    const parsed = parseAssistantQuery(
      input.question,
      input.timezone,
      input.triggerCreatedAt,
    );
    const maxMessages = Math.min(80, Math.max(1, input.maxMessages));
    const maxChars = Math.min(24_000, Math.max(1000, input.maxChars));

    // Mandatory pre-retrieval eligibility filter: strictly scoped to this DM & human non-deleted text messages.
    const baseFilter: Record<string, unknown> = {
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      deletedAt: null,
      authorType: { $ne: 'ASSISTANT' },
      senderId: { $ne: CONTINUUM_AI_SENDER_ID },
      _id: { $ne: input.triggerMessageId },
      createdAt: { $lte: input.triggerCreatedAt },
      content: { $type: 'string', $ne: '' },
    };

    const effectiveTimeFilter = parsed.timeWindow
      ? {
          createdAt: {
            $gte: parsed.timeWindow.from,
            $lte: new Date(
              Math.min(
                parsed.timeWindow.to.getTime(),
                input.triggerCreatedAt.getTime(),
              ),
            ),
          },
        }
      : null;

    let partialCoverage = false;
    let retrievalPath = 'TIME_WINDOW';
    let candidateCount = 0;
    let selectedDocs: MessageDocument[] = [];
    const hitPriorityIds = new Set<string>();

    if (parsed.queryMode === 'TIME_WINDOW' && effectiveTimeFilter) {
      const rows = await model
        .find({ ...baseFilter, ...effectiveTimeFilter })
        .sort({ createdAt: -1, _id: -1 })
        .limit(maxMessages + 1)
        .lean()
        .exec();
      if (rows.length > maxMessages) {
        partialCoverage = true;
      }
      candidateCount = rows.length;
      selectedDocs = rows.slice(0, maxMessages).reverse();
    } else {
      const scopedFilter = effectiveTimeFilter
        ? { ...baseFilter, ...effectiveTimeFilter }
        : baseFilter;

      const keywordResult = await this.searchKeywordCandidates(
        model,
        input,
        parsed,
        scopedFilter,
        effectiveTimeFilter,
      );
      retrievalPath = keywordResult.retrievalPath;
      candidateCount = keywordResult.candidateCount;
      if (keywordResult.partialCoverage) {
        partialCoverage = true;
      }

      const hits = keywordResult.hits;
      for (const hit of hits) {
        hitPriorityIds.add(String(hit._id));
      }

      if (hits.length > 0) {
        const expanded = await this.expandNeighbors(
          model,
          scopedFilter,
          hits.slice(0, MAX_NEIGHBOR_SEEDS),
        );
        const byId = new Map<string, MessageDocument>();
        for (const doc of [...hits, ...expanded]) {
          byId.set(String(doc._id), doc);
        }
        selectedDocs = [...byId.values()].sort(compareChronological);
      }
    }

    // Filter out whitespace-only messages
    selectedDocs = selectedDocs.filter((doc) => doc.content.trim().length > 0);

    // Enforce count & character budgets
    const budgeted = this.applyContextBudget(
      selectedDocs,
      hitPriorityIds,
      maxMessages,
      maxChars,
    );
    if (budgeted.truncated) {
      partialCoverage = true;
    }

    const snapshots: RetrievedMessageSnapshot[] = budgeted.items.map(
      (item, index) => ({
        refId: `M${index + 1}`,
        messageId: item.doc._id,
        senderName: item.doc.senderName.trim().slice(0, 120) || 'Member',
        createdAt: item.doc.createdAt,
        sourceVersion: Math.max(0, Math.round(item.doc.contentVersion ?? 0)),
        sourceEditedAtMs: item.doc.editedAt
          ? item.doc.editedAt.getTime()
          : null,
        quoteSnippet: buildQuoteSnippet(item.doc.content),
        textForSag: item.textForSag,
      }),
    );

    const coverageHint = partialCoverage
      ? parsed.queryMode === 'TIME_WINDOW'
        ? 'Khoảng thời gian có nhiều tin nhắn vượt giới hạn ngữ cảnh; kết quả chỉ bao quát phần tin nhắn gần nhất trong giới hạn xử lý.'
        : 'Ngữ cảnh truy xuất chỉ bao quát một phần lịch sử hoặc một số tin nhắn dài đã được rút gọn trong giới hạn xử lý.'
      : null;

    return {
      queryMode: parsed.queryMode,
      retrievalPath,
      candidateCount,
      partialCoverage,
      coverageHint,
      messages: snapshots,
    };
  }

  private async searchKeywordCandidates(
    model: Model<MessageDocument>,
    input: RetrieveDmContextInput,
    parsed: ParsedAssistantQuery,
    scopedFilter: Record<string, unknown>,
    effectiveTimeFilter: { createdAt: { $gte: Date; $lte: Date } } | null,
  ): Promise<{
    hits: MessageDocument[];
    retrievalPath: string;
    candidateCount: number;
    partialCoverage: boolean;
  }> {
    // 1. Primary path: MongoDB Atlas Search ($search on chat_search_v1)
    let atlasSearchRan = false;
    try {
      const filterClauses: Record<string, unknown>[] = [
        { equals: { path: 'organizationId', value: input.organizationId } },
        { equals: { path: 'conversationId', value: input.conversationId } },
      ];
      if (effectiveTimeFilter) {
        filterClauses.push({
          range: {
            path: 'createdAt',
            gte: effectiveTimeFilter.createdAt.$gte,
            lte: effectiveTimeFilter.createdAt.$lte,
          },
        });
      }
      const shouldClauses: Record<string, unknown>[] = [];
      for (const code of parsed.codes) {
        shouldClauses.push({
          phrase: {
            path: 'content',
            query: code,
            score: { boost: { value: 6 } },
          },
        });
      }
      if (parsed.searchText) {
        shouldClauses.push({
          text: {
            path: 'content',
            query: parsed.searchText,
            matchCriteria: 'any',
          },
        });
      }
      if (shouldClauses.length > 0) {
        const pipeline: PipelineStage[] = [
          {
            $search: {
              index: CHAT_SEARCH_INDEX,
              compound: {
                filter: filterClauses,
                should: shouldClauses,
                minimumShouldMatch: 1,
              },
            },
          },
          { $match: scopedFilter },
          { $addFields: { _searchScore: { $meta: 'searchScore' } } },
          { $sort: { _searchScore: -1, createdAt: -1, _id: -1 } },
          { $limit: MAX_KEYWORD_CANDIDATES },
        ];
        const rows = await model.aggregate<MessageDocument>(pipeline).exec();
        atlasSearchRan = true;
        const filteredRows =
          parsed.codes.length > 0
            ? rows.filter((row) => scoreFoldedMessage(row.content, parsed) > 0)
            : rows;
        if (filteredRows.length > 0) {
          return {
            hits: filteredRows,
            retrievalPath: 'ATLAS_SEARCH',
            candidateCount: filteredRows.length,
            partialCoverage: false,
          };
        }
      }
    } catch (error) {
      if (!isAtlasSearchUnavailableError(error)) {
        throw error;
      }
    }

    // 2. Fallback 1: MongoDB $text on conversationId_1_content_text
    const textQuery = buildMongoTextSearchQuery(parsed);
    let textHits: MessageDocument[] = [];
    let textSucceeded = false;
    if (textQuery.trim().length > 0) {
      try {
        const rows = await model
          .find(
            { ...scopedFilter, $text: { $search: textQuery } },
            { score: { $meta: 'textScore' } },
          )
          .sort({ score: { $meta: 'textScore' }, createdAt: -1, _id: -1 })
          .limit(MAX_KEYWORD_CANDIDATES)
          .lean()
          .exec();
        textSucceeded = true;
        textHits = rows.filter(
          (row) => scoreFoldedMessage(row.content, parsed) > 0,
        );
      } catch (error) {
        if (!isTextIndexUnavailableError(error)) {
          throw error;
        }
      }
    }

    if (textHits.length > 0) {
      return {
        hits: textHits,
        retrievalPath: atlasSearchRan
          ? 'ATLAS_SEARCH_THEN_MONGO_TEXT'
          : 'MONGO_TEXT',
        candidateCount: textHits.length,
        partialCoverage: false,
      };
    }

    // 3. Fallback 2: Bounded (<= 500) diacritic-folded scan scoped strictly to this conversation,
    //    then re-read original records by _id + scopedFilter.
    const recentRows = await model
      .find(scopedFilter, { _id: 1, content: 1, createdAt: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(FOLDED_FALLBACK_SCAN_LIMIT + 1)
      .lean()
      .exec();

    const partialCoverage = recentRows.length > FOLDED_FALLBACK_SCAN_LIMIT;
    const boundedRows = recentRows.slice(0, FOLDED_FALLBACK_SCAN_LIMIT);
    const scored = boundedRows
      .map((row) => ({
        id: row._id,
        createdAt: row.createdAt,
        score: scoreFoldedMessage(row.content, parsed),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt.getTime() - a.createdAt.getTime();
      })
      .slice(0, MAX_KEYWORD_CANDIDATES);

    const foldedRetrievalPath = atlasSearchRan
      ? 'ATLAS_SEARCH_THEN_FOLDED_SCAN'
      : textSucceeded
        ? 'MONGO_TEXT_THEN_FOLDED_SCAN'
        : 'FOLDED_SCAN';

    if (scored.length === 0) {
      return {
        hits: [],
        retrievalPath: foldedRetrievalPath,
        candidateCount: 0,
        partialCoverage,
      };
    }

    const matchedIds = scored.map((entry) => entry.id);
    const hydrated = await model
      .find({ ...scopedFilter, _id: { $in: matchedIds } })
      .lean<MessageDocument[]>()
      .exec();
    const byId = new Map<string, MessageDocument>(
      hydrated.map((doc) => [String(doc._id), doc]),
    );
    const orderedHits = scored
      .map((entry) => byId.get(String(entry.id)))
      .filter((doc): doc is MessageDocument => doc !== undefined);

    return {
      hits: orderedHits,
      retrievalPath: foldedRetrievalPath,
      candidateCount: orderedHits.length,
      partialCoverage,
    };
  }

  private async expandNeighbors(
    model: Model<MessageDocument>,
    scopedFilter: Record<string, unknown>,
    seeds: readonly MessageDocument[],
  ): Promise<MessageDocument[]> {
    const neighborBatches = await Promise.all(
      seeds.map(async (seed) => {
        const [before, after] = await Promise.all([
          model
            .find({
              ...scopedFilter,
              $or: [
                { createdAt: { $lt: seed.createdAt } },
                { createdAt: seed.createdAt, _id: { $lt: seed._id } },
              ],
            })
            .sort({ createdAt: -1, _id: -1 })
            .limit(NEIGHBOR_RADIUS)
            .lean()
            .exec(),
          model
            .find({
              ...scopedFilter,
              $or: [
                { createdAt: { $gt: seed.createdAt } },
                { createdAt: seed.createdAt, _id: { $gt: seed._id } },
              ],
            })
            .sort({ createdAt: 1, _id: 1 })
            .limit(NEIGHBOR_RADIUS)
            .lean()
            .exec(),
        ]);
        return [...before, ...after];
      }),
    );
    return neighborBatches.flat();
  }

  private applyContextBudget(
    docs: readonly MessageDocument[],
    hitPriorityIds: ReadonlySet<string>,
    maxMessages: number,
    maxChars: number,
  ): {
    items: { doc: MessageDocument; textForSag: string }[];
    truncated: boolean;
  } {
    let truncated = false;
    let working = [...docs];

    if (working.length > maxMessages) {
      truncated = true;
      if (hitPriorityIds.size > 0) {
        const prioritized = working.filter((d) =>
          hitPriorityIds.has(String(d._id)),
        );
        const others = working.filter(
          (d) => !hitPriorityIds.has(String(d._id)),
        );
        const keep = [
          ...prioritized.slice(-maxMessages),
          ...others.slice(-Math.max(0, maxMessages - prioritized.length)),
        ];
        working = keep.slice(-maxMessages).sort(compareChronological);
      } else {
        working = working.slice(-maxMessages);
      }
    }

    const prepared = working.map((doc) => {
      const trimmed = doc.content.trim();
      if (trimmed.length > MAX_SINGLE_MESSAGE_CHARS) {
        truncated = true;
        return {
          doc,
          textForSag: `${trimmed.slice(0, MAX_SINGLE_MESSAGE_CHARS - 1)}…`,
        };
      }
      return { doc, textForSag: trimmed };
    });

    const totalChars = prepared.reduce(
      (sum, item) => sum + item.textForSag.length,
      0,
    );
    if (totalChars <= maxChars) {
      return { items: prepared, truncated };
    }

    truncated = true;
    // Keep highest-priority (hits first, then most recent) within maxChars, then re-sort chronologically.
    const orderedForSelection = [...prepared].sort((a, b) => {
      const aHit = hitPriorityIds.has(String(a.doc._id)) ? 1 : 0;
      const bHit = hitPriorityIds.has(String(b.doc._id)) ? 1 : 0;
      if (aHit !== bHit) return bHit - aHit;
      return b.doc.createdAt.getTime() - a.doc.createdAt.getTime();
    });

    const kept: { doc: MessageDocument; textForSag: string }[] = [];
    let used = 0;
    for (const item of orderedForSelection) {
      if (used + item.textForSag.length <= maxChars) {
        kept.push(item);
        used += item.textForSag.length;
      } else if (kept.length === 0 && maxChars >= 10) {
        kept.push({
          doc: item.doc,
          textForSag: `${item.textForSag.slice(0, maxChars - 1)}…`,
        });
        break;
      }
    }

    kept.sort((a, b) => compareChronological(a.doc, b.doc));
    return { items: kept, truncated };
  }
}
