import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Types, type ClientSession, type Connection } from 'mongoose';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Document, Db } from 'mongodb';
import { RedisService } from '../infrastructure/redis/redis.service';
import { CAPTURE_PERSISTENCE } from '../infrastructure/persistence';
import {
  AuditService,
  type AuditEventRecord,
} from '../infrastructure/audit/audit.service';
import {
  SAG_KNOWLEDGE_SYNC_TRANSPORT,
  recordKnowledgeSyncTokenUsageLog,
  type SagKnowledgeSyncTransport,
  type SagProjectDocumentUploadReceipt,
} from '../infrastructure/outbox/knowledge-outbox.consumer';
import { OutboxService } from '../infrastructure/outbox/outbox.service';
import {
  CAPTURE_QUEUE_RUNTIME,
  QUEUE_NAMES,
  type CaptureQueuePublisher,
} from '../infrastructure/queues/queue.names';
import {
  isDocumentStorageKeyInScope,
  ProjectDocumentStorage,
} from '../infrastructure/storage/project-document.storage';
import { NotificationService } from '../../notification/notification.service';
import {
  assertReviewerCanReview,
  calculateReportPeriod,
  getFrequencyDays,
  type WorkReportFrequency,
} from './work-notes.domain';
import {
  buildTaskNoteMarkdownArtifact,
  buildWorkReportMarkdownArtifact,
} from './markdown-artifact.builder';
import { WorkNotesAuthorizationService } from './work-notes-authorization.service';
import {
  ProjectReportRosterService,
  type ReportingProjectMembers,
} from '../../iam/application/projects/project-report-roster.service';
import type {
  BulkGovernanceActionInput,
  BulkGovernanceResult,
  BulkTaskNoteGovernanceAction,
  BulkWorkReportGovernanceAction,
  CaptureRequestHeaders,
  AiChatProjectDocumentReadinessStatus,
  AiChatProjectDocumentSourceRecord,
  AiChatProjectDocumentSourcesResponse,
  DeleteProjectDocumentResult,
  DocumentActivityAction,
  DocumentActivityEvent,
  DocumentConfirmUploadInput,
  DocumentDownloadUrlResponse,
  DocumentKnowledgeChunksResponse,
  DocumentKnowledgeControlAction,
  DocumentKnowledgeStatusRecord,
  DocumentStatus,
  DocumentStorageReferenceRecord,
  DocumentUploadIntentInput,
  DocumentUploadIntentResponse,
  DocumentVersionRecord,
  ProjectDocumentInput,
  ProjectDocumentRecord,
  ProjectDocumentSummaryRecord,
  ProjectTaskNotesQueryOptions,
  PurgeArtifactResult,
  ReviewInput,
  TaskNoteInput,
  TaskNoteAiChatCitation,
  TaskNoteAiChatSessionCitation,
  TaskNoteAiChatSource,
  TaskNoteRecord,
  TaskNoteReviewStatus,
  WorkNotesActor,
  WorkNotesPage,
  WorkNotesPermissions,
  WorkReportInput,
  WorkReportRecord,
  WorkReportRosterEntry,
  WorkReportScope,
  WorkReportSettingsRecord,
  WorkReportsListFilters,
  WorkReportsPageRecord,
  WorkReportStatus,
  WorkReportSummaryCounts,
  WorkReportTierSettingsSummary,
} from './work-notes.types';

type MongoRecord = Record<string, unknown> & { _id: Types.ObjectId };

const documentNotFound = () =>
  new NotFoundException({
    code: 'DOCUMENT_NOT_FOUND',
    message: 'Project Document not found.',
  });
const reportNotFound = () =>
  new NotFoundException({
    code: 'WORK_REPORT_NOT_FOUND',
    message: 'Work Report not found.',
  });
const conflict = (message: string) =>
  new ConflictException({ code: 'WORKFLOW_CONFLICT', message });
const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);
const objectId = (value: string) => new Types.ObjectId(value.toLowerCase());
const startOfUtcWeek = (value: Date): Date => {
  const start = new Date(value);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
};
const record = (value: Document | null): MongoRecord | null =>
  value as unknown as MongoRecord | null;
const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const isKnowledgeSettledStatus = (status: unknown): boolean => {
  const normalized =
    typeof status === 'string' ? status.trim().toUpperCase() : '';
  return (
    normalized === 'DATA_READY' ||
    normalized === 'KNOWLEDGE_READY' ||
    normalized === 'READY'
  );
};
const normalizeKnowledgeSyncForVersion = (
  rawSync: unknown,
  currentVersionNumber: number,
): DocumentKnowledgeStatusRecord | undefined => {
  if (!rawSync || typeof rawSync !== 'object' || Array.isArray(rawSync)) {
    return undefined;
  }
  const sync = rawSync as DocumentKnowledgeStatusRecord;
  if (
    typeof sync.version === 'number' &&
    Number.isFinite(sync.version) &&
    Number(sync.version) !== currentVersionNumber
  ) {
    return undefined;
  }
  if (!sync.knowledgeReady && isKnowledgeSettledStatus(sync.knowledgeStatus)) {
    return { ...sync, knowledgeReady: true };
  }
  return sync;
};
const shouldRefreshLiveKnowledgeSync = (
  sync: DocumentKnowledgeStatusRecord | undefined,
  hasLiveStatusTransport: boolean,
): boolean => {
  if (!sync) return true;
  const normalized = (sync.status || '').toUpperCase();
  const normalizedStage = (sync.currentStage || '').toUpperCase();
  const normalizedDocStatus = (sync.documentStatus || '').toUpperCase();
  const normalizedKnowledgeStatus = (sync.knowledgeStatus || '').toUpperCase();
  if (['FAILED', 'REVOKED', 'NOT_SYNCED'].includes(normalized)) {
    return false;
  }
  if (
    normalized === 'PAUSED' ||
    (normalizedStage === 'PAUSED' && normalizedDocStatus === 'PAUSED')
  ) {
    return false;
  }
  const isSettledKnowledge = Boolean(
    sync.knowledgeReady || isKnowledgeSettledStatus(normalizedKnowledgeStatus),
  );
  const isKnowledgeInFlight =
    !isSettledKnowledge &&
    ['PROCESSING', 'EXTRACTING', 'RUNNING', 'QUEUED', 'PENDING'].includes(
      normalizedKnowledgeStatus,
    );
  const isDocInFlight = [
    'PENDING',
    'LOADING',
    'EXTRACTING',
    'PAUSING',
  ].includes(normalizedDocStatus);
  const isStagePaused = ['PAUSING', 'PAUSED'].includes(normalizedStage);
  const isTerminalReady =
    !isKnowledgeInFlight &&
    !isDocInFlight &&
    !isStagePaused &&
    (isSettledKnowledge ||
      (sync.searchReady &&
        (normalized === 'READY' ||
          normalized === 'SEARCH_READY' ||
          normalizedStage === 'COMPLETE' ||
          normalizedDocStatus === 'READY' ||
          normalizedDocStatus === 'INDEXED'))) &&
    sync.progress >= 100;
  if (isTerminalReady) return false;
  return hasLiveStatusTransport || !sync.status;
};
const serializeAiChatSource = (value: unknown): TaskNoteAiChatSource | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.threadId !== 'string' ||
    typeof source.messageId !== 'string' ||
    !Array.isArray(source.citations) ||
    !Array.isArray(source.sessionCitations)
  )
    return null;
  const citations = source.citations.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const citation = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(citation.number) ||
      typeof citation.sourceLabel !== 'string'
    )
      return [];
    const safe: TaskNoteAiChatCitation = {
      number: citation.number as number,
      sourceLabel: citation.sourceLabel.slice(0, 300),
      ...(typeof citation.documentId === 'string' &&
      validId(citation.documentId)
        ? { documentId: citation.documentId.toLowerCase() }
        : {}),
      ...(typeof citation.documentName === 'string'
        ? { documentName: citation.documentName.slice(0, 240) }
        : {}),
      ...(Number.isSafeInteger(citation.versionNo) &&
      Number(citation.versionNo) > 0
        ? { versionNo: Number(citation.versionNo) }
        : {}),
      ...(typeof citation.chunkId === 'string'
        ? { chunkId: citation.chunkId.slice(0, 300) }
        : {}),
      ...(typeof citation.heading === 'string'
        ? { heading: citation.heading.slice(0, 500) }
        : {}),
      ...(typeof citation.sectionPath === 'string'
        ? { sectionPath: citation.sectionPath.slice(0, 1000) }
        : {}),
      ...(Number.isSafeInteger(citation.pageFrom) &&
      Number(citation.pageFrom) > 0
        ? { pageFrom: Number(citation.pageFrom) }
        : {}),
      ...(Number.isSafeInteger(citation.pageTo) && Number(citation.pageTo) > 0
        ? { pageTo: Number(citation.pageTo) }
        : {}),
    };
    return [safe];
  });
  const sessionCitations = source.sessionCitations.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const citation = value as Record<string, unknown>;
    if (
      typeof citation.ref !== 'string' ||
      !Array.isArray(citation.turnIds) ||
      !citation.turnIds.every((id): id is string => typeof id === 'string')
    )
      return [];
    const safe: TaskNoteAiChatSessionCitation = {
      ref: citation.ref.slice(0, 20),
      ...(typeof citation.groupId === 'string'
        ? { groupId: citation.groupId.slice(0, 200) }
        : {}),
      turnIds: citation.turnIds.slice(0, 100).map((id) => id.slice(0, 200)),
    };
    return [safe];
  });
  return {
    threadId: source.threadId.slice(0, 200),
    messageId: source.messageId.slice(0, 200),
    citations: citations.slice(0, 100),
    sessionCitations: sessionCitations.slice(0, 100),
  };
};
const idText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value instanceof Types.ObjectId
      ? value.toHexString()
      : '';
const iso = (value: unknown): string | undefined =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : undefined;
const positiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
const PROJECT_SOURCE_READINESS_BATCH_SIZE = 100;
const pickReviewHistory = (
  value: unknown,
): DocumentVersionRecord['reviewHistory'] =>
  Array.isArray(value)
    ? value.map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
          action: item.action as
            'PENDING_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
          reviewerId: text(item.reviewerId),
          ...(item.reviewerRole === 'MANAGER' || item.reviewerRole === 'LEADER'
            ? { reviewerRole: item.reviewerRole }
            : {}),
          ...(typeof item.comment === 'string'
            ? { comment: item.comment }
            : {}),
          at: iso(item.at) ?? new Date(0).toISOString(),
        };
      })
    : [];

const isActorManager = (actor: WorkNotesActor): boolean =>
  Boolean(actor.isManager);
const isActorLeader = (actor: WorkNotesActor): boolean =>
  Boolean(actor.isLeader) || (actor.canReview && !actor.isManager);
const isActorPureMember = (actor: WorkNotesActor): boolean =>
  !isActorManager(actor) && !isActorLeader(actor);
const isNonMemberManager = (actor: WorkNotesActor): boolean =>
  isActorManager(actor) && !actor.isLeader;
const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BULK_ACTION_CONCURRENCY = 6;

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (nextIndex < items.length) {
        const idx = nextIndex++;
        await worker(items[idx]);
      }
    }),
  );
}

function sanitizeClientErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof HttpException) {
    const response = err.getResponse();
    if (
      response &&
      typeof response === 'object' &&
      typeof (response as { message?: unknown }).message === 'string'
    ) {
      const msg = (response as { message: string }).message.trim();
      if (
        msg &&
        !/https?:\/\/|mongodb|redis|ECONN|ENOTFOUND|stack/i.test(msg)
      ) {
        return msg.slice(0, 300);
      }
    }
    if (typeof response === 'string' && response.trim()) {
      if (!/https?:\/\/|mongodb|redis|ECONN|ENOTFOUND|stack/i.test(response)) {
        return response.trim().slice(0, 300);
      }
    }
  }
  return fallback;
}

const OLE2_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function isTextBuffer(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  return !sample.includes(0);
}

function isSafeXmlBuffer(bytes: Buffer): boolean {
  if (!isTextBuffer(bytes)) return false;
  const textSample = bytes
    .subarray(0, Math.min(bytes.length, 262_144))
    .toString('utf-8');
  // SEC-BE-011: Reject XML XXE declarations (DOCTYPE / ENTITY).
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(textSample)) {
    return false;
  }
  return true;
}

const ZIP_MAX_ENTRIES = 5_000;
const ZIP_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const ZIP_MAX_COMPRESSION_RATIO = 100;

function validateZipArchiveStructure(
  bytes: Buffer,
  requiredEntry?: string,
): boolean {
  // SEC-BE-011: Require full ZIP archive structure (PK\x03\x04 local header + EOCD + central directory).
  if (bytes.length < 22) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const isLocalHeader = bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isLocalHeader) return false;

  // Locate ZIP End of Central Directory (PK\x05\x06) within trailing 65KB
  const minEocdOffset = Math.max(0, bytes.length - 65_557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minEocdOffset; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return false;

  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirSize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (
    totalEntries === 0 ||
    totalEntries > ZIP_MAX_ENTRIES ||
    centralDirOffset + centralDirSize > eocdOffset
  ) {
    return false;
  }

  let cursor = centralDirOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let foundRequired = !requiredEntry;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > centralDirOffset + centralDirSize) return false;
    if (
      bytes[cursor] !== 0x50 ||
      bytes[cursor + 1] !== 0x4b ||
      bytes[cursor + 2] !== 0x01 ||
      bytes[cursor + 3] !== 0x02
    ) {
      return false;
    }
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const fileNameLen = bytes.readUInt16LE(cursor + 28);
    const extraLen = bytes.readUInt16LE(cursor + 30);
    const commentLen = bytes.readUInt16LE(cursor + 32);
    const nextCursor = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (nextCursor > centralDirOffset + centralDirSize) return false;

    const entryName = bytes
      .subarray(cursor + 46, cursor + 46 + fileNameLen)
      .toString('utf-8');
    // Reject zip-slip traversal paths
    if (
      entryName.startsWith('/') ||
      entryName.startsWith('\\') ||
      /(^|[\\/])\.\.([\\/]|$)/.test(entryName)
    ) {
      return false;
    }
    if (requiredEntry && entryName === requiredEntry) {
      foundRequired = true;
    }
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ZIP_MAX_UNCOMPRESSED_BYTES) {
      return false;
    }
    cursor = nextCursor;
  }

  if (
    totalCompressed > 0 &&
    totalUncompressed / totalCompressed > ZIP_MAX_COMPRESSION_RATIO
  ) {
    return false;
  }
  return foundRequired;
}

const isOoxmlBuffer = (bytes: Buffer) =>
  validateZipArchiveStructure(bytes, '[Content_Types].xml');
const isOdfBuffer = (bytes: Buffer) =>
  validateZipArchiveStructure(bytes, 'mimetype');
const isOle2Buffer = (bytes: Buffer) =>
  bytes.length >= 8 && bytes.subarray(0, 8).equals(OLE2_SIGNATURE);
const isRtfBuffer = (bytes: Buffer) =>
  bytes.subarray(0, 5).toString('ascii') === '{\\rtf';

type DocumentFileFormatRule = Readonly<{
  extensions: readonly string[];
  canonicalContentType: string;
  acceptedContentTypes: readonly string[];
  validateBytes: (bytes: Buffer) => boolean;
}>;

const DOCUMENT_FILE_FORMAT_RULES: readonly DocumentFileFormatRule[] = [
  {
    extensions: ['.pdf'],
    canonicalContentType: 'application/pdf',
    acceptedContentTypes: ['application/pdf'],
    validateBytes: (bytes) =>
      bytes.subarray(0, 5).toString('ascii') === '%PDF-',
  },
  {
    extensions: ['.docx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOoxmlBuffer,
  },
  {
    extensions: ['.doc'],
    canonicalContentType: 'application/msword',
    acceptedContentTypes: ['application/msword', 'application/vnd.ms-word'],
    validateBytes: (bytes) => isOle2Buffer(bytes) || isRtfBuffer(bytes),
  },
  {
    extensions: ['.xlsx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOoxmlBuffer,
  },
  {
    extensions: ['.xls'],
    canonicalContentType: 'application/vnd.ms-excel',
    acceptedContentTypes: ['application/vnd.ms-excel'],
    validateBytes: isOle2Buffer,
  },
  {
    extensions: ['.pptx'],
    canonicalContentType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    acceptedContentTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOoxmlBuffer,
  },
  {
    extensions: ['.ppt'],
    canonicalContentType: 'application/vnd.ms-powerpoint',
    acceptedContentTypes: ['application/vnd.ms-powerpoint'],
    validateBytes: isOle2Buffer,
  },
  {
    extensions: ['.odt'],
    canonicalContentType: 'application/vnd.oasis.opendocument.text',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.text',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOdfBuffer,
  },
  {
    extensions: ['.ods'],
    canonicalContentType: 'application/vnd.oasis.opendocument.spreadsheet',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOdfBuffer,
  },
  {
    extensions: ['.odp'],
    canonicalContentType: 'application/vnd.oasis.opendocument.presentation',
    acceptedContentTypes: [
      'application/vnd.oasis.opendocument.presentation',
      'application/zip',
      'application/x-zip-compressed',
    ],
    validateBytes: isOdfBuffer,
  },
  {
    extensions: ['.rtf'],
    canonicalContentType: 'application/rtf',
    acceptedContentTypes: ['application/rtf', 'text/rtf', 'text/plain'],
    validateBytes: isRtfBuffer,
  },
  {
    extensions: ['.txt'],
    canonicalContentType: 'text/plain',
    acceptedContentTypes: ['text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.md', '.markdown'],
    canonicalContentType: 'text/markdown',
    acceptedContentTypes: ['text/markdown', 'text/x-markdown', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.csv'],
    canonicalContentType: 'text/csv',
    acceptedContentTypes: [
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'text/plain',
    ],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.tsv'],
    canonicalContentType: 'text/tab-separated-values',
    acceptedContentTypes: ['text/tab-separated-values', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.json'],
    canonicalContentType: 'application/json',
    acceptedContentTypes: ['application/json', 'text/json', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.yaml', '.yml'],
    canonicalContentType: 'application/yaml',
    acceptedContentTypes: [
      'application/yaml',
      'application/x-yaml',
      'text/yaml',
      'text/x-yaml',
      'text/plain',
    ],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.xml', '.drawio'],
    canonicalContentType: 'application/xml',
    acceptedContentTypes: ['application/xml', 'text/xml', 'text/plain'],
    validateBytes: isSafeXmlBuffer,
  },
  {
    extensions: ['.sql'],
    canonicalContentType: 'application/sql',
    acceptedContentTypes: ['application/sql', 'text/x-sql', 'text/plain'],
    validateBytes: isTextBuffer,
  },
  {
    extensions: ['.png'],
    canonicalContentType: 'image/png',
    acceptedContentTypes: ['image/png'],
    validateBytes: (bytes) =>
      bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  },
  {
    extensions: ['.jpg', '.jpeg'],
    canonicalContentType: 'image/jpeg',
    acceptedContentTypes: ['image/jpeg', 'image/pjpeg'],
    validateBytes: (bytes) =>
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff,
  },
  {
    extensions: ['.webp'],
    canonicalContentType: 'image/webp',
    acceptedContentTypes: ['image/webp'],
    validateBytes: (bytes) =>
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

function resolveDocumentFormatRule(
  cleanName: string,
  rawContentType: string,
): DocumentFileFormatRule | null {
  const lowerName = cleanName.toLowerCase();
  const rule = DOCUMENT_FILE_FORMAT_RULES.find((candidate) =>
    candidate.extensions.some((ext) => lowerName.endsWith(ext)),
  );
  if (!rule) return null;
  const baseContentType =
    rawContentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const contentTypeAllowed =
    baseContentType === '' ||
    baseContentType === 'application/octet-stream' ||
    rule.acceptedContentTypes.includes(baseContentType);
  if (!contentTypeAllowed) return null;
  return rule;
}

function resolveValidatedDocumentContentType(
  cleanName: string,
  rawContentType: string,
  bytes: Buffer,
): string | null {
  const rule = resolveDocumentFormatRule(cleanName, rawContentType);
  if (!rule || !rule.validateBytes(bytes)) return null;
  return rule.canonicalContentType;
}

interface SignedDocumentUploadClaims {
  jti: string;
  orgId: string;
  projId: string;
  docId: string;
  userId: string;
  key: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  deduplicated: boolean;
  exp: number;
}

const EPHEMERAL_DEV_UPLOAD_SECRET = randomBytes(32).toString('hex');

@Injectable()
export class WorkNotesService {
  private readonly consumedUploadJtis = new Map<string, number>();

  constructor(
    private readonly authorization: WorkNotesAuthorizationService,
    @Optional()
    @InjectConnection(CAPTURE_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional() private readonly outbox?: OutboxService,
    @Optional() private readonly audit?: AuditService,
    @Optional() private readonly documentStorage?: ProjectDocumentStorage,
    @Optional() private readonly notifications?: NotificationService,
    @Optional()
    @Inject(SAG_KNOWLEDGE_SYNC_TRANSPORT)
    private readonly sagTransport?: SagKnowledgeSyncTransport,
    @Optional()
    @Inject(CAPTURE_QUEUE_RUNTIME)
    private readonly queueRuntime?: CaptureQueuePublisher,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly reportRoster?: ProjectReportRosterService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * SEC-BE-007: Verify caller authentication and project authorization BEFORE
   * reading/buffering up to 20 MB request streams in file upload handlers.
   */
  async assertUploadAuthorized(
    headers: CaptureRequestHeaders,
    projectId: string,
  ): Promise<WorkNotesActor> {
    return this.authorization.resolveProject(headers, projectId);
  }

  private formatEntityEtag(updatedAt: unknown): string | null {
    const isoValue = iso(updatedAt);
    if (!isoValue) return null;
    const ms = Date.parse(isoValue);
    return Number.isFinite(ms) ? `W/"${ms}"` : null;
  }

  /**
   * E2E-INT-012: Optional optimistic concurrency check when client sends If-Match.
   */
  private assertIfMatch(
    headers: CaptureRequestHeaders,
    currentUpdatedAt: unknown,
  ): void {
    const rawIfMatch = headers.ifMatch?.trim();
    if (!rawIfMatch || rawIfMatch === '*') return;
    const expected = this.formatEntityEtag(currentUpdatedAt);
    if (!expected) return;
    const normalizeTag = (tag: string) =>
      tag
        .trim()
        .replace(/^W\//i, '')
        .replace(/^"(.*)"$/, '$1');
    const providedTags = rawIfMatch.split(',').map(normalizeTag);
    const expectedNorm = normalizeTag(expected);
    const expectedIso = iso(currentUpdatedAt) ?? '';
    if (
      !providedTags.includes(expectedNorm) &&
      (!expectedIso || !providedTags.includes(expectedIso))
    ) {
      throw new ConflictException({
        code: 'ETAG_MISMATCH',
        message:
          'The resource was modified by another request. Reload and retry your edit.',
      });
    }
  }

  async listTaskNotes(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    page: number,
    pageSize: number,
  ): Promise<WorkNotesPage<TaskNoteRecord>> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const db = this.database();
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      taskId: objectId(taskId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
    };
    const collection = db.collection('work_notes');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    // BE-PERF-001: Serve persisted knowledgeSync on list GET (no synchronous per-row SAG HTTP polling).
    const records = rows.map((row) => this.taskNoteRecord(row, actor));
    return {
      data: records,
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async listProjectTaskNotes(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    taskIdOrOptions?: string | ProjectTaskNotesQueryOptions,
  ): Promise<WorkNotesPage<TaskNoteRecord>> {
    const options: ProjectTaskNotesQueryOptions =
      typeof taskIdOrOptions === 'string'
        ? { taskId: taskIdOrOptions }
        : (taskIdOrOptions ?? {});
    const { taskId, authorId, reviewStatus, search, sort = 'recent' } = options;
    const actor = taskId
      ? await this.authorization.resolveTask(headers, projectId, taskId)
      : await this.authorization.resolveProject(headers, projectId);
    const db = this.database();
    const trimmedSearch = search?.trim() ?? '';
    const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const searchRegex =
      escapedSearch.length > 0 ? new RegExp(escapedSearch, 'i') : undefined;
    const andConditions: Record<string, unknown>[] = [];
    if (reviewStatus === 'PENDING_REVIEW') {
      andConditions.push({
        $or: [
          { 'provenance.review.status': 'PENDING_REVIEW' },
          { 'provenance.review.status': { $exists: false } },
        ],
      });
    } else if (reviewStatus) {
      andConditions.push({ 'provenance.review.status': reviewStatus });
    }
    if (searchRegex) {
      andConditions.push({
        $or: [
          { title: searchRegex },
          { authorName: searchRegex },
          { whatDone: searchRegex },
          { contentMarkdown: searchRegex },
          { howSolved: searchRegex },
          { whyThisWay: searchRegex },
        ],
      });
    }
    const filter: Record<string, unknown> = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      taskId: taskId ? objectId(taskId) : { $type: 'objectId' },
      ...(authorId && validId(authorId)
        ? { authorUserId: objectId(authorId) }
        : {}),
      ...(andConditions.length === 1
        ? andConditions[0]
        : andConditions.length > 1
          ? { $and: andConditions }
          : {}),
    };
    const sortSpec: Record<string, 1 | -1> =
      sort === 'oldest' ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    const collection = db.collection('work_notes');
    if (taskId) {
      const [rows, totalItems] = await Promise.all([
        collection
          .find(filter)
          .sort(sortSpec)
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray(),
        collection.countDocuments(filter),
      ]);
      const records = rows.map((row) => this.taskNoteRecord(row, actor));
      return {
        data: records,
        pagination: this.pagination(page, pageSize, totalItems),
      };
    }

    // BE-PERF-001: Resolve distinct matching taskIds first (index-covered projection,
    // never loading full note bodies into RAM), authorize distinct taskIds with bounded
    // concurrency, then paginate directly in MongoDB for exact totalItems & full pages.
    const rawDistinctTaskIds: unknown[] =
      typeof collection.distinct === 'function'
        ? await collection.distinct('taskId', filter)
        : (
            await collection
              .find(filter, { projection: { taskId: 1 } })
              .toArray()
          ).map((row) => (row as Record<string, unknown>).taskId);
    const distinctTaskIds = [
      ...new Set(
        rawDistinctTaskIds
          .map((value) => idText(value))
          .filter((id) => validId(id)),
      ),
    ];
    if (distinctTaskIds.length === 0) {
      return {
        data: [],
        pagination: this.pagination(page, pageSize, 0),
      };
    }

    let resolvedTaskActors: Map<string, WorkNotesActor | null>;
    if (typeof this.authorization.resolveTasksBatch === 'function') {
      resolvedTaskActors = await this.authorization.resolveTasksBatch(
        headers,
        actor,
        distinctTaskIds,
      );
    } else {
      resolvedTaskActors = new Map<string, WorkNotesActor | null>();
      await runWithConcurrency(distinctTaskIds, 6, async (candidateTaskId) => {
        try {
          const resolved = await this.authorization.resolveTask(
            headers,
            projectId,
            candidateTaskId,
          );
          resolvedTaskActors.set(candidateTaskId, resolved);
        } catch (err) {
          if (
            err instanceof NotFoundException ||
            err instanceof ForbiddenException
          ) {
            resolvedTaskActors.set(candidateTaskId, null);
            return;
          }
          throw err;
        }
      });
    }

    const allowedTaskObjectIds = [...resolvedTaskActors.entries()]
      .filter(([, taskActor]) => Boolean(taskActor))
      .map(([allowedTaskId]) => objectId(allowedTaskId));
    if (allowedTaskObjectIds.length === 0) {
      return {
        data: [],
        pagination: this.pagination(page, pageSize, 0),
      };
    }

    const authorizedFilter: Record<string, unknown> = {
      ...filter,
      taskId: { $in: allowedTaskObjectIds },
    };
    const [authorizedPageRows, totalItems] = await Promise.all([
      collection
        .find(authorizedFilter)
        .sort(sortSpec)
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(authorizedFilter),
    ]);
    const mappedPage = authorizedPageRows.map((row) => {
      const rowTaskId = idText((row as Record<string, unknown>).taskId);
      const taskActor = resolvedTaskActors.get(rowTaskId) ?? actor;
      return this.taskNoteRecord(row, taskActor);
    });
    const withStorageRefs = await this.attachTaskNoteStorageReferences(
      actor.organizationId,
      projectId,
      authorizedPageRows,
      mappedPage,
    );
    return {
      data: withStorageRefs,
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async getTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const row = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        taskId: objectId(taskId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    if (!row) throw this.taskNoteNotFound();
    const mapped = this.taskNoteRecord(row, actor);
    const hasLiveTransport =
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function';
    if (
      mapped.reviewStatus === 'APPROVED' &&
      shouldRefreshLiveKnowledgeSync(mapped.knowledgeSync, hasLiveTransport)
    ) {
      const refreshed = await this.resolveTaskNoteKnowledgeStatusForRow(
        actor,
        projectId,
        row,
      ).catch(() => mapped.knowledgeSync);
      if (refreshed) mapped.knowledgeSync = refreshed;
    }
    const [withStorageRef] = await this.attachTaskNoteStorageReferences(
      actor.organizationId,
      projectId,
      [row],
      [mapped],
    );
    return withStorageRef ?? mapped;
  }

  async getProjectTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const row = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    const taskId = row ? idText(row.taskId) : '';
    if (!row || !validId(taskId)) throw this.taskNoteNotFound();
    const taskActor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    const mapped = this.taskNoteRecord(row, taskActor);
    const hasLiveTransport =
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function';
    if (
      mapped.reviewStatus === 'APPROVED' &&
      shouldRefreshLiveKnowledgeSync(mapped.knowledgeSync, hasLiveTransport)
    ) {
      const refreshed = await this.resolveTaskNoteKnowledgeStatusForRow(
        taskActor,
        projectId,
        row,
      ).catch(() => mapped.knowledgeSync);
      if (refreshed) mapped.knowledgeSync = refreshed;
    }
    const [withStorageRef] = await this.attachTaskNoteStorageReferences(
      taskActor.organizationId,
      projectId,
      [row],
      [mapped],
    );
    return withStorageRef ?? mapped;
  }

  async createTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    input: TaskNoteInput,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'TASK_NOTE_READ_ONLY',
        message: 'Managers have read-only access to Task Notes.',
      });
    }
    const id = new Types.ObjectId();
    const noteId = String(id);
    const now = new Date();
    const nowIso = now.toISOString();
    // BE-LOGIC-001: Self-approval is unconditionally forbidden. Every created
    // Task Note enters PENDING_REVIEW for an independent reviewer.
    const reviewStatus: TaskNoteReviewStatus = 'PENDING_REVIEW';
    const provenance: Record<string, unknown> = {
      review: {
        status: 'PENDING_REVIEW',
        submittedAt: nowIso,
        history: [],
      },
    };
    let insertedRow: Document | null = null;
    await this.transaction(async (db, session) => {
      const doc: Document = {
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        taskId: objectId(taskId),
        type: 'TASK_NOTE',
        authorUserId: objectId(actor.userId),
        authorName: actor.userName,
        ...(actor.taskKey ? { taskKey: actor.taskKey } : {}),
        title: input.title,
        whatDone: input.accomplishments,
        howSolved: input.approach,
        whyThisWay: input.reason,
        currentVersionNumber: 1,
        status: 'CONFIRMED',
        authorConfirmedAt: now,
        createdAt: now,
        updatedAt: now,
        provenance,
      };
      await db.collection('work_notes').insertOne(doc, { session });
      insertedRow = doc;
      await this.auditEvent(
        actor,
        'TASK_NOTE_CREATED',
        'WORK_NOTE',
        noteId,
        { version: 1, reviewStatus },
        session,
      );
    });
    await this.afterTaskNoteSaved({
      headers,
      actor,
      projectId,
      taskId,
      noteId,
      title: input.title,
      version: 1,
      reviewStatus,
    });
    if (insertedRow) {
      return this.taskNoteRecord(insertedRow, actor);
    }
    return {
      id: noteId,
      projectId,
      taskId,
      ...(actor.taskKey ? { taskKey: actor.taskKey } : {}),
      ...(actor.taskTitle ? { taskTitle: actor.taskTitle } : {}),
      authorId: actor.userId,
      authorName: actor.userName,
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      reviewStatus,
      submittedAt: nowIso,
      ...input,
      createdAt: nowIso,
      updatedAt: nowIso,
      permissions: this.taskNotePermissions(actor, actor.userId, reviewStatus),
    };
  }

  async updateTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
    input: TaskNoteInput,
  ): Promise<TaskNoteRecord> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'TASK_NOTE_READ_ONLY',
        message: 'Managers have read-only access to Task Notes.',
      });
    }
    if (!validId(noteId)) throw this.taskNoteNotFound();
    let updatedRow: Document | null = null;
    let nextVersion = 1;
    let revokedPriorVersion: number | null = null;
    // BE-LOGIC-001: Updating a Task Note always resets review status to PENDING_REVIEW.
    const reviewStatus: TaskNoteReviewStatus = 'PENDING_REVIEW';
    await this.transaction(async (db, session) => {
      const existing = await db.collection('work_notes').findOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        { session },
      );
      if (!existing) throw this.taskNoteNotFound();
      this.assertIfMatch(headers, existing.updatedAt);
      if (existing.contentSchemaVersion === 2)
        throw new ConflictException({
          code: 'NOTE_EDITOR_UPGRADE_REQUIRED',
          message: 'Use the freeform editor to update this note.',
        });
      const now = new Date();
      const nowIso = now.toISOString();
      const prevVersion = Math.max(
        1,
        Number(existing.currentVersionNumber ?? 1),
      );
      nextVersion = prevVersion + 1;
      const rawProv =
        existing.provenance &&
        typeof existing.provenance === 'object' &&
        !Array.isArray(existing.provenance)
          ? (existing.provenance as Record<string, unknown>)
          : {};
      const prevReview =
        rawProv.review && typeof rawProv.review === 'object'
          ? (rawProv.review as { status?: string; history?: unknown })
          : undefined;
      const prevSync = rawProv.knowledgeSync as
        { sagDocumentId?: string; status?: string } | undefined;
      const wasSyncedToSag =
        prevReview?.status === 'APPROVED' ||
        Boolean(prevSync?.sagDocumentId) ||
        (Boolean(prevSync?.status) && prevSync?.status !== 'REVOKED');
      const prevHistory = pickReviewHistory(prevReview?.history);
      const nextProv: Record<string, unknown> = {
        ...rawProv,
        review: {
          status: 'PENDING_REVIEW',
          submittedAt: nowIso,
          history: prevHistory,
        },
      };
      delete nextProv.mdFile;
      delete nextProv.knowledgeSync;

      updatedRow = await db.collection('work_notes').findOneAndUpdate(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        {
          $set: {
            title: input.title,
            whatDone: input.accomplishments,
            howSolved: input.approach,
            whyThisWay: input.reason,
            currentVersionNumber: nextVersion,
            provenance: nextProv,
            updatedAt: now,
          },
        },
        { returnDocument: 'after', session },
      );
      if (!updatedRow) throw this.taskNoteNotFound();
      if (wasSyncedToSag && this.outbox) {
        // BE-DATA-003: Emit durable SAG revocation inside the transaction whenever
        // an edited Task Note reverts from APPROVED/synced back to PENDING_REVIEW.
        revokedPriorVersion = prevVersion;
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'WORK_NOTE',
            aggregateId: noteId,
            payload: {
              sourceType: 'WORK_NOTE',
              sourceId: noteId,
              organizationId: actor.organizationId,
              projectId,
              version: prevVersion,
              reason: 'UPDATED_PENDING_REAPPROVAL',
            },
          },
          session,
        );
      }
      await this.auditEvent(
        actor,
        'TASK_NOTE_UPDATED',
        'WORK_NOTE',
        noteId,
        { version: nextVersion, reviewStatus },
        session,
      );
    });
    if (!updatedRow) throw this.taskNoteNotFound();
    if (revokedPriorVersion !== null) {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_REVOKED',
        revokedPriorVersion,
        headers.requestId,
      );
    }
    await this.afterTaskNoteSaved({
      headers,
      actor,
      projectId,
      taskId,
      noteId,
      title: input.title,
      version: nextVersion,
      reviewStatus,
    });
    return this.taskNoteRecord(updatedRow, actor);
  }

  async afterTaskNoteSaved(params: {
    headers: CaptureRequestHeaders;
    actor: WorkNotesActor;
    projectId: string;
    taskId: string;
    noteId: string;
    title: string;
    version: number;
    reviewStatus: TaskNoteReviewStatus;
  }): Promise<void> {
    const {
      headers,
      actor,
      projectId,
      taskId,
      noteId,
      title,
      version,
      reviewStatus,
    } = params;
    if (reviewStatus === 'APPROVED') {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_APPROVED',
        version,
        headers.requestId,
      );
      return;
    }

    if (this.notifications) {
      try {
        const recipients = (
          await this.resolveProjectLeaderRecipientIds(
            actor.organizationId,
            projectId,
          )
        ).filter((uid) => uid.toLowerCase() !== actor.userId.toLowerCase());
        if (recipients.length > 0) {
          const authorLabel = actor.userName || 'A team member';
          await this.notifications.emitSafe({
            type: 'WORK_NOTE_MENTION',
            actorId: actor.userId,
            recipients,
            title: 'Task Note awaiting review',
            message: `${authorLabel} submitted Task Note "${title.slice(0, 80)}" (v${version}) for approval.`,
            organizationId: actor.organizationId,
            projectId,
            target: {
              kind: 'WORK_NOTE',
              url: `/projects/${projectId}/work-notes`,
              organizationId: actor.organizationId,
              projectId,
              taskId,
              noteId,
            },
            eventKey: `task-note-submitted:${noteId}:v${version}:${Date.now()}`,
          });
        }
      } catch {
        // Non-blocking notification
      }
    }
  }

  async deleteTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    taskId: string,
    noteId: string,
  ): Promise<void> {
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'TASK_NOTE_READ_ONLY',
        message: 'Managers have read-only access to Task Notes.',
      });
    }
    if (!validId(noteId)) throw this.taskNoteNotFound();
    let existingProv: Record<string, unknown> | undefined;
    let revokedVersion = 1;
    await this.transaction(async (db, session) => {
      const existing = await db.collection('work_notes').findOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        { session },
      );
      if (!existing) throw this.taskNoteNotFound();
      revokedVersion = Math.max(1, Number(existing.currentVersionNumber ?? 1));
      existingProv =
        existing.provenance &&
        typeof existing.provenance === 'object' &&
        !Array.isArray(existing.provenance)
          ? (existing.provenance as Record<string, unknown>)
          : undefined;
      const existingReviewStatus = (
        existingProv?.review as { status?: string } | undefined
      )?.status;
      // SEC-AUTH-007: Regular MEMBER authors cannot archive/delete APPROVED SAG knowledge.
      if (existingReviewStatus === 'APPROVED' && !actor.canReview) {
        throw new ForbiddenException({
          code: 'DOCUMENT_CONTROL_FORBIDDEN',
          message: 'Only a Project reviewer can delete an approved Task Note.',
        });
      }
      const result = await db.collection('work_notes').updateOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          taskId: objectId(taskId),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
          ...(actor.canReview ? {} : { authorUserId: objectId(actor.userId) }),
        },
        { $set: { status: 'ARCHIVED', updatedAt: new Date() } },
        { session },
      );
      if (result.modifiedCount !== 1) throw this.taskNoteNotFound();
      const reviewObj = existingProv?.review as { status?: string } | undefined;
      const syncObj = existingProv?.knowledgeSync as
        { sagDocumentId?: string } | undefined;
      if (
        this.outbox &&
        (reviewObj?.status === 'APPROVED' || Boolean(syncObj?.sagDocumentId))
      ) {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'WORK_NOTE',
            aggregateId: noteId,
            payload: {
              sourceType: 'WORK_NOTE',
              sourceId: noteId,
              organizationId: actor.organizationId,
              projectId,
              version: revokedVersion,
              reason: 'ARCHIVED',
            },
          },
          session,
        );
      }
      await this.auditEvent(
        actor,
        'TASK_NOTE_ARCHIVED',
        'WORK_NOTE',
        noteId,
        { version: revokedVersion },
        session,
      );
    });

    const reviewObj = existingProv?.review as { status?: string } | undefined;
    const syncObj = existingProv?.knowledgeSync as
      { sagDocumentId?: string } | undefined;
    if (reviewObj?.status === 'APPROVED' || Boolean(syncObj?.sagDocumentId)) {
      if (typeof this.sagTransport?.revokeProjectDocument === 'function') {
        await this.sagTransport
          .revokeProjectDocument({
            organizationId: actor.organizationId,
            projectId,
            documentId: noteId,
            version: revokedVersion,
            logicalSourceId: `continuum:work_note:${noteId}`,
            actorUserId: actor.userId,
            reason: 'TASK_NOTE_ARCHIVED',
          })
          .catch(() => undefined);
      }
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_REVOKED',
        revokedVersion,
        headers.requestId,
      );
    }

    const mdFileKey = (existingProv?.mdFile as { key?: string } | undefined)
      ?.key;
    if (mdFileKey && this.documentStorage) {
      const stillReferenced = await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        mdFileKey,
        { excludeWorkNoteId: noteId },
      );
      if (!stillReferenced) {
        await this.documentStorage.delete(mdFileKey).catch(() => undefined);
      }
    }
  }

  async deleteProjectTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<PurgeArtifactResult> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'TASK_NOTE_READ_ONLY',
        message: 'Managers have read-only access to Task Notes.',
      });
    }
    const authorId = String(row.authorUserId);
    const isOwner = authorId.toLowerCase() === actor.userId.toLowerCase();
    const existingProvCheck =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : undefined;
    const isApprovedNote =
      (existingProvCheck?.review as { status?: string } | undefined)?.status ===
      'APPROVED';
    if (
      (!isOwner && !actor.canReview) ||
      (isApprovedNote && !actor.canReview)
    ) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CONTROL_FORBIDDEN',
        message: isApprovedNote
          ? 'Only a Project reviewer can delete an approved Task Note.'
          : 'Only the author or a Project reviewer can delete this Task Note.',
      });
    }
    const taskId = idText(row.taskId);
    const revokedVersion = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const existingProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : undefined;
    const reviewObj = existingProv?.review as { status?: string } | undefined;
    const syncObj = existingProv?.knowledgeSync as
      { sagDocumentId?: string; status?: string } | undefined;
    const shouldRevokeSag =
      reviewObj?.status === 'APPROVED' ||
      Boolean(syncObj?.sagDocumentId) ||
      (Boolean(syncObj?.status) && syncObj?.status !== 'REVOKED');

    await this.transaction(async (db, session) => {
      const result = await db.collection('work_notes').updateOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...(validId(taskId) ? { taskId: objectId(taskId) } : {}),
          type: 'TASK_NOTE',
          status: 'CONFIRMED',
        },
        { $set: { status: 'ARCHIVED', updatedAt: new Date() } },
        { session },
      );
      if (result.modifiedCount !== 1) throw this.taskNoteNotFound();
      if (this.outbox && shouldRevokeSag) {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'WORK_NOTE',
            aggregateId: noteId,
            payload: {
              sourceType: 'WORK_NOTE',
              sourceId: noteId,
              organizationId: actor.organizationId,
              projectId,
              version: revokedVersion,
              reason: 'ARCHIVED',
            },
          },
          session,
        );
      }
      await this.auditEvent(
        actor,
        'TASK_NOTE_ARCHIVED',
        'WORK_NOTE',
        noteId,
        { version: revokedVersion },
        session,
      );
    });

    let sagRevoked = false;
    if (shouldRevokeSag) {
      if (typeof this.sagTransport?.revokeProjectDocument === 'function') {
        await this.sagTransport
          .revokeProjectDocument({
            organizationId: actor.organizationId,
            projectId,
            documentId: noteId,
            version: revokedVersion,
            logicalSourceId: `continuum:work_note:${noteId}`,
            actorUserId: actor.userId,
            reason: 'TASK_NOTE_ARCHIVED',
          })
          .then(() => {
            sagRevoked = true;
          })
          .catch(() => undefined);
      } else {
        sagRevoked = true;
      }
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_REVOKED',
        revokedVersion,
        headers.requestId,
      );
    }

    let r2DeletedKeys = 0;
    let r2RetainedSharedKeys = 0;
    const mdFileKey = (existingProv?.mdFile as { key?: string } | undefined)
      ?.key;
    if (mdFileKey) {
      const stillReferenced = await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        mdFileKey,
        { excludeWorkNoteId: noteId },
      );
      if (stillReferenced) {
        r2RetainedSharedKeys = 1;
      } else if (this.documentStorage) {
        await this.documentStorage.delete(mdFileKey).catch(() => undefined);
        r2DeletedKeys = 1;
      }
    }

    return {
      entityId: noteId,
      status: 'ARCHIVED',
      sagRevoked,
      r2DeletedKeys,
      r2RetainedSharedKeys,
    };
  }

  async purgeTaskNoteArtifact(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
    options?: { reopen?: boolean; comment?: string },
  ): Promise<PurgeArtifactResult> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'TASK_NOTE_READ_ONLY',
        message: 'Managers have read-only access to Task Notes.',
      });
    }
    const authorId = String(row.authorUserId);
    const isOwner = authorId.toLowerCase() === actor.userId.toLowerCase();
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const existingReview =
      rawProv.review && typeof rawProv.review === 'object'
        ? (rawProv.review as Record<string, unknown>)
        : {};
    const isApprovedNote = existingReview.status === 'APPROVED';
    if (
      (!isOwner && !actor.canReview) ||
      (isApprovedNote && !actor.canReview)
    ) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CONTROL_FORBIDDEN',
        message:
          'Only a Project reviewer can manage approved Task Note storage artifacts.',
      });
    }
    const existingSync = normalizeKnowledgeSyncForVersion(
      rawProv.knowledgeSync,
      versionNumber,
    );
    const mdFileKey = (rawProv.mdFile as { key?: string } | undefined)?.key;
    const shouldRevokeSag =
      existingReview.status === 'APPROVED' ||
      Boolean(existingSync?.sagDocumentId) ||
      (Boolean(existingSync?.status) && existingSync?.status !== 'REVOKED');

    let sagRevoked = false;
    if (shouldRevokeSag) {
      if (typeof this.sagTransport?.revokeProjectDocument === 'function') {
        await this.sagTransport
          .revokeProjectDocument({
            organizationId: actor.organizationId,
            projectId,
            documentId: noteId,
            version: versionNumber,
            logicalSourceId: `continuum:work_note:${noteId}`,
            actorUserId: actor.userId,
            reason: 'ARTIFACT_PURGED',
          })
          .then(() => {
            sagRevoked = true;
          })
          .catch(() => undefined);
      } else {
        sagRevoked = true;
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const shouldReopen = Boolean(options?.reopen && actor.canReview);
    const nextStatus = shouldReopen
      ? 'CHANGES_REQUESTED'
      : text(existingReview.status) || 'APPROVED';
    const comment = options?.comment?.trim() || undefined;
    const reviewerRole: 'MANAGER' | 'LEADER' = isActorManager(actor)
      ? 'MANAGER'
      : 'LEADER';
    const history = pickReviewHistory(existingReview.history);
    const nextReview = shouldReopen
      ? {
          ...existingReview,
          status: 'CHANGES_REQUESTED',
          reviewedBy: actor.userId,
          reviewerName: actor.userName,
          reviewedAt: nowIso,
          ...(comment ? { comment } : {}),
          history: [
            ...history,
            {
              action: 'CHANGES_REQUESTED' as const,
              reviewerId: actor.userId,
              reviewerRole,
              ...(comment ? { comment } : {}),
              at: nowIso,
            },
          ],
        }
      : existingReview;

    const revokedSync: DocumentKnowledgeStatusRecord = {
      ...(existingSync ?? {}),
      documentId: noteId,
      version: versionNumber,
      status: 'REVOKED',
      searchStatus: 'REVOKED',
      knowledgeStatus: 'REVOKED',
      searchReady: false,
      knowledgeReady: false,
      currentStage: 'REVOKED',
      progress: 0,
      syncedAt: nowIso,
    };

    const nextProv: Record<string, unknown> = {
      ...rawProv,
      review: nextReview,
    };
    delete nextProv.mdFile;
    if (shouldReopen) {
      delete nextProv.knowledgeSync;
    } else {
      nextProv.knowledgeSync = revokedSync;
    }

    await this.transaction(async (db, session) => {
      await db.collection('work_notes').updateOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: 'CONFIRMED',
        },
        {
          $set: {
            provenance: nextProv,
            updatedAt: now,
          },
        },
        { session },
      );
      try {
        await db.collection('work_note_versions').updateOne(
          {
            workNoteId: objectId(noteId),
            versionNumber,
          },
          {
            $set: {
              'provenance.review': nextReview,
              ...(shouldReopen
                ? {}
                : { 'provenance.knowledgeSync': revokedSync }),
            },
            $unset: {
              'provenance.mdFile': '',
              ...(shouldReopen ? { 'provenance.knowledgeSync': '' } : {}),
            },
          },
          { session },
        );
      } catch {
        // Optional version collection in isolated unit tests
      }
      if (this.outbox && shouldRevokeSag) {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'WORK_NOTE',
            aggregateId: noteId,
            payload: {
              sourceType: 'WORK_NOTE',
              sourceId: noteId,
              organizationId: actor.organizationId,
              projectId,
              version: versionNumber,
              reason: shouldReopen ? 'REOPENED' : 'ARTIFACT_PURGED',
            },
          },
          session,
        );
      }
      await this.auditEvent(
        actor,
        'TASK_NOTE_ARTIFACT_PURGED',
        'WORK_NOTE',
        noteId,
        {
          version: versionNumber,
          reopened: shouldReopen,
          hadStorageKey: Boolean(mdFileKey),
        },
        session,
      );
    });

    if (shouldRevokeSag) {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_REVOKED',
        versionNumber,
        headers.requestId,
      );
    }

    let r2DeletedKeys = 0;
    let r2RetainedSharedKeys = 0;
    if (mdFileKey) {
      const stillReferenced = await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        mdFileKey,
        { excludeWorkNoteId: noteId },
      );
      if (stillReferenced) {
        r2RetainedSharedKeys = 1;
      } else if (this.documentStorage) {
        await this.documentStorage.delete(mdFileKey).catch(() => undefined);
        r2DeletedKeys = 1;
      }
    }

    return {
      entityId: noteId,
      status: nextStatus,
      sagRevoked,
      r2DeletedKeys,
      r2RetainedSharedKeys,
    };
  }

  async bulkTaskNoteAction(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: BulkGovernanceActionInput<BulkTaskNoteGovernanceAction>,
  ): Promise<BulkGovernanceResult> {
    const uniqueIds = Array.from(
      new Set(input.ids.map((id) => id.trim()).filter(Boolean)),
    ).slice(0, 50);
    const outcomes = new Array<
      { ok: true; id: string } | { ok: false; id: string; message: string }
    >(uniqueIds.length);

    await runWithConcurrency(
      uniqueIds.map((id, index) => ({ id, index })),
      BULK_ACTION_CONCURRENCY,
      async ({ id, index }) => {
        try {
          switch (input.action) {
            case 'APPROVE':
              await this.reviewTaskNote(headers, projectId, id, 'APPROVED', {
                comment: input.comment,
              });
              break;
            case 'REQUEST_CHANGES':
              await this.reviewTaskNote(
                headers,
                projectId,
                id,
                'CHANGES_REQUESTED',
                { comment: input.comment },
              );
              break;
            case 'REJECT':
              await this.reviewTaskNote(headers, projectId, id, 'REJECTED', {
                comment: input.comment,
              });
              break;
            case 'SYNC':
              await this.syncTaskNoteToSag(headers, projectId, id);
              break;
            case 'PAUSE':
            case 'RESUME':
            case 'REPROCESS':
            case 'REVOKE':
              await this.controlTaskNoteKnowledge(
                headers,
                projectId,
                id,
                input.action,
              );
              break;
            case 'PURGE_ARTIFACT':
              await this.purgeTaskNoteArtifact(headers, projectId, id, {
                reopen: input.reopen,
                comment: input.comment,
              });
              break;
            case 'DELETE':
              await this.deleteProjectTaskNote(headers, projectId, id);
              break;
            default:
              throw new BadRequestException({ code: 'INVALID_BULK_ACTION' });
          }
          outcomes[index] = { ok: true, id };
        } catch (err) {
          outcomes[index] = {
            ok: false,
            id,
            message: sanitizeClientErrorMessage(err, 'Operation failed.'),
          };
        }
      },
    );

    const succeededIds: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const outcome of outcomes) {
      if (outcome.ok) succeededIds.push(outcome.id);
      else failed.push({ id: outcome.id, message: outcome.message });
    }

    return {
      action: input.action,
      requestedCount: uniqueIds.length,
      succeededIds,
      failed,
    };
  }

  async reviewTaskNote(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
    input: ReviewInput,
  ): Promise<TaskNoteRecord> {
    const projectActor = await this.authorization.resolveProject(
      headers,
      projectId,
    );
    if (!projectActor.canReview) throw this.reviewPermissionDenied();
    if (!validId(noteId)) throw this.taskNoteNotFound();

    const initialRow = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(projectActor.organizationId),
        projectId: objectId(projectId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    const taskId = initialRow ? idText(initialRow.taskId) : '';
    if (!initialRow || !validId(taskId)) throw this.taskNoteNotFound();
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    if (!actor.canReview) throw this.reviewPermissionDenied();

    const now = new Date();
    const nowIso = now.toISOString();
    const comment = input.comment?.trim() || undefined;
    let sourceVersion = 1;
    let authorId = '';
    let noteTitle = '';

    await this.transaction(async (db, session) => {
      const notes = db.collection('work_notes');
      const current = record(
        await notes.findOne(
          {
            _id: objectId(noteId),
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            type: 'TASK_NOTE',
            status: 'CONFIRMED',
          },
          { session },
        ),
      );
      if (!current) throw this.taskNoteNotFound();
      authorId = String(current.authorUserId);
      noteTitle = text(current.title);
      // BE-LOGIC-001: Enforce independent reviewer (never allow self-review).
      assertReviewerCanReview(authorId, actor.userId, actor.canReview);

      sourceVersion = Math.max(1, Number(current.currentVersionNumber ?? 1));
      const rawProv =
        current.provenance &&
        typeof current.provenance === 'object' &&
        !Array.isArray(current.provenance)
          ? (current.provenance as Record<string, unknown>)
          : {};
      const existingReview =
        rawProv.review && typeof rawProv.review === 'object'
          ? (rawProv.review as {
              status?: string;
              submittedAt?: string;
              history?: unknown;
            })
          : undefined;
      const currentReviewStatus: TaskNoteReviewStatus =
        existingReview?.status === 'APPROVED' ||
        existingReview?.status === 'CHANGES_REQUESTED' ||
        existingReview?.status === 'REJECTED' ||
        existingReview?.status === 'PENDING_REVIEW'
          ? existingReview.status
          : 'PENDING_REVIEW';
      if (currentReviewStatus !== 'PENDING_REVIEW') {
        throw conflict('Only a Task Note awaiting review can be reviewed.');
      }

      const reviewerRole: 'MANAGER' | 'LEADER' = isActorManager(actor)
        ? 'MANAGER'
        : 'LEADER';
      const history = pickReviewHistory(existingReview?.history);
      const nextReview = {
        status: action,
        submittedAt:
          existingReview?.submittedAt ?? iso(current.createdAt) ?? nowIso,
        reviewedBy: actor.userId,
        reviewerName: actor.userName,
        reviewedAt: nowIso,
        ...(comment ? { comment } : {}),
        history: [
          ...history,
          {
            action,
            reviewerId: actor.userId,
            reviewerRole,
            ...(comment ? { comment } : {}),
            at: nowIso,
          },
        ],
      };

      const queuedSync: DocumentKnowledgeStatusRecord | undefined =
        action === 'APPROVED'
          ? {
              documentId: noteId,
              version: sourceVersion,
              status: 'QUEUED_OUTBOX',
              searchStatus: 'PENDING',
              knowledgeStatus: 'NOT_STARTED',
              searchReady: false,
              knowledgeReady: false,
              currentStage: 'OUTBOX_QUEUE',
              progress: 5,
              syncedAt: nowIso,
            }
          : undefined;

      const nextProv: Record<string, unknown> = {
        ...rawProv,
        review: nextReview,
        ...(queuedSync ? { knowledgeSync: queuedSync } : {}),
      };
      if (action !== 'APPROVED') {
        delete nextProv.mdFile;
        delete nextProv.knowledgeSync;
      }

      const updated = await notes.updateOne(
        {
          _id: objectId(noteId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: 'CONFIRMED',
          $or: [
            { 'provenance.review.status': 'PENDING_REVIEW' },
            { 'provenance.review.status': { $exists: false } },
          ],
        },
        {
          $set: {
            provenance: nextProv,
            updatedAt: now,
          },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw conflict('The Task Note was already reviewed by another user.');
      }

      try {
        await db.collection('work_note_versions').updateOne(
          {
            workNoteId: objectId(noteId),
            versionNumber: sourceVersion,
          },
          {
            $set: {
              'provenance.review': nextReview,
              ...(queuedSync ? { 'provenance.knowledgeSync': queuedSync } : {}),
            },
          },
          { session },
        );
      } catch {
        // Optional version collection in isolated unit tests
      }

      if (action === 'APPROVED') {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_APPROVED',
            aggregateType: 'WORK_NOTE',
            aggregateId: noteId,
            payload: {
              sourceType: 'WORK_NOTE',
              sourceId: noteId,
              organizationId: actor.organizationId,
              projectId,
              version: sourceVersion,
              approvedAt: nowIso,
            },
          },
          session,
        );
      }

      const auditAction =
        action === 'APPROVED'
          ? 'TASK_NOTE_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'TASK_NOTE_CHANGES_REQUESTED'
            : 'TASK_NOTE_REJECTED';
      await this.auditEvent(
        actor,
        auditAction,
        'WORK_NOTE',
        noteId,
        {
          authorId,
          version: sourceVersion,
          ...(comment ? { comment } : {}),
        },
        session,
      );
    });

    if (action === 'APPROVED') {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        noteId,
        'KNOWLEDGE_SOURCE_APPROVED',
        sourceVersion,
        headers.requestId,
      );
    }

    if (
      this.notifications &&
      authorId &&
      authorId.toLowerCase() !== actor.userId.toLowerCase()
    ) {
      await this.notifications
        .emitSafe({
          type: 'WORK_NOTE_MENTION',
          actorId: actor.userId,
          recipients: [authorId],
          title:
            action === 'APPROVED'
              ? 'Task Note approved & queued for SAG'
              : action === 'CHANGES_REQUESTED'
                ? 'Changes requested on Task Note'
                : 'Task Note rejected',
          message: comment
            ? `Reviewer feedback on "${noteTitle.slice(0, 60)}": ${comment}`
            : `Your Task Note "${noteTitle.slice(0, 60)}" was ${action.replace('_', ' ').toLowerCase()}.`,
          organizationId: actor.organizationId,
          projectId,
          target: {
            kind: 'WORK_NOTE',
            url: `/projects/${projectId}/work-notes`,
            organizationId: actor.organizationId,
            projectId,
            taskId,
            noteId,
          },
          eventKey: `task-note-review:${noteId}:${action}:${now.getTime()}`,
        })
        .catch(() => undefined);
    }

    return this.getProjectTaskNote(headers, projectId, noteId);
  }

  async resolveTaskNoteFileDownloadUrl(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<DocumentDownloadUrlResponse> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    const file = await this.ensureApprovedTaskNoteMarkdownStored(actor, row);
    return this.buildDownloadUrlResponse(file);
  }

  async downloadTaskNoteFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<{ bytes: Buffer; name: string; contentType: string }> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    const file = await this.ensureApprovedTaskNoteMarkdownStored(actor, row);
    if (file.bytes) {
      return {
        bytes: file.bytes,
        name: file.name,
        contentType: file.contentType,
      };
    }
    if (!this.documentStorage || !file.key) {
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    }
    return {
      bytes: await this.documentStorage.get(file.key),
      name: file.name,
      contentType: file.contentType,
    };
  }

  async getTaskNoteKnowledgeStatus(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    return this.resolveTaskNoteKnowledgeStatusForRow(actor, projectId, row);
  }

  async getTaskNoteKnowledgeChunks(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<DocumentKnowledgeChunksResponse> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    return this.resolveEntityKnowledgeChunks({
      actor,
      projectId,
      aggregateType: 'WORK_NOTE',
      entityId: noteId,
      versionNumber,
      rawProvenance: rawProv,
      options,
    });
  }

  async syncTaskNoteToSag(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const reviewStatus = (rawProv.review as { status?: string } | undefined)
      ?.status;

    // BE-LOGIC-001: Sync NEVER auto-approves or promotes unapproved Task Notes.
    if (reviewStatus !== 'APPROVED') {
      if (!actor.canReview) {
        throw new ForbiddenException({
          code: 'LEADER_APPROVAL_REQUIRED',
          message:
            'Only an approved Task Note can be synchronized to SAG. Submit it for Leader/Manager approval first.',
        });
      }
      throw conflict(
        'Only an approved Task Note can be synchronized to SAG. Approve it via the review workflow first.',
      );
    }

    return this.syncApprovedArtifactToSag({
      actor,
      projectId,
      aggregateType: 'WORK_NOTE',
      logicalPrefix: 'work_note',
      entityId: noteId,
      versionNumber,
      rawProvenance: rawProv,
      ensureStoredFile: () =>
        this.ensureApprovedTaskNoteMarkdownStored(actor, row),
      persistSync: (syncRecord) =>
        this.persistTaskNoteKnowledgeSyncRecord(
          noteId,
          versionNumber,
          syncRecord,
        ),
      auditAction: 'TASK_NOTE_KNOWLEDGE_SYNCED',
    });
  }

  async controlTaskNoteKnowledge(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
    action: DocumentKnowledgeControlAction,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedTaskNoteRow(
      headers,
      projectId,
      noteId,
    );
    const authorId = String(row.authorUserId);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const reviewStatus = (rawProv.review as { status?: string } | undefined)
      ?.status;
    // SEC-AUTH-007: Regular MEMBER authors cannot REVOKE/PAUSE/control approved SAG knowledge.
    const canControl =
      reviewStatus === 'APPROVED'
        ? Boolean(actor.canReview)
        : authorId === actor.userId || Boolean(actor.canReview);
    return this.controlEntityKnowledge({
      actor,
      projectId,
      aggregateType: 'WORK_NOTE',
      logicalPrefix: 'work_note',
      entityId: noteId,
      versionNumber,
      canControl,
      rawProvenance: rawProv,
      action,
      ensureStoredFile: () =>
        this.ensureApprovedTaskNoteMarkdownStored(actor, row),
      persistSync: (syncRecord) =>
        this.persistTaskNoteKnowledgeSyncRecord(
          noteId,
          versionNumber,
          syncRecord,
        ),
      resyncFn: () => this.syncTaskNoteToSag(headers, projectId, noteId),
      getStatusFn: () =>
        this.getTaskNoteKnowledgeStatus(headers, projectId, noteId),
      auditPrefix: 'TASK_NOTE',
    });
  }

  async listDocuments(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: DocumentStatus,
  ): Promise<WorkNotesPage<ProjectDocumentSummaryRecord>> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const statusFilter =
      status === undefined
        ? {}
        : status === 'APPROVED'
          ? {
              status: { $ne: 'ARCHIVED' },
              $or: [
                { status: 'APPROVED' },
                { latestApprovedVersionNumber: { $type: 'number' } },
              ],
            }
          : { status };
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      ...statusFilter,
    };
    const collection = this.database().collection('project_documents');
    const [rows, totalItems] = await Promise.all([
      collection
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);

    const versionByKey = new Map<string, DocumentVersionRecord>();
    const rawFileMetaByKey = new Map<
      string,
      { key?: string; sha256?: string }
    >();
    if (rows.length > 0) {
      const versionQueries = rows.map((row) => {
        const value = row as unknown as Record<string, unknown>;
        return {
          documentId: value._id as Types.ObjectId,
          versionNumber: Number(value.currentVersionNumber),
        };
      });
      const versionDocs = await this.database()
        .collection('project_document_versions')
        .find(
          {
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            $or: versionQueries,
          },
          { projection: { content: 0 } },
        )
        .toArray();
      for (const versionDoc of versionDocs) {
        const raw = versionDoc as unknown as Record<string, unknown>;
        const parsed = this.documentVersion(versionDoc);
        const mapKey = `${String(raw.documentId)}:${parsed.version}`;
        versionByKey.set(mapKey, parsed);
        const rawFile = raw.file as
          { key?: unknown; sha256?: unknown } | undefined;
        if (rawFile && typeof rawFile === 'object') {
          rawFileMetaByKey.set(mapKey, {
            ...(typeof rawFile.key === 'string' && rawFile.key.trim()
              ? { key: rawFile.key.trim() }
              : {}),
            ...(typeof rawFile.sha256 === 'string' && rawFile.sha256.trim()
              ? { sha256: rawFile.sha256.trim() }
              : {}),
          });
        }
      }
    }

    const storageRefsByDocId = await this.resolveStorageReferencesByDocument(
      actor.organizationId,
      projectId,
      rows.map((row) => {
        const raw = row as unknown as Record<string, unknown>;
        const docId = String(raw._id);
        const ver = Number(raw.currentVersionNumber);
        const meta = rawFileMetaByKey.get(`${docId}:${ver}`);
        return {
          documentId: docId,
          keys: meta?.key ? [meta.key] : [],
          ...(meta?.sha256 ? { currentSha256: meta.sha256 } : {}),
        };
      }),
    );

    const summaries = rows.map((row) => {
      const summary = this.documentSummary(row, actor);
      const currentVersion = versionByKey.get(
        `${summary.id}:${summary.version}`,
      );
      const storageRef = storageRefsByDocId.get(summary.id);
      if (!currentVersion) {
        return storageRef
          ? { ...summary, storageReference: storageRef }
          : summary;
      }
      return {
        ...summary,
        ...(currentVersion.file ? { file: currentVersion.file } : {}),
        ...(storageRef ? { storageReference: storageRef } : {}),
        ...(currentVersion.submittedAt
          ? { submittedAt: currentVersion.submittedAt }
          : {}),
        ...(currentVersion.reviewedBy
          ? { reviewedBy: currentVersion.reviewedBy }
          : {}),
        ...(currentVersion.reviewedAt
          ? { reviewedAt: currentVersion.reviewedAt }
          : {}),
        ...(typeof currentVersion.reviewComment === 'string'
          ? { reviewComment: currentVersion.reviewComment }
          : {}),
      };
    });

    // BE-PERF-001: Serve persisted knowledgeSync on list GET (no 25 synchronous live SAG HTTP calls).
    return {
      data: summaries,
      pagination: this.pagination(page, pageSize, totalItems),
    };
  }

  async listAiChatProjectSources(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
  ): Promise<AiChatProjectDocumentSourcesResponse> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const organizationObjectId = objectId(actor.organizationId);
    const projectObjectId = objectId(actor.projectId);
    const filter = {
      organizationId: organizationObjectId,
      projectId: projectObjectId,
    };
    const documentsCollection = this.database().collection('project_documents');
    const [pageRows, totalCount, allRows] = await Promise.all([
      documentsCollection
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      documentsCollection.countDocuments(filter),
      documentsCollection
        .find(filter, {
          projection: {
            _id: 1,
            status: 1,
            currentVersionNumber: 1,
            latestApprovedVersionNumber: 1,
            knowledgeSync: 1,
          },
        })
        .toArray(),
    ]);

    type ReadinessCandidate = {
      documentId: string;
      documentObjectId: Types.ObjectId;
      approvedVersion: number;
      currentVersion: number;
      storedSync: unknown;
    };
    const candidateByDocumentId = new Map<string, ReadinessCandidate>();
    const candidates: ReadinessCandidate[] = allRows.flatMap((row) => {
      const value = row as unknown as Record<string, unknown>;
      const status = text(value.status).toUpperCase();
      const currentVersion = positiveInteger(value.currentVersionNumber);
      const latestApproved = positiveInteger(value.latestApprovedVersionNumber);
      const approvedVersion =
        status === 'ARCHIVED'
          ? null
          : (latestApproved ?? (status === 'APPROVED' ? currentVersion : null));
      if (!approvedVersion || !(value._id instanceof Types.ObjectId)) {
        return [];
      }
      const candidate: ReadinessCandidate = {
        documentId: value._id.toHexString(),
        documentObjectId: value._id,
        approvedVersion,
        currentVersion: currentVersion ?? approvedVersion,
        storedSync: value.knowledgeSync,
      };
      candidateByDocumentId.set(candidate.documentId, candidate);
      return [candidate];
    });

    const versionCollection = this.database().collection(
      'project_document_versions',
    );
    const approvedVersionByKey = new Map<string, Record<string, unknown>>();
    for (
      let offset = 0;
      offset < candidates.length;
      offset += PROJECT_SOURCE_READINESS_BATCH_SIZE
    ) {
      const batch = candidates.slice(
        offset,
        offset + PROJECT_SOURCE_READINESS_BATCH_SIZE,
      );
      const rows = await versionCollection
        .find({
          organizationId: organizationObjectId,
          projectId: projectObjectId,
          $or: batch.map((candidate) => ({
            documentId: candidate.documentObjectId,
            versionNumber: candidate.approvedVersion,
          })),
        })
        .project({
          documentId: 1,
          versionNumber: 1,
          knowledgeSync: 1,
          file: 1,
        })
        .toArray();
      for (const row of rows) {
        const value = row as unknown as Record<string, unknown>;
        approvedVersionByKey.set(
          `${idText(value.documentId)}:${Number(value.versionNumber)}`,
          value,
        );
      }
    }

    const readinessByDocumentId = new Map<
      string,
      AiChatProjectDocumentReadinessStatus
    >();
    const candidatesToVerify: Array<
      ReadinessCandidate & { sagDocumentId: string; sagVersionNo: number }
    > = [];
    let verificationAvailable = true;
    let verifiedAt: string | null = new Date().toISOString();

    for (const candidate of candidates) {
      const approvedVersionRow = approvedVersionByKey.get(
        `${candidate.documentId}:${candidate.approvedVersion}`,
      );
      const versionSync =
        approvedVersionRow?.knowledgeSync &&
        typeof approvedVersionRow.knowledgeSync === 'object'
          ? (approvedVersionRow.knowledgeSync as Record<string, unknown>)
          : undefined;
      const documentSync =
        candidate.storedSync && typeof candidate.storedSync === 'object'
          ? (candidate.storedSync as Record<string, unknown>)
          : undefined;
      const matchingDocumentSync =
        positiveInteger(documentSync?.version) === candidate.approvedVersion
          ? documentSync
          : undefined;
      const sync = { ...matchingDocumentSync, ...versionSync };
      const sagDocumentId =
        typeof sync.sagDocumentId === 'string' ? sync.sagDocumentId.trim() : '';
      const sagVersionNo = positiveInteger(sync.sagVersionNo);

      if (sagDocumentId && sagVersionNo) {
        candidatesToVerify.push({
          ...candidate,
          sagDocumentId,
          sagVersionNo,
        });
        continue;
      }

      const syncStatus =
        `${text(sync.status)} ${text(sync.searchStatus)}`.toUpperCase();
      const storedReady =
        sync.searchReady === true ||
        /\b(READY|SEARCH_READY)\b/.test(syncStatus);
      if (storedReady) {
        verificationAvailable = false;
        readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
      } else if (/\b(REVOKED)\b/.test(syncStatus)) {
        readinessByDocumentId.set(candidate.documentId, 'REVOKED');
      } else if (/\b(FAILED|INDEX_FAILED)\b/.test(syncStatus)) {
        readinessByDocumentId.set(candidate.documentId, 'FAILED');
      } else if (
        /\b(PENDING|PROCESSING|RUNNING|QUEUED|INDEXING)\b/.test(syncStatus)
      ) {
        readinessByDocumentId.set(candidate.documentId, 'PROCESSING');
      } else {
        readinessByDocumentId.set(candidate.documentId, 'NOT_INDEXED');
      }
    }

    if (
      candidatesToVerify.length > 0 &&
      typeof this.sagTransport?.getProjectDocumentReadinessBatch !== 'function'
    ) {
      verificationAvailable = false;
      for (const candidate of candidatesToVerify) {
        readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
      }
    } else if (this.sagTransport?.getProjectDocumentReadinessBatch) {
      for (
        let offset = 0;
        offset < candidatesToVerify.length;
        offset += PROJECT_SOURCE_READINESS_BATCH_SIZE
      ) {
        const batch = candidatesToVerify.slice(
          offset,
          offset + PROJECT_SOURCE_READINESS_BATCH_SIZE,
        );
        try {
          const receipt =
            await this.sagTransport.getProjectDocumentReadinessBatch({
              organizationId: actor.organizationId,
              projectId: actor.projectId,
              actorUserId: actor.userId,
              documents: batch.map((candidate) => ({
                documentId: candidate.sagDocumentId,
                versionNo: candidate.sagVersionNo,
              })),
            });
          verifiedAt = receipt.verifiedAt;
          const liveByKey = new Map(
            receipt.items.map((item) => [
              `${item.documentId}:${item.versionNo}`,
              item,
            ]),
          );
          for (const candidate of batch) {
            const live = liveByKey.get(
              `${candidate.sagDocumentId}:${candidate.sagVersionNo}`,
            );
            if (!live) {
              verificationAvailable = false;
              verifiedAt = null;
              readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
              continue;
            }
            let readiness: AiChatProjectDocumentReadinessStatus = 'NOT_INDEXED';
            const liveStatus =
              `${live.status} ${live.searchStatus} ${live.documentStatus ?? ''}`.toUpperCase();
            if (live.found && live.searchReady && live.chunkCount > 0) {
              readiness = 'READY';
            } else if (/\b(REVOKED)\b/.test(liveStatus)) {
              readiness = 'REVOKED';
            } else if (/\b(FAILED|INDEX_FAILED)\b/.test(liveStatus)) {
              readiness = 'FAILED';
            } else if (
              /\b(PENDING|PROCESSING|RUNNING|QUEUED|INDEXING)\b/.test(
                liveStatus,
              )
            ) {
              readiness = 'PROCESSING';
            }
            readinessByDocumentId.set(candidate.documentId, readiness);
          }
        } catch {
          verificationAvailable = false;
          verifiedAt = null;
          for (const candidate of batch) {
            readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
          }
        }
      }
    }

    const pageVersionQueries = pageRows.flatMap((row) => {
      const value = row as unknown as Record<string, unknown>;
      if (!(value._id instanceof Types.ObjectId)) return [];
      const currentVersion = positiveInteger(value.currentVersionNumber);
      const approvedVersion = candidateByDocumentId.get(
        value._id.toHexString(),
      )?.approvedVersion;
      const versions = new Set(
        [currentVersion, approvedVersion].filter(
          (version): version is number =>
            version !== null && version !== undefined,
        ),
      );
      return [...versions].map((versionNumber) => ({
        documentId: value._id as Types.ObjectId,
        versionNumber,
      }));
    });
    const pageVersions = pageVersionQueries.length
      ? await versionCollection
          .find({
            organizationId: organizationObjectId,
            projectId: projectObjectId,
            $or: pageVersionQueries,
          })
          .project({ documentId: 1, versionNumber: 1, file: 1 })
          .toArray()
      : [];
    const pageVersionByKey = new Map<string, Record<string, unknown>>();
    for (const row of pageVersions) {
      const value = row as unknown as Record<string, unknown>;
      pageVersionByKey.set(
        `${idText(value.documentId)}:${Number(value.versionNumber)}`,
        value,
      );
    }

    const items: AiChatProjectDocumentSourceRecord[] = pageRows.map((row) => {
      const value = row as unknown as Record<string, unknown>;
      const documentId = idText(value._id);
      const approvalStatus = text(value.status).toUpperCase() as DocumentStatus;
      const currentVersion = positiveInteger(value.currentVersionNumber) ?? 1;
      const approvedVersion =
        approvalStatus === 'ARCHIVED'
          ? null
          : (candidateByDocumentId.get(documentId)?.approvedVersion ?? null);
      const approvedVersionRow = approvedVersion
        ? pageVersionByKey.get(`${documentId}:${approvedVersion}`)
        : undefined;
      const currentVersionRow = pageVersionByKey.get(
        `${documentId}:${currentVersion}`,
      );
      const approvedFile = approvedVersionRow?.file;
      const currentFile = currentVersionRow?.file;
      const fileName =
        approvedFile && typeof approvedFile === 'object'
          ? text((approvedFile as Record<string, unknown>).name).trim()
          : currentFile && typeof currentFile === 'object'
            ? text((currentFile as Record<string, unknown>).name).trim()
            : '';
      const readinessStatus: AiChatProjectDocumentReadinessStatus =
        approvalStatus === 'ARCHIVED'
          ? 'ARCHIVED'
          : approvedVersion === null
            ? 'NOT_APPROVED'
            : (readinessByDocumentId.get(documentId) ?? 'NOT_INDEXED');
      const source: AiChatProjectDocumentSourceRecord = {
        documentId,
        title: text(value.title).slice(0, 500),
        type: text(
          value.documentType,
        ) as AiChatProjectDocumentSourceRecord['type'],
        approvalStatus,
        currentVersion,
        approvedVersion,
        readinessStatus,
        updatedAt: iso(value.updatedAt) ?? new Date(0).toISOString(),
      };
      return fileName
        ? { ...source, fileName: fileName.slice(0, 512) }
        : source;
    });

    return {
      data: items,
      pagination: this.pagination(page, pageSize, totalCount),
      summary: {
        totalCount,
        readyCount: verificationAvailable
          ? candidates.filter(
              (candidate) =>
                readinessByDocumentId.get(candidate.documentId) === 'READY',
            ).length
          : null,
        verificationStatus: verificationAvailable ? 'VERIFIED' : 'UNAVAILABLE',
        verifiedAt: verificationAvailable ? verifiedAt : null,
      },
    };
  }

  async listAiChatAllProjectsSources(
    scope: Readonly<{
      actorId: string;
      organizationId: string;
      projects: ReadonlyArray<{ id: string; code: string; name: string }>;
    }>,
    page: number,
    pageSize: number,
  ): Promise<AiChatProjectDocumentSourcesResponse> {
    if (scope.projects.length === 0) {
      return {
        data: [],
        pagination: this.pagination(page, pageSize, 0),
        summary: {
          totalCount: 0,
          readyCount: 0,
          verificationStatus: 'VERIFIED',
          verifiedAt: new Date().toISOString(),
        },
      };
    }

    const organizationObjectId = objectId(scope.organizationId);
    const projectById = new Map(scope.projects.map((p) => [p.id, p]));
    const projectObjectIds = scope.projects.map((p) => objectId(p.id));
    const filter = {
      organizationId: organizationObjectId,
      projectId: { $in: projectObjectIds },
    };
    const documentsCollection = this.database().collection('project_documents');
    const [pageRows, totalCount, allRows] = await Promise.all([
      documentsCollection
        .find(filter)
        .sort({ updatedAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      documentsCollection.countDocuments(filter),
      documentsCollection
        .find(filter, {
          projection: {
            _id: 1,
            projectId: 1,
            status: 1,
            currentVersionNumber: 1,
            latestApprovedVersionNumber: 1,
            knowledgeSync: 1,
          },
        })
        .toArray(),
    ]);

    type AllProjectsReadinessCandidate = {
      documentId: string;
      documentObjectId: Types.ObjectId;
      projectId: string;
      approvedVersion: number;
      currentVersion: number;
      storedSync: unknown;
    };
    const candidateByDocumentId = new Map<
      string,
      AllProjectsReadinessCandidate
    >();
    const candidates: AllProjectsReadinessCandidate[] = allRows.flatMap(
      (row) => {
        const value = row as unknown as Record<string, unknown>;
        const status = text(value.status).toUpperCase();
        const currentVersion = positiveInteger(value.currentVersionNumber);
        const latestApproved = positiveInteger(
          value.latestApprovedVersionNumber,
        );
        const approvedVersion =
          status === 'ARCHIVED'
            ? null
            : (latestApproved ??
              (status === 'APPROVED' ? currentVersion : null));
        if (!approvedVersion || !(value._id instanceof Types.ObjectId)) {
          return [];
        }
        const candidate: AllProjectsReadinessCandidate = {
          documentId: value._id.toHexString(),
          documentObjectId: value._id,
          projectId: idText(value.projectId),
          approvedVersion,
          currentVersion: currentVersion ?? approvedVersion,
          storedSync: value.knowledgeSync,
        };
        candidateByDocumentId.set(candidate.documentId, candidate);
        return [candidate];
      },
    );

    const versionCollection = this.database().collection(
      'project_document_versions',
    );
    const approvedVersionByKey = new Map<string, Record<string, unknown>>();
    for (
      let offset = 0;
      offset < candidates.length;
      offset += PROJECT_SOURCE_READINESS_BATCH_SIZE
    ) {
      const batch = candidates.slice(
        offset,
        offset + PROJECT_SOURCE_READINESS_BATCH_SIZE,
      );
      const rows = await versionCollection
        .find({
          organizationId: organizationObjectId,
          projectId: { $in: projectObjectIds },
          $or: batch.map((candidate) => ({
            documentId: candidate.documentObjectId,
            versionNumber: candidate.approvedVersion,
          })),
        })
        .project({
          documentId: 1,
          versionNumber: 1,
          knowledgeSync: 1,
          file: 1,
        })
        .toArray();
      for (const row of rows) {
        const value = row as unknown as Record<string, unknown>;
        approvedVersionByKey.set(
          `${idText(value.documentId)}:${Number(value.versionNumber)}`,
          value,
        );
      }
    }

    const readinessByDocumentId = new Map<
      string,
      AiChatProjectDocumentReadinessStatus
    >();
    const candidatesByProject = new Map<
      string,
      Array<
        AllProjectsReadinessCandidate & {
          sagDocumentId: string;
          sagVersionNo: number;
        }
      >
    >();
    let verificationAvailable = true;
    let verifiedAt: string | null = new Date().toISOString();

    for (const candidate of candidates) {
      const approvedVersionRow = approvedVersionByKey.get(
        `${candidate.documentId}:${candidate.approvedVersion}`,
      );
      const versionSync =
        approvedVersionRow?.knowledgeSync &&
        typeof approvedVersionRow.knowledgeSync === 'object'
          ? (approvedVersionRow.knowledgeSync as Record<string, unknown>)
          : undefined;
      const documentSync =
        candidate.storedSync && typeof candidate.storedSync === 'object'
          ? (candidate.storedSync as Record<string, unknown>)
          : undefined;
      const matchingDocumentSync =
        positiveInteger(documentSync?.version) === candidate.approvedVersion
          ? documentSync
          : undefined;
      const sync = { ...matchingDocumentSync, ...versionSync };
      const sagDocumentId =
        typeof sync.sagDocumentId === 'string' ? sync.sagDocumentId.trim() : '';
      const sagVersionNo = positiveInteger(sync.sagVersionNo);

      if (sagDocumentId && sagVersionNo) {
        const list = candidatesByProject.get(candidate.projectId) ?? [];
        list.push({
          ...candidate,
          sagDocumentId,
          sagVersionNo,
        });
        candidatesByProject.set(candidate.projectId, list);
        continue;
      }

      const syncStatus =
        `${text(sync.status)} ${text(sync.searchStatus)}`.toUpperCase();
      const storedReady =
        sync.searchReady === true ||
        /\b(READY|SEARCH_READY)\b/.test(syncStatus);
      if (storedReady) {
        verificationAvailable = false;
        readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
      } else if (/\b(REVOKED)\b/.test(syncStatus)) {
        readinessByDocumentId.set(candidate.documentId, 'REVOKED');
      } else if (/\b(FAILED|INDEX_FAILED)\b/.test(syncStatus)) {
        readinessByDocumentId.set(candidate.documentId, 'FAILED');
      } else if (
        /\b(PENDING|PROCESSING|RUNNING|QUEUED|INDEXING)\b/.test(syncStatus)
      ) {
        readinessByDocumentId.set(candidate.documentId, 'PROCESSING');
      } else {
        readinessByDocumentId.set(candidate.documentId, 'NOT_INDEXED');
      }
    }

    if (
      candidatesByProject.size > 0 &&
      typeof this.sagTransport?.getProjectDocumentReadinessBatch !== 'function'
    ) {
      verificationAvailable = false;
      for (const projectBatch of candidatesByProject.values()) {
        for (const candidate of projectBatch) {
          readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
        }
      }
    } else if (this.sagTransport?.getProjectDocumentReadinessBatch) {
      const transport = this.sagTransport;
      const readinessBatches: Array<{
        projId: string;
        batch: Array<{
          documentId: string;
          sagDocumentId: string;
          sagVersionNo: number;
        }>;
      }> = [];
      for (const [projId, projectCandidates] of candidatesByProject.entries()) {
        for (
          let offset = 0;
          offset < projectCandidates.length;
          offset += PROJECT_SOURCE_READINESS_BATCH_SIZE
        ) {
          readinessBatches.push({
            projId,
            batch: projectCandidates.slice(
              offset,
              offset + PROJECT_SOURCE_READINESS_BATCH_SIZE,
            ),
          });
        }
      }
      // BE-PERF-001: Parallelize per-project readiness batches with bounded concurrency.
      await runWithConcurrency(
        readinessBatches,
        5,
        async ({ projId, batch }) => {
          try {
            const receipt = await transport.getProjectDocumentReadinessBatch!({
              organizationId: scope.organizationId,
              projectId: projId,
              actorUserId: scope.actorId,
              documents: batch.map((candidate) => ({
                documentId: candidate.sagDocumentId,
                versionNo: candidate.sagVersionNo,
              })),
            });
            verifiedAt = receipt.verifiedAt;
            const liveByKey = new Map(
              receipt.items.map((item) => [
                `${item.documentId}:${item.versionNo}`,
                item,
              ]),
            );
            for (const candidate of batch) {
              const live = liveByKey.get(
                `${candidate.sagDocumentId}:${candidate.sagVersionNo}`,
              );
              if (!live) {
                verificationAvailable = false;
                verifiedAt = null;
                readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
                continue;
              }
              let readiness: AiChatProjectDocumentReadinessStatus =
                'NOT_INDEXED';
              const liveStatus =
                `${live.status} ${live.searchStatus} ${live.documentStatus ?? ''}`.toUpperCase();
              if (live.found && live.searchReady && live.chunkCount > 0) {
                readiness = 'READY';
              } else if (/\b(REVOKED)\b/.test(liveStatus)) {
                readiness = 'REVOKED';
              } else if (/\b(FAILED|INDEX_FAILED)\b/.test(liveStatus)) {
                readiness = 'FAILED';
              } else if (
                /\b(PENDING|PROCESSING|RUNNING|QUEUED|INDEXING)\b/.test(
                  liveStatus,
                )
              ) {
                readiness = 'PROCESSING';
              }
              readinessByDocumentId.set(candidate.documentId, readiness);
            }
          } catch {
            verificationAvailable = false;
            verifiedAt = null;
            for (const candidate of batch) {
              readinessByDocumentId.set(candidate.documentId, 'UNVERIFIED');
            }
          }
        },
      );
    }

    const pageVersionQueries = pageRows.flatMap((row) => {
      const value = row as unknown as Record<string, unknown>;
      if (!(value._id instanceof Types.ObjectId)) return [];
      const currentVersion = positiveInteger(value.currentVersionNumber);
      const approvedVersion = candidateByDocumentId.get(
        value._id.toHexString(),
      )?.approvedVersion;
      const versions = new Set(
        [currentVersion, approvedVersion].filter(
          (version): version is number =>
            version !== null && version !== undefined,
        ),
      );
      return [...versions].map((versionNumber) => ({
        documentId: value._id as Types.ObjectId,
        versionNumber,
      }));
    });
    const pageVersions = pageVersionQueries.length
      ? await versionCollection
          .find({
            organizationId: organizationObjectId,
            projectId: { $in: projectObjectIds },
            $or: pageVersionQueries,
          })
          .project({ documentId: 1, versionNumber: 1, file: 1 })
          .toArray()
      : [];
    const pageVersionByKey = new Map<string, Record<string, unknown>>();
    for (const row of pageVersions) {
      const value = row as unknown as Record<string, unknown>;
      pageVersionByKey.set(
        `${idText(value.documentId)}:${Number(value.versionNumber)}`,
        value,
      );
    }

    const items: AiChatProjectDocumentSourceRecord[] = pageRows.map((row) => {
      const value = row as unknown as Record<string, unknown>;
      const documentId = idText(value._id);
      const docProjectId = idText(value.projectId);
      const projectMeta = projectById.get(docProjectId);
      const approvalStatus = text(value.status).toUpperCase() as DocumentStatus;
      const currentVersion = positiveInteger(value.currentVersionNumber) ?? 1;
      const approvedVersion =
        approvalStatus === 'ARCHIVED'
          ? null
          : (candidateByDocumentId.get(documentId)?.approvedVersion ?? null);
      const approvedVersionRow = approvedVersion
        ? pageVersionByKey.get(`${documentId}:${approvedVersion}`)
        : undefined;
      const currentVersionRow = pageVersionByKey.get(
        `${documentId}:${currentVersion}`,
      );
      const approvedFile = approvedVersionRow?.file;
      const currentFile = currentVersionRow?.file;
      const fileName =
        approvedFile && typeof approvedFile === 'object'
          ? text((approvedFile as Record<string, unknown>).name).trim()
          : currentFile && typeof currentFile === 'object'
            ? text((currentFile as Record<string, unknown>).name).trim()
            : '';
      const readinessStatus: AiChatProjectDocumentReadinessStatus =
        approvalStatus === 'ARCHIVED'
          ? 'ARCHIVED'
          : approvedVersion === null
            ? 'NOT_APPROVED'
            : (readinessByDocumentId.get(documentId) ?? 'NOT_INDEXED');
      const source: AiChatProjectDocumentSourceRecord = {
        documentId,
        projectId: projectMeta?.id ?? docProjectId,
        ...(projectMeta?.code ? { projectCode: projectMeta.code } : {}),
        ...(projectMeta?.name ? { projectName: projectMeta.name } : {}),
        title: text(value.title).slice(0, 500),
        type: text(
          value.documentType,
        ) as AiChatProjectDocumentSourceRecord['type'],
        approvalStatus,
        currentVersion,
        approvedVersion,
        readinessStatus,
        updatedAt: iso(value.updatedAt) ?? new Date(0).toISOString(),
      };
      return fileName
        ? { ...source, fileName: fileName.slice(0, 512) }
        : source;
    });

    return {
      data: items,
      pagination: this.pagination(page, pageSize, totalCount),
      summary: {
        totalCount,
        readyCount: verificationAvailable
          ? candidates.filter(
              (candidate) =>
                readinessByDocumentId.get(candidate.documentId) === 'READY',
            ).length
          : null,
        verificationStatus: verificationAvailable ? 'VERIFIED' : 'UNAVAILABLE',
        verifiedAt: verificationAvailable ? verifiedAt : null,
      },
    };
  }

  async createDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: ProjectDocumentInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CREATE_FORBIDDEN',
        message:
          'Only Project Members and Project Leaders can create Project Documents.',
      });
    }
    const id = new Types.ObjectId();
    const versionId = new Types.ObjectId();
    const now = new Date();
    await this.transaction(async (db, session) => {
      await db.collection('project_documents').insertOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          title: input.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          documentType: input.type,
          createdByUserId: objectId(actor.userId),
          updatedByUserId: objectId(actor.userId),
          currentVersionNumber: 1,
          status: 'DRAFT',
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await db.collection('project_document_versions').insertOne(
        {
          _id: versionId,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          documentId: id,
          versionNumber: 1,
          title: input.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          documentType: input.type,
          content: input.content,
          status: 'DRAFT',
          editedByUserId: objectId(actor.userId),
          reviewHistory: [],
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_DRAFT_CREATED',
        'PROJECT_DOCUMENT',
        String(id),
        { version: 1 },
        session,
      );
    });
    const created = await this.readDocument(actor, id);
    if (!created) throw documentNotFound();
    return created;
  }

  async getDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const result = await this.readDocument(actor, objectId(documentId));
    if (!result) throw documentNotFound();
    return result;
  }

  async uploadDocumentFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    name: string,
    contentType: string,
    bytes: Buffer,
    options?: { expectedSha256?: string; autoSyncSag?: boolean },
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const cleanName = name.trim();
    const resolvedContentType =
      bytes.length > 0 &&
      bytes.length <= 20 * 1024 * 1024 &&
      cleanName.length > 0 &&
      cleanName.length <= 180 &&
      !/[\\/]/.test(cleanName) &&
      ![...cleanName].some((character) => character.charCodeAt(0) < 32)
        ? resolveValidatedDocumentContentType(cleanName, contentType, bytes)
        : null;
    if (!resolvedContentType)
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message:
          'A supported document file (PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, MD, CSV, TSV, JSON, YAML, XML, SQL, DRAWIO, PNG, JPG, WEBP) up to 20 MB is required.',
      });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expectedSha256 = options?.expectedSha256?.trim().toLowerCase();
    if (expectedSha256 && expectedSha256 !== sha256) {
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_CHECKSUM_MISMATCH',
        message: 'Uploaded file content does not match declared SHA-256 hash.',
      });
    }
    const id = objectId(documentId);
    const documents = this.database().collection('project_documents');
    const document = await documents.findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      createdByUserId: objectId(actor.userId),
    });
    if (!document) throw documentNotFound();
    const versionNumber = Number(document.currentVersionNumber);
    const versions = this.database().collection('project_document_versions');
    const previousVersion = await versions.findOne({
      documentId: id,
      versionNumber,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      editedByUserId: objectId(actor.userId),
    });
    if (!previousVersion) throw documentNotFound();
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    const existingWithSameHash = await versions.findOne({
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      'file.sha256': sha256,
      'file.key': { $type: 'string', $ne: '' },
    });
    const existingKeyRaw = (
      existingWithSameHash?.file as { key?: string } | undefined
    )?.key;
    const expectedProjectPrefix = `work-notes/${actor.organizationId}/${projectId}/`;
    const existingKey =
      existingKeyRaw && existingKeyRaw.startsWith(expectedProjectPrefix)
        ? existingKeyRaw
        : undefined;
    let existingStoredValid = Boolean(existingKey);
    if (
      existingKey &&
      typeof this.documentStorage.inspectStoredPrefix === 'function'
    ) {
      const inspected = await this.documentStorage
        .inspectStoredPrefix(existingKey, 64)
        .catch(() => null);
      existingStoredValid = Boolean(
        inspected && inspected.size === bytes.length,
      );
    }
    const reusedExistingKey = Boolean(existingKey && existingStoredValid);
    const key =
      (reusedExistingKey ? existingKey : undefined) ||
      `work-notes/${actor.organizationId}/${projectId}/${documentId}/${randomUUID()}`;
    if (!reusedExistingKey) {
      await this.documentStorage
        .put(key, bytes, resolvedContentType)
        .catch((err: { code?: string }) => {
          if (err?.code !== 'EEXIST') throw err;
        });
    }
    try {
      await this.transaction(async (db, session) => {
        const result = await db
          .collection('project_document_versions')
          .updateOne(
            {
              documentId: id,
              versionNumber,
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              status: 'DRAFT',
              editedByUserId: objectId(actor.userId),
              updatedAt: previousVersion.updatedAt,
            },
            {
              $set: {
                file: {
                  key,
                  name: cleanName,
                  contentType: resolvedContentType,
                  size: bytes.length,
                  sha256,
                },
                updatedAt: new Date(),
              },
            },
            { session },
          );
        if (result.modifiedCount !== 1)
          throw conflict('The Document changed during upload.');
        await this.auditEvent(
          actor,
          'DOCUMENT_FILE_UPLOADED',
          'PROJECT_DOCUMENT',
          documentId,
          {
            version: versionNumber,
            fileName: cleanName,
            size: bytes.length,
            sha256,
            deduplicated: reusedExistingKey,
          },
          session,
        );
      });
    } catch (error) {
      if (!reusedExistingKey) {
        await this.documentStorage.delete(key).catch(() => undefined);
      }
      throw error;
    }
    const oldKey = (previousVersion.file as { key?: string } | undefined)?.key;
    if (
      oldKey &&
      oldKey !== key &&
      !(await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        oldKey,
        { excludeDocumentVersionId: String(previousVersion._id) },
      ))
    )
      await this.documentStorage.delete(oldKey).catch(() => undefined);
    // BE-LOGIC-001: Uploading a file NEVER auto-approves or bypasses review (ignore autoSyncSag).
    const updated = await this.readDocument(actor, id);
    if (!updated) throw documentNotFound();
    return updated;
  }

  async createDocumentUploadIntent(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: DocumentUploadIntentInput,
  ): Promise<DocumentUploadIntentResponse> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const cleanName = input.fileName.trim();
    const sha256 = input.sha256.trim().toLowerCase();
    const rule =
      input.size > 0 &&
      input.size <= 20 * 1024 * 1024 &&
      cleanName.length > 0 &&
      cleanName.length <= 180 &&
      !/[\\/]/.test(cleanName) &&
      ![...cleanName].some((character) => character.charCodeAt(0) < 32) &&
      /^[a-f0-9]{64}$/.test(sha256)
        ? resolveDocumentFormatRule(cleanName, input.contentType)
        : null;
    if (!rule) {
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message:
          'A supported document file (PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, MD, CSV, TSV, JSON, YAML, XML, SQL, DRAWIO, PNG, JPG, WEBP) up to 20 MB is required.',
      });
    }

    const id = objectId(documentId);
    const db = this.database();
    const document = await db.collection('project_documents').findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      createdByUserId: objectId(actor.userId),
    });
    if (!document) throw documentNotFound();

    const versionNumber = Number(document.currentVersionNumber);
    const versions = db.collection('project_document_versions');
    const draftVersion = await versions.findOne({
      documentId: id,
      versionNumber,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      editedByUserId: objectId(actor.userId),
    });
    if (!draftVersion) throw documentNotFound();

    if (!this.documentStorage) {
      return {
        mode: 'LEGACY_PROXY',
        canonicalContentType: rule.canonicalContentType,
      };
    }

    const expiresInSeconds = Math.max(
      60,
      Math.min(
        3600,
        Number(
          this.config?.get<number>('R2_PRESIGNED_UPLOAD_TTL_SECONDS') ?? 900,
        ) || 900,
      ),
    );
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

    // SEC-AUTH-002 / BE-DATA-001: Strictly scope SHA-256 deduplication by BOTH
    // organizationId AND projectId, and require project-scoped storage key prefix.
    const expectedProjectPrefix = `work-notes/${actor.organizationId}/${projectId}/`;
    const existingWithSameHash = await versions.findOne({
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      'file.sha256': sha256,
      'file.size': input.size,
      'file.key': { $type: 'string', $ne: '' },
    });
    const existingKeyRaw = (
      existingWithSameHash?.file as { key?: string } | undefined
    )?.key;
    const existingKey =
      existingKeyRaw && existingKeyRaw.startsWith(expectedProjectPrefix)
        ? existingKeyRaw
        : undefined;
    if (
      existingKey &&
      typeof this.documentStorage.inspectStoredPrefix === 'function'
    ) {
      const existingStored = await this.documentStorage
        .inspectStoredPrefix(existingKey, 64)
        .catch(() => null);
      if (
        existingStored &&
        existingStored.size === input.size &&
        resolveValidatedDocumentContentType(
          cleanName,
          rule.canonicalContentType,
          existingStored.prefix,
        ) === rule.canonicalContentType
      ) {
        const uploadToken = this.signDocumentUploadClaims({
          jti: randomUUID(),
          orgId: actor.organizationId,
          projId: projectId,
          docId: documentId,
          userId: actor.userId,
          key: existingKey,
          fileName: cleanName,
          contentType: rule.canonicalContentType,
          size: input.size,
          sha256,
          deduplicated: true,
          exp,
        });
        return {
          mode: 'DEDUPLICATED',
          uploadToken,
          expiresInSeconds,
          canonicalContentType: rule.canonicalContentType,
        };
      }
    }

    if (
      typeof this.documentStorage.isDirectCloudEnabled !== 'function' ||
      !this.documentStorage.isDirectCloudEnabled()
    ) {
      return {
        mode: 'LEGACY_PROXY',
        canonicalContentType: rule.canonicalContentType,
      };
    }

    const key = `work-notes/${actor.organizationId}/${projectId}/${documentId}/${randomUUID()}`;
    const checksumSha256Base64 = Buffer.from(sha256, 'hex').toString('base64');
    const uploadUrl = await this.documentStorage.createDirectUploadUrl(
      key,
      rule.canonicalContentType,
      expiresInSeconds,
      {
        contentLength: input.size,
        checksumSha256Base64,
      },
    );
    const uploadToken = this.signDocumentUploadClaims({
      jti: randomUUID(),
      orgId: actor.organizationId,
      projId: projectId,
      docId: documentId,
      userId: actor.userId,
      key,
      fileName: cleanName,
      contentType: rule.canonicalContentType,
      size: input.size,
      sha256,
      deduplicated: false,
      exp,
    });

    return {
      mode: 'DIRECT_PUT',
      uploadToken,
      uploadUrl,
      headers: {
        'Content-Type': rule.canonicalContentType,
        'x-amz-checksum-sha256': checksumSha256Base64,
      },
      expiresInSeconds,
      canonicalContentType: rule.canonicalContentType,
    };
  }

  async confirmDocumentUpload(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: DocumentConfirmUploadInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const claims = this.verifyDocumentUploadClaims(input.uploadToken);
    const expectedProjectPrefix = `work-notes/${actor.organizationId}/${projectId}/`;
    if (
      claims.orgId !== actor.organizationId ||
      claims.projId !== projectId ||
      claims.docId !== documentId ||
      claims.userId !== actor.userId ||
      !claims.key.startsWith(expectedProjectPrefix)
    ) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token does not match the target document or user.',
      });
    }
    await this.consumeUploadTokenJti(claims.jti, claims.exp);
    if (!this.documentStorage) {
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    }

    // SEC-AUTH-002 / BE-DATA-001 / SEC-BE-011: Verify FULL object SHA-256,
    // exact byte length, and full format/structure (never trust 64-byte prefix alone).
    let fullBytes: Buffer | null = null;
    if (typeof this.documentStorage.get === 'function') {
      fullBytes = await this.documentStorage.get(claims.key).catch(() => null);
    }
    if (!fullBytes) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_NOT_FOUND',
        message: 'Uploaded file was not found in cloud storage.',
      });
    }

    const actualSha256 = createHash('sha256').update(fullBytes).digest('hex');
    const validatedContentType =
      fullBytes.length === claims.size &&
      fullBytes.length > 0 &&
      fullBytes.length <= 20 * 1024 * 1024 &&
      actualSha256 === claims.sha256.toLowerCase()
        ? resolveValidatedDocumentContentType(
            claims.fileName,
            claims.contentType,
            fullBytes,
          )
        : null;
    if (validatedContentType !== claims.contentType) {
      if (!claims.deduplicated) {
        await this.documentStorage.delete(claims.key).catch(() => undefined);
      }
      throw new BadRequestException({
        code:
          actualSha256 !== claims.sha256.toLowerCase()
            ? 'DOCUMENT_FILE_CHECKSUM_MISMATCH'
            : 'DOCUMENT_FILE_INVALID',
        message:
          actualSha256 !== claims.sha256.toLowerCase()
            ? 'Uploaded file content does not match declared SHA-256 hash.'
            : 'Uploaded file size or magic-byte signature does not match the declared document format.',
      });
    }

    const id = objectId(documentId);
    const db = this.database();
    const document = await db.collection('project_documents').findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      createdByUserId: objectId(actor.userId),
    });
    if (!document) {
      if (!claims.deduplicated) {
        await this.documentStorage.delete(claims.key).catch(() => undefined);
      }
      throw documentNotFound();
    }
    const versionNumber = Number(document.currentVersionNumber);
    const versions = db.collection('project_document_versions');
    const previousVersion = await versions.findOne({
      documentId: id,
      versionNumber,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      status: 'DRAFT',
      editedByUserId: objectId(actor.userId),
    });
    if (!previousVersion) {
      if (!claims.deduplicated) {
        await this.documentStorage.delete(claims.key).catch(() => undefined);
      }
      throw documentNotFound();
    }

    try {
      await this.transaction(async (txDb, session) => {
        const result = await txDb
          .collection('project_document_versions')
          .updateOne(
            {
              documentId: id,
              versionNumber,
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              status: 'DRAFT',
              editedByUserId: objectId(actor.userId),
              updatedAt: previousVersion.updatedAt,
            },
            {
              $set: {
                file: {
                  key: claims.key,
                  name: claims.fileName,
                  contentType: claims.contentType,
                  size: claims.size,
                  sha256: claims.sha256,
                },
                updatedAt: new Date(),
              },
            },
            { session },
          );
        if (result.modifiedCount !== 1) {
          throw conflict('The Document changed during upload confirmation.');
        }
        await this.auditEvent(
          actor,
          'DOCUMENT_FILE_UPLOADED',
          'PROJECT_DOCUMENT',
          documentId,
          {
            version: versionNumber,
            fileName: claims.fileName,
            size: claims.size,
            sha256: claims.sha256,
            deduplicated: claims.deduplicated,
            directCloud: true,
          },
          session,
        );
      });
    } catch (error) {
      if (!claims.deduplicated) {
        await this.documentStorage.delete(claims.key).catch(() => undefined);
      }
      throw error;
    }

    const oldKey = (previousVersion.file as { key?: string } | undefined)?.key;
    if (
      oldKey &&
      oldKey !== claims.key &&
      !(await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        oldKey,
        { excludeDocumentVersionId: String(previousVersion._id) },
      ))
    ) {
      await this.documentStorage.delete(oldKey).catch(() => undefined);
    }

    // BE-LOGIC-001: Upload confirmation NEVER auto-approves drafts (ignore autoSyncSag).
    const updated = await this.readDocument(actor, id);
    if (!updated) throw documentNotFound();
    return updated;
  }

  async resolveDocumentFileDownloadUrl(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    versionNumber?: number,
  ): Promise<DocumentDownloadUrlResponse> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const document = await this.database()
      .collection('project_documents')
      .findOne({
        _id: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      });
    if (!document) throw documentNotFound();
    const version = await this.database()
      .collection('project_document_versions')
      .findOne({
        documentId: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        versionNumber: versionNumber ?? Number(document.currentVersionNumber),
      });
    const file = version?.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (
      !file?.key ||
      !file.name ||
      !file.contentType ||
      !isDocumentStorageKeyInScope(file.key, actor.organizationId, projectId)
    ) {
      throw documentNotFound();
    }
    if (!this.documentStorage) {
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    }
    if (
      typeof this.documentStorage.isDirectCloudEnabled === 'function' &&
      this.documentStorage.isDirectCloudEnabled() &&
      typeof this.documentStorage.createDirectDownloadUrl === 'function' &&
      !(await this.documentStorage.hasLocalFile(file.key))
    ) {
      const expiresInSeconds = Math.max(
        30,
        Math.min(
          3600,
          Number(
            this.config?.get<number>('R2_PRESIGNED_DOWNLOAD_TTL_SECONDS') ??
              120,
          ) || 120,
        ),
      );
      const downloadUrl = await this.documentStorage.createDirectDownloadUrl(
        file.key,
        expiresInSeconds,
        {
          fileName: file.name,
          contentType: file.contentType,
          disposition: 'attachment',
        },
      );
      return {
        mode: 'DIRECT_GET',
        downloadUrl,
        fileName: file.name,
        contentType: file.contentType,
        expiresInSeconds,
      };
    }
    return {
      mode: 'LEGACY_PROXY',
      fileName: file.name,
      contentType: file.contentType,
    };
  }

  async downloadDocumentFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    versionNumber?: number,
  ): Promise<{
    bytes?: Buffer;
    stream?: Readable;
    name: string;
    contentType: string;
  }> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const document = await this.database()
      .collection('project_documents')
      .findOne({
        _id: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      });
    if (!document) throw documentNotFound();
    const version = await this.database()
      .collection('project_document_versions')
      .findOne({
        documentId: objectId(documentId),
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        versionNumber: versionNumber ?? Number(document.currentVersionNumber),
      });
    const file = version?.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (
      !file?.key ||
      !file.name ||
      !file.contentType ||
      !isDocumentStorageKeyInScope(file.key, actor.organizationId, projectId)
    ) {
      throw documentNotFound();
    }
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    if (typeof this.documentStorage.getStream === 'function') {
      return {
        stream: await this.documentStorage.getStream(file.key),
        name: file.name,
        contentType: file.contentType,
      };
    }
    return {
      bytes: await this.documentStorage.get(file.key),
      name: file.name,
      contentType: file.contentType,
    };
  }

  async updateDocumentDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: ProjectDocumentInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const versions = db.collection('project_document_versions');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      this.assertIfMatch(headers, current.updatedAt);
      if (String(current.createdByUserId) !== actor.userId) {
        throw new ForbiddenException({
          code: 'DOCUMENT_OWNER_REQUIRED',
          message: 'Only the Document owner can edit it.',
        });
      }
      const status = text(current.status) as DocumentStatus;
      if (status === 'PENDING_REVIEW' || status === 'ARCHIVED')
        throw conflict(
          'This Document version cannot be edited in its current state.',
        );

      const currentVersionNumber = Number(current.currentVersionNumber);
      const nextVersionNumber =
        status === 'APPROVED' || status === 'REJECTED'
          ? currentVersionNumber + 1
          : currentVersionNumber;
      const versionFilter = {
        documentId: id,
        versionNumber: currentVersionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      };
      if (nextVersionNumber === currentVersionNumber) {
        const updated = await versions.updateOne(
          {
            ...versionFilter,
            status: { $in: ['DRAFT', 'CHANGES_REQUESTED'] },
            editedByUserId: objectId(actor.userId),
          },
          {
            $set: {
              title: input.title,
              ...(input.description !== undefined
                ? { description: input.description }
                : {}),
              documentType: input.type,
              content: input.content,
              status: 'DRAFT',
              editedByUserId: objectId(actor.userId),
              updatedAt: now,
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw conflict(
            'The Document version changed while it was being edited.',
          );
      } else {
        const previous = await versions.findOne(versionFilter, { session });
        if (!previous) throw documentNotFound();
        await versions.insertOne(
          {
            _id: new Types.ObjectId(),
            ...versionFilter,
            versionNumber: nextVersionNumber,
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            documentType: input.type,
            content: input.content,
            ...(previous.file ? { file: previous.file } : {}),
            status: 'DRAFT',
            editedByUserId: objectId(actor.userId),
            reviewHistory: [],
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      }
      const update = await documents.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          currentVersionNumber,
          status,
        },
        {
          $set: {
            title: input.title,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
            documentType: input.type,
            updatedByUserId: objectId(actor.userId),
            currentVersionNumber: nextVersionNumber,
            status: 'DRAFT',
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document changed while it was being edited.');
      await this.auditEvent(
        actor,
        'DOCUMENT_DRAFT_UPDATED',
        'PROJECT_DOCUMENT',
        documentId,
        {
          version: nextVersionNumber,
          createdNewVersion: nextVersionNumber > currentVersionNumber,
        },
        session,
      );
    });
    const updated = await this.readDocument(actor, id);
    if (!updated) throw documentNotFound();
    return updated;
  }

  async submitDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      this.assertIfMatch(headers, current.updatedAt);
      if (String(current.createdByUserId) !== actor.userId) {
        throw new ForbiddenException({
          code: 'DOCUMENT_OWNER_REQUIRED',
          message: 'Only the Document owner can submit it.',
        });
      }
      const versionNumber = Number(current.currentVersionNumber);
      const submittedVersion = await db
        .collection('project_document_versions')
        .findOne(
          {
            documentId: id,
            versionNumber,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        );
      if (
        !submittedVersion ||
        (!text(submittedVersion.content).trim() && !submittedVersion.file)
      )
        throw conflict(
          'A Document needs text or an uploaded file before submission.',
        );
      const versionResult = await db
        .collection('project_document_versions')
        .updateOne(
          {
            documentId: id,
            versionNumber,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            editedByUserId: objectId(actor.userId),
            status: 'DRAFT',
          },
          {
            $set: {
              status: 'PENDING_REVIEW',
              submittedAt: now,
              updatedAt: now,
            },
          },
          { session },
        );
      if (versionResult.modifiedCount !== 1)
        throw conflict('Only an owned draft Document can be submitted.');
      const docResult = await documents.updateOne(
        {
          _id: id,
          currentVersionNumber: versionNumber,
          status: 'DRAFT',
        },
        { $set: { status: 'PENDING_REVIEW', updatedAt: now } },
        { session },
      );
      if (docResult.modifiedCount !== 1)
        throw conflict('The Document changed before submission.');
      await this.appendOutbox(
        {
          eventName: 'DOCUMENT_SUBMITTED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            version: versionNumber,
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_SUBMITTED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: versionNumber },
        session,
      );
    });
    const submitted = await this.readDocument(actor, id);
    if (!submitted) throw documentNotFound();
    return submitted;
  }

  async commentDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    input: ReviewInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    const comment = input.comment?.trim() ?? '';
    if (!comment) {
      throw new BadRequestException({
        code: 'REVIEW_COMMENT_REQUIRED',
        message: 'A review comment is required.',
      });
    }
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      const authorId = String(current.createdByUserId);
      assertReviewerCanReview(authorId, actor.userId, actor.canReview);
      const sourceVersion = Number(current.currentVersionNumber);
      const version = record(
        await db.collection('project_document_versions').findOne(
          {
            documentId: id,
            versionNumber: sourceVersion,
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!version)
        throw conflict('The submitted Document version is unavailable.');
      const history = pickReviewHistory(version.reviewHistory);
      const update = await db.collection('project_document_versions').updateOne(
        { _id: version._id, status: 'PENDING_REVIEW' },
        {
          $set: {
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            reviewComment: comment,
            reviewHistory: [
              ...history,
              {
                action: 'PENDING_REVIEW',
                reviewerId: actor.userId,
                comment,
                at: now,
              },
            ],
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document changed while saving the review comment.');
      await documents.updateOne(
        {
          _id: id,
          status: 'PENDING_REVIEW',
          currentVersionNumber: sourceVersion,
        },
        { $set: { updatedAt: now } },
        { session },
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_REVIEW_COMMENTED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: sourceVersion, comment },
        session,
      );
    });
    const commented = await this.readDocument(actor, id);
    if (!commented) throw documentNotFound();
    return commented;
  }

  async reviewDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
    input: ReviewInput,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!actor.canReview) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    let sourceVersion = 0;
    let authorId = '';
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      authorId = String(current.createdByUserId);
      assertReviewerCanReview(authorId, actor.userId, actor.canReview);
      sourceVersion = Number(current.currentVersionNumber);
      const version = record(
        await db.collection('project_document_versions').findOne(
          {
            documentId: id,
            versionNumber: sourceVersion,
            status: 'PENDING_REVIEW',
          },
          { session },
        ),
      );
      if (!version)
        throw conflict('The submitted Document version is unavailable.');
      const history = pickReviewHistory(version.reviewHistory);
      const versionFileSha = (version.file as { sha256?: string } | undefined)
        ?.sha256;
      const queuedSync: DocumentKnowledgeStatusRecord | undefined =
        action === 'APPROVED'
          ? {
              documentId,
              version: sourceVersion,
              ...(versionFileSha ? { fileHash: versionFileSha } : {}),
              status: 'QUEUED_OUTBOX',
              searchStatus: 'PENDING',
              knowledgeStatus: 'NOT_STARTED',
              searchReady: false,
              knowledgeReady: false,
              currentStage: 'OUTBOX_QUEUE',
              progress: 5,
              syncedAt: now.toISOString(),
            }
          : undefined;
      const update = await db.collection('project_document_versions').updateOne(
        { _id: version._id, status: 'PENDING_REVIEW' },
        {
          $set: {
            status: action,
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            ...(input.comment ? { reviewComment: input.comment } : {}),
            ...(queuedSync ? { knowledgeSync: queuedSync } : {}),
            reviewHistory: [
              ...history,
              {
                action,
                reviewerId: actor.userId,
                ...(input.comment ? { comment: input.comment } : {}),
                at: now,
              },
            ],
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('The Document was reviewed by another user.');
      const documentUpdate = await documents.updateOne(
        {
          _id: id,
          status: 'PENDING_REVIEW',
          currentVersionNumber: sourceVersion,
        },
        {
          $set: {
            status: action,
            ...(action === 'APPROVED'
              ? {
                  latestApprovedVersionNumber: sourceVersion,
                  ...(queuedSync ? { knowledgeSync: queuedSync } : {}),
                }
              : {}),
            updatedAt: now,
          },
        },
        { session },
      );
      if (documentUpdate.modifiedCount !== 1)
        throw conflict('The Document changed while it was being reviewed.');

      const eventName =
        action === 'APPROVED'
          ? 'DOCUMENT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'DOCUMENT_CHANGES_REQUESTED'
            : 'DOCUMENT_REJECTED';
      await this.appendOutbox(
        {
          eventName,
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            authorId,
            version: sourceVersion,
            ...(input.comment ? { comment: input.comment } : {}),
          },
        },
        session,
      );
      if (action === 'APPROVED') {
        const previousApproved = await db
          .collection('project_document_versions')
          .find(
            {
              documentId: id,
              versionNumber: { $lt: sourceVersion },
              status: 'APPROVED',
            },
            { session },
          )
          .sort({ versionNumber: -1 })
          .limit(1)
          .next();
        if (previousApproved) {
          await this.appendOutbox(
            {
              eventName: 'KNOWLEDGE_SOURCE_REPLACED',
              aggregateType: 'PROJECT_DOCUMENT',
              aggregateId: documentId,
              payload: {
                sourceType: 'PROJECT_DOCUMENT',
                sourceId: documentId,
                organizationId: actor.organizationId,
                projectId,
                previousVersion: Number(previousApproved.versionNumber),
                version: sourceVersion,
              },
            },
            session,
          );
        }
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_APPROVED',
            aggregateType: 'PROJECT_DOCUMENT',
            aggregateId: documentId,
            payload: {
              sourceType: 'PROJECT_DOCUMENT',
              sourceId: documentId,
              organizationId: actor.organizationId,
              projectId,
              version: sourceVersion,
              approvedAt: now.toISOString(),
            },
          },
          session,
        );
      }
      const auditAction =
        action === 'APPROVED'
          ? 'DOCUMENT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'DOCUMENT_CHANGES_REQUESTED'
            : 'DOCUMENT_REJECTED';
      await this.auditEvent(
        actor,
        auditAction,
        'PROJECT_DOCUMENT',
        documentId,
        {
          authorId,
          version: sourceVersion,
          ...(input.comment ? { comment: input.comment } : {}),
        },
        session,
      );
    });
    if (action === 'APPROVED' && sourceVersion >= 1) {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        documentId,
        'KNOWLEDGE_SOURCE_APPROVED',
        sourceVersion,
        headers.requestId,
      );
    }
    const reviewed = await this.readDocument(actor, id);
    if (!reviewed) throw documentNotFound();
    return reviewed;
  }

  async archiveDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<ProjectDocumentRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    // SEC-AUTH-007: Non-member Managers can review Documents, not archive/delete them.
    if (!isActorLeader(actor)) throw this.reviewPermissionDenied();
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const documents = db.collection('project_documents');
      const versions = db.collection('project_document_versions');
      const current = record(
        await documents.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
          },
          { session },
        ),
      );
      if (!current) throw documentNotFound();
      if (text(current.status) === 'ARCHIVED') {
        throw conflict('Only an approved Document can be archived.');
      }
      const latestApprovedVersion = await versions
        .find(
          {
            documentId: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'APPROVED',
          },
          { session },
        )
        .sort({ versionNumber: -1 })
        .limit(1)
        .next();
      if (
        text(current.status) !== 'APPROVED' &&
        typeof current.latestApprovedVersionNumber !== 'number' &&
        !latestApprovedVersion
      ) {
        throw conflict('Only an approved Document can be archived.');
      }
      const revokedVersion = Number(
        latestApprovedVersion?.versionNumber ??
          current.latestApprovedVersionNumber ??
          current.currentVersionNumber,
      );
      const update = await documents.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          status: text(current.status),
        },
        {
          $set: {
            status: 'ARCHIVED',
            updatedByUserId: objectId(actor.userId),
            updatedAt: now,
          },
        },
        { session },
      );
      if (update.modifiedCount !== 1)
        throw conflict('Only an approved Document can be archived.');
      await this.appendOutbox(
        {
          eventName: 'KNOWLEDGE_SOURCE_REVOKED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId,
            organizationId: actor.organizationId,
            projectId,
            version: revokedVersion,
            reason: 'ARCHIVED',
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_ARCHIVED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: revokedVersion },
        session,
      );
    });
    await this.dispatchKnowledgeIngestionJob(
      projectId,
      documentId,
      'KNOWLEDGE_SOURCE_REVOKED',
      0,
      headers.requestId,
    );
    const archived = await this.readDocument(actor, id);
    if (!archived) throw documentNotFound();
    return archived;
  }

  async deleteDocument(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<DeleteProjectDocumentResult> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (isNonMemberManager(actor)) {
      throw new ForbiddenException({
        code: 'DOCUMENT_DELETE_FORBIDDEN',
        message: 'Managers cannot delete Project Documents.',
      });
    }
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!document) throw documentNotFound();

    const authorId = String(document.createdByUserId);
    const docStatus = text(document.status);
    // SEC-AUTH-007: Only Project Leaders (not non-member Managers) can delete
    // approved/archived or another member's documents; authors may delete their own unapproved drafts.
    const canDelete =
      isActorLeader(actor) ||
      (authorId === actor.userId &&
        docStatus !== 'APPROVED' &&
        docStatus !== 'ARCHIVED');
    if (!canDelete) {
      throw new ForbiddenException({
        code: 'DOCUMENT_DELETE_FORBIDDEN',
        message:
          'Only a Project Leader or the author of an unapproved Document can permanently delete it.',
      });
    }

    const versionRows = await db
      .collection('project_document_versions')
      .find({
        documentId: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      })
      .toArray();

    const candidateKeys = new Set<string>();
    let hasSagSync = Boolean(
      (document.knowledgeSync as { sagDocumentId?: string } | undefined)
        ?.sagDocumentId ||
      docStatus === 'APPROVED' ||
      docStatus === 'ARCHIVED',
    );
    for (const row of versionRows) {
      const file = (row as Record<string, unknown>).file as
        { key?: unknown } | undefined;
      if (typeof file?.key === 'string' && file.key.trim()) {
        candidateKeys.add(file.key.trim());
      }
      const verSync = (row as Record<string, unknown>).knowledgeSync as
        { sagDocumentId?: unknown } | undefined;
      if (typeof verSync?.sagDocumentId === 'string' && verSync.sagDocumentId) {
        hasSagSync = true;
      }
    }

    const revokedVersion = Number(document.currentVersionNumber) || 1;
    let sagRevoked = false;
    if (
      hasSagSync &&
      typeof this.sagTransport?.revokeProjectDocument === 'function'
    ) {
      const revoked = await this.sagTransport
        .revokeProjectDocument({
          organizationId: actor.organizationId,
          projectId,
          documentId,
          version: revokedVersion,
          logicalSourceId: `continuum:project_document:${documentId}`,
          actorUserId: actor.userId,
          reason: 'DOCUMENT_DELETED',
        })
        .then(() => true)
        .catch(() => false);
      sagRevoked = revoked;
    }

    await this.transaction(async (txDb, session) => {
      await txDb.collection('project_document_versions').deleteMany(
        {
          documentId: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { session },
      );
      const deletedDoc = await txDb.collection('project_documents').deleteOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { session },
      );
      if (deletedDoc.deletedCount !== 1) {
        throw documentNotFound();
      }
      // BE-DATA-003: Remove stale pending/failed ingest events, and ALWAYS emit
      // a durable KNOWLEDGE_SOURCE_REVOKED outbox event inside the transaction
      // when the document was synced to SAG (so transient SAG outage cannot leave
      // orphaned knowledge chunks behind).
      await txDb.collection('outbox_events').deleteMany(
        {
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          eventName: {
            $in: ['KNOWLEDGE_SOURCE_APPROVED', 'KNOWLEDGE_SOURCE_REPLACED'],
          },
          status: { $in: ['PENDING', 'FAILED'] },
        },
        { session },
      );
      if (hasSagSync && !sagRevoked && this.outbox) {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'PROJECT_DOCUMENT',
            aggregateId: documentId,
            payload: {
              sourceType: 'PROJECT_DOCUMENT',
              sourceId: documentId,
              organizationId: actor.organizationId,
              projectId,
              version: revokedVersion,
              reason: 'DOCUMENT_DELETED',
            },
          },
          session,
        );
      }
    });

    if (hasSagSync && !sagRevoked) {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        documentId,
        'KNOWLEDGE_SOURCE_REVOKED',
        revokedVersion,
        headers.requestId,
      );
    }

    let r2DeletedKeys = 0;
    let r2RetainedSharedKeys = 0;
    if (candidateKeys.size > 0) {
      for (const key of candidateKeys) {
        // BE-DATA-003: Cross-collection project-scoped storage reference check.
        const stillReferenced = await this.isStorageKeyStillReferenced(
          actor.organizationId,
          projectId,
          key,
        );
        if (!stillReferenced) {
          if (this.documentStorage) {
            const deletedFromCloud = await this.documentStorage
              .delete(key)
              .then(() => true)
              .catch(() => false);
            if (deletedFromCloud) {
              r2DeletedKeys += 1;
            }
          }
        } else {
          r2RetainedSharedKeys += 1;
        }
      }
    }

    await this.auditEvent(
      actor,
      'DOCUMENT_DELETED',
      'PROJECT_DOCUMENT',
      documentId,
      {
        title: text(document.title),
        version: Number(document.currentVersionNumber) || 1,
        sagRevoked,
        storageKeysChecked: candidateKeys.size,
        r2DeletedKeys,
        r2RetainedSharedKeys,
      },
    );

    return {
      deletedDocumentId: documentId,
      sagRevoked,
      r2DeletedKeys,
      r2RetainedSharedKeys,
    };
  }

  async syncDocumentToSag(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    if (!this.sagTransport) {
      throw new ServiceUnavailableException({
        code: 'SAG_SYNC_UNAVAILABLE',
        message: 'SAG Knowledge synchronization service is unavailable.',
      });
    }
    const id = objectId(documentId);
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!document) throw documentNotFound();
    if (text(document.status) === 'ARCHIVED') {
      throw conflict('Archived documents cannot be synchronized to SAG.');
    }
    // BE-LOGIC-001: Sync NEVER auto-approves or promotes unapproved Documents.
    if (text(document.status) !== 'APPROVED') {
      if (!actor.canReview) {
        throw new ForbiddenException({
          code: 'LEADER_APPROVAL_REQUIRED',
          message:
            'Only an approved Project Document can be synchronized to SAG. Submit it for review first.',
        });
      }
      throw conflict(
        'Only an approved Project Document can be synchronized to SAG. Approve it via the review workflow first.',
      );
    }
    const versionNumber = Number(document.currentVersionNumber);
    const versionDoc = record(
      await db.collection('project_document_versions').findOne({
        documentId: id,
        versionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!versionDoc) throw documentNotFound();

    const fileMeta = versionDoc.file as
      | {
          key?: string;
          name?: string;
          contentType?: string;
          size?: number;
          sha256?: string;
        }
      | undefined;

    const existingSync =
      normalizeKnowledgeSyncForVersion(
        versionDoc.knowledgeSync,
        versionNumber,
      ) ??
      normalizeKnowledgeSyncForVersion(document.knowledgeSync, versionNumber);
    const needsFreshIdempotencyKey = Boolean(
      existingSync &&
      ['REVOKED', 'FAILED', 'INDEX_FAILED'].some(
        (terminalState) =>
          String(existingSync.status ?? '').toUpperCase() === terminalState ||
          String(existingSync.searchStatus ?? '').toUpperCase() ===
            terminalState,
      ),
    );
    const resyncSuffix = needsFreshIdempotencyKey
      ? `:resync:${Date.now()}`
      : '';

    const logicalSourceId = `continuum:project_document:${documentId}`;

    // E2E-INT-001: Always upload document bytes via SAG's active
    // POST /api/v1/projects/{projectId}/documents/upload endpoint (never deleted /ingest-object).
    let bytes: Buffer;
    let fileName: string;
    let contentType: string;
    if (fileMeta?.key && fileMeta.name && fileMeta.contentType) {
      if (
        !isDocumentStorageKeyInScope(
          fileMeta.key,
          actor.organizationId,
          projectId,
        )
      ) {
        throw documentNotFound();
      }
      if (!this.documentStorage) {
        throw new ServiceUnavailableException(
          'Project Document storage is unavailable.',
        );
      }
      bytes = await this.documentStorage.get(fileMeta.key);
      fileName = fileMeta.name;
      contentType = fileMeta.contentType;
    } else {
      const markdown = text(versionDoc.content).trim();
      if (!markdown) {
        throw conflict(
          'A Document needs text or an uploaded file before syncing to SAG.',
        );
      }
      const baseTitle = (
        text(versionDoc.title) ||
        text(document.title) ||
        documentId
      )
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
      bytes = Buffer.from(markdown, 'utf-8');
      fileName = `${baseTitle || documentId}.md`;
      contentType = 'text/markdown';
    }

    const fileHash =
      fileMeta?.sha256 || createHash('sha256').update(bytes).digest('hex');
    const idempotencyKey = `continuum:project_document:${documentId}:v${versionNumber}:${fileHash.slice(0, 16)}${resyncSuffix}`;

    let receipt: SagProjectDocumentUploadReceipt;
    try {
      receipt = await this.sagTransport.uploadProjectDocument({
        organizationId: actor.organizationId,
        projectId,
        documentId,
        version: versionNumber,
        logicalSourceId,
        idempotencyKey,
        actorUserId: actor.userId,
        fileName,
        contentType,
        bytes,
      });
    } catch (error) {
      this.mapSagTransportError(error, 'SAG_SYNC_FAILED');
    }

    const syncedAt = new Date().toISOString();
    const searchStatus = receipt.searchStatus ?? 'PENDING';
    const knowledgeStatus = receipt.knowledgeStatus ?? 'NOT_STARTED';
    const sameActiveSagVersion = Boolean(
      existingSync &&
      existingSync.sagDocumentId === receipt.documentId &&
      existingSync.sagVersionNo === receipt.versionNo &&
      !needsFreshIdempotencyKey,
    );
    const existingProgress = sameActiveSagVersion
      ? Number(existingSync?.progress ?? 0)
      : 0;
    const searchReady = Boolean(
      receipt.searchReady ||
      searchStatus === 'SEARCH_READY' ||
      (sameActiveSagVersion && existingSync?.searchReady === true),
    );
    const knowledgeReady = Boolean(
      isKnowledgeSettledStatus(knowledgeStatus) ||
      (sameActiveSagVersion && existingSync?.knowledgeReady === true),
    );

    const syncRecord: DocumentKnowledgeStatusRecord = {
      documentId,
      version: versionNumber,
      sagDocumentId: receipt.documentId,
      sagVersionId: receipt.versionId,
      sagVersionNo: receipt.versionNo,
      ...(receipt.runId ? { runId: receipt.runId } : {}),
      fileHash: receipt.fileHash ?? fileHash,
      status: searchReady ? 'SEARCH_READY' : receipt.status,
      searchStatus: searchReady ? 'SEARCH_READY' : searchStatus,
      knowledgeStatus,
      searchReady,
      knowledgeReady,
      isDuplicate: Boolean(receipt.isDuplicate),
      currentStage: searchReady
        ? 'COMPLETE'
        : sameActiveSagVersion &&
            existingProgress > 10 &&
            existingSync?.currentStage
          ? existingSync.currentStage
          : receipt.isDuplicate
            ? 'DUPLICATE'
            : 'RECEIVE',
      progress: searchReady ? 100 : Math.max(0, existingProgress),
      syncedAt,
    };

    await db
      .collection('project_document_versions')
      .updateOne(
        { _id: versionDoc._id },
        { $set: { knowledgeSync: syncRecord } },
      );
    await db
      .collection('project_documents')
      .updateOne({ _id: id }, { $set: { knowledgeSync: syncRecord } });

    await this.auditEvent(
      actor,
      'DOCUMENT_KNOWLEDGE_SYNCED',
      'PROJECT_DOCUMENT',
      documentId,
      {
        version: versionNumber,
        sagDocumentId: receipt.documentId,
        sagVersionNo: receipt.versionNo,
        isDuplicate: Boolean(receipt.isDuplicate),
      },
    );

    return syncRecord;
  }

  async getDocumentKnowledgeStatus(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    return this.resolveDocumentKnowledgeStatusForActor(
      actor,
      projectId,
      documentId,
    );
  }

  private async resolveDocumentKnowledgeStatusForActor(
    actor: WorkNotesActor,
    projectId: string,
    documentId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!document) throw documentNotFound();
    const versionNumber = Number(document.currentVersionNumber);
    const versionDoc = record(
      await db.collection('project_document_versions').findOne({
        documentId: id,
        versionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!versionDoc) throw documentNotFound();

    const storedSync =
      normalizeKnowledgeSyncForVersion(
        versionDoc.knowledgeSync,
        versionNumber,
      ) ??
      normalizeKnowledgeSyncForVersion(document.knowledgeSync, versionNumber);
    const fileSha256 = (versionDoc.file as { sha256?: string } | undefined)
      ?.sha256;

    if (
      storedSync?.sagDocumentId &&
      storedSync.sagVersionNo &&
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function'
    ) {
      try {
        const live = await this.sagTransport.getProjectDocumentVersionStatus({
          organizationId: actor.organizationId,
          projectId,
          sagDocumentId: storedSync.sagDocumentId,
          versionNo: storedSync.sagVersionNo,
          actorUserId: actor.userId,
        });
        const merged: DocumentKnowledgeStatusRecord = {
          ...storedSync,
          documentId,
          version: versionNumber,
          sagDocumentId: live.documentId,
          sagVersionNo: live.versionNo,
          status: live.status,
          searchStatus: live.searchStatus,
          knowledgeStatus: live.knowledgeStatus,
          searchReady: live.searchReady,
          knowledgeReady: Boolean(
            live.knowledgeReady ||
            isKnowledgeSettledStatus(live.knowledgeStatus),
          ),
          currentStage: live.currentStage ?? storedSync.currentStage ?? null,
          progress:
            typeof live.progress === 'number'
              ? live.progress
              : live.searchReady
                ? 100
                : (storedSync.progress ?? 10),
          ...(live.documentStatus !== undefined
            ? { documentStatus: live.documentStatus }
            : {}),
          ...(live.parserProvider !== undefined
            ? { parserProvider: live.parserProvider }
            : {}),
          ...(live.parserStatus !== undefined
            ? { parserStatus: live.parserStatus }
            : {}),
          ...(typeof live.chunkCount === 'number'
            ? { chunkCount: live.chunkCount }
            : {}),
          ...(typeof live.eventCount === 'number'
            ? { eventCount: live.eventCount }
            : {}),
          ...(typeof live.tokenUsage === 'number'
            ? { tokenUsage: live.tokenUsage }
            : {}),
          ...(live.stageProgress !== undefined
            ? { stageProgress: live.stageProgress }
            : {}),
          error: live.error ?? null,
        };
        if (typeof live.tokenUsage === 'number' && live.tokenUsage > 0) {
          void recordKnowledgeSyncTokenUsageLog(db, {
            organizationId: actor.organizationId,
            projectId,
            userId: actor.userId,
            sagDocumentId: storedSync.sagDocumentId,
            sagVersionNo: storedSync.sagVersionNo ?? versionNumber,
            tokenUsage: live.tokenUsage,
          });
        }
        if (JSON.stringify(merged) !== JSON.stringify(storedSync)) {
          await db
            .collection('project_document_versions')
            .updateOne(
              { _id: versionDoc._id },
              { $set: { knowledgeSync: merged } },
            );
          await db
            .collection('project_documents')
            .updateOne({ _id: id }, { $set: { knowledgeSync: merged } });
        }
        return merged;
      } catch {
        return storedSync;
      }
    }

    const isPreReceiptPlaceholder = Boolean(
      storedSync &&
      !storedSync.sagDocumentId &&
      (storedSync.status === 'QUEUED_OUTBOX' || storedSync.status === 'QUEUED'),
    );

    if (storedSync && !isPreReceiptPlaceholder) {
      return storedSync;
    }

    const pendingOutbox = await db.collection('outbox_events').findOne({
      aggregateType: 'PROJECT_DOCUMENT',
      aggregateId: documentId,
      eventName: 'KNOWLEDGE_SOURCE_APPROVED',
      'payload.version': versionNumber,
      status: { $in: ['PENDING', 'PUBLISHED', 'FAILED'] },
    });

    if (pendingOutbox) {
      const deliveryReceipt = (
        pendingOutbox.payload as
          { delivery?: { receipt?: Record<string, unknown> } } | undefined
      )?.delivery?.receipt;
      if (
        deliveryReceipt &&
        typeof deliveryReceipt.documentId === 'string' &&
        typeof deliveryReceipt.versionNo === 'number'
      ) {
        let recovered: DocumentKnowledgeStatusRecord = {
          documentId,
          version: versionNumber,
          sagDocumentId: deliveryReceipt.documentId,
          sagVersionId:
            typeof deliveryReceipt.versionId === 'string'
              ? deliveryReceipt.versionId
              : undefined,
          sagVersionNo: deliveryReceipt.versionNo,
          status:
            typeof deliveryReceipt.status === 'string'
              ? deliveryReceipt.status
              : 'SEARCH_READY',
          searchStatus:
            typeof deliveryReceipt.searchStatus === 'string'
              ? deliveryReceipt.searchStatus
              : 'SEARCH_READY',
          knowledgeStatus:
            typeof deliveryReceipt.knowledgeStatus === 'string'
              ? deliveryReceipt.knowledgeStatus
              : 'NOT_STARTED',
          searchReady: Boolean(deliveryReceipt.searchReady ?? true),
          knowledgeReady: Boolean(
            deliveryReceipt.knowledgeReady ||
            isKnowledgeSettledStatus(deliveryReceipt.knowledgeStatus),
          ),
          progress: 100,
          ...(fileSha256 ? { fileHash: fileSha256 } : {}),
        };
        if (
          typeof this.sagTransport?.getProjectDocumentVersionStatus ===
          'function'
        ) {
          try {
            const live =
              await this.sagTransport.getProjectDocumentVersionStatus({
                organizationId: actor.organizationId,
                projectId,
                sagDocumentId: deliveryReceipt.documentId,
                versionNo: deliveryReceipt.versionNo,
                actorUserId: actor.userId,
              });
            recovered = {
              ...recovered,
              status: live.status,
              searchStatus: live.searchStatus,
              knowledgeStatus: live.knowledgeStatus,
              searchReady: live.searchReady,
              knowledgeReady: Boolean(
                live.knowledgeReady ||
                isKnowledgeSettledStatus(live.knowledgeStatus),
              ),
              currentStage: live.currentStage ?? null,
              progress:
                typeof live.progress === 'number'
                  ? live.progress
                  : live.searchReady
                    ? 100
                    : 15,
              ...(live.documentStatus !== undefined
                ? { documentStatus: live.documentStatus }
                : {}),
              ...(live.parserProvider !== undefined
                ? { parserProvider: live.parserProvider }
                : {}),
              ...(live.parserStatus !== undefined
                ? { parserStatus: live.parserStatus }
                : {}),
              ...(typeof live.chunkCount === 'number'
                ? { chunkCount: live.chunkCount }
                : {}),
              ...(typeof live.eventCount === 'number'
                ? { eventCount: live.eventCount }
                : {}),
              ...(typeof live.tokenUsage === 'number'
                ? { tokenUsage: live.tokenUsage }
                : {}),
              ...(live.stageProgress !== undefined
                ? { stageProgress: live.stageProgress }
                : {}),
              error: live.error ?? null,
            };
            if (typeof live.tokenUsage === 'number' && live.tokenUsage > 0) {
              void recordKnowledgeSyncTokenUsageLog(db, {
                organizationId: actor.organizationId,
                projectId,
                userId: actor.userId,
                sagDocumentId: deliveryReceipt.documentId,
                sagVersionNo: deliveryReceipt.versionNo,
                tokenUsage: live.tokenUsage,
              });
            }
          } catch {
            // Fall back to recovered outbox receipt
          }
        }
        await db
          .collection('project_document_versions')
          .updateOne(
            { _id: versionDoc._id },
            { $set: { knowledgeSync: recovered } },
          );
        await db
          .collection('project_documents')
          .updateOne({ _id: id }, { $set: { knowledgeSync: recovered } });
        return recovered;
      }
      if (pendingOutbox.status === 'PENDING') {
        return (
          storedSync ?? {
            documentId,
            version: versionNumber,
            ...(fileSha256 ? { fileHash: fileSha256 } : {}),
            status: 'QUEUED_OUTBOX',
            searchStatus: 'PENDING',
            knowledgeStatus: 'NOT_STARTED',
            searchReady: false,
            knowledgeReady: false,
            currentStage: 'OUTBOX_QUEUE',
            progress: 5,
          }
        );
      }
      if (pendingOutbox.status === 'FAILED') {
        const failedSync: DocumentKnowledgeStatusRecord = {
          documentId,
          version: versionNumber,
          ...(fileSha256 ? { fileHash: fileSha256 } : {}),
          status: 'FAILED',
          searchStatus: 'FAILED',
          knowledgeStatus: 'FAILED',
          searchReady: false,
          knowledgeReady: false,
          currentStage: 'OUTBOX_DELIVERY',
          progress: 0,
          error: {
            message: String(
              pendingOutbox.lastError ??
                'Failed to deliver document to processing engine.',
            ),
          },
        };
        await db
          .collection('project_document_versions')
          .updateOne(
            { _id: versionDoc._id },
            { $set: { knowledgeSync: failedSync } },
          );
        await db
          .collection('project_documents')
          .updateOne({ _id: id }, { $set: { knowledgeSync: failedSync } });
        return failedSync;
      }
    }

    if (storedSync) {
      return storedSync;
    }

    return {
      documentId,
      version: versionNumber,
      ...(fileSha256 ? { fileHash: fileSha256 } : {}),
      status: 'NOT_SYNCED',
      searchStatus: 'NOT_STARTED',
      knowledgeStatus: 'NOT_STARTED',
      searchReady: false,
      knowledgeReady: false,
      currentStage: null,
      progress: 0,
    };
  }

  async getDocumentKnowledgeChunks(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<DocumentKnowledgeChunksResponse> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    const id = objectId(documentId);
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!document) throw documentNotFound();
    const versionNumber = Number(document.currentVersionNumber);
    const versionDoc = record(
      await db.collection('project_document_versions').findOne({
        documentId: id,
        versionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!versionDoc) throw documentNotFound();

    let sagDocumentId: string | undefined;
    let sagVersionNo: number | undefined;
    const storedSync =
      normalizeKnowledgeSyncForVersion(
        versionDoc.knowledgeSync,
        versionNumber,
      ) ??
      normalizeKnowledgeSyncForVersion(document.knowledgeSync, versionNumber);

    if (storedSync?.status === 'REVOKED') {
      return {
        documentId,
        version: versionNumber,
        ...(storedSync.sagDocumentId
          ? { sagDocumentId: storedSync.sagDocumentId }
          : {}),
        ...(storedSync.sagVersionNo
          ? { sagVersionNo: storedSync.sagVersionNo }
          : {}),
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }

    if (storedSync?.sagDocumentId && storedSync.sagVersionNo) {
      sagDocumentId = storedSync.sagDocumentId;
      sagVersionNo = storedSync.sagVersionNo;
    } else {
      const pendingOutbox = await db.collection('outbox_events').findOne({
        aggregateType: 'PROJECT_DOCUMENT',
        aggregateId: documentId,
        eventName: 'KNOWLEDGE_SOURCE_APPROVED',
        'payload.version': versionNumber,
        status: { $in: ['PENDING', 'PUBLISHED', 'FAILED'] },
      });
      const deliveryReceipt = (
        pendingOutbox?.payload as
          { delivery?: { receipt?: Record<string, unknown> } } | undefined
      )?.delivery?.receipt;
      if (
        deliveryReceipt &&
        typeof deliveryReceipt.documentId === 'string' &&
        typeof deliveryReceipt.versionNo === 'number'
      ) {
        sagDocumentId = deliveryReceipt.documentId;
        sagVersionNo = deliveryReceipt.versionNo;
      }
    }

    if (
      !sagDocumentId ||
      !sagVersionNo ||
      typeof this.sagTransport?.getProjectDocumentVersionChunks !== 'function'
    ) {
      return {
        documentId,
        version: versionNumber,
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }

    try {
      const chunksReceipt =
        await this.sagTransport.getProjectDocumentVersionChunks({
          organizationId: actor.organizationId,
          projectId,
          sagDocumentId,
          versionNo: sagVersionNo,
          actorUserId: actor.userId,
          limit: options?.limit ?? 50,
          offset: options?.offset ?? 0,
        });
      return {
        documentId,
        version: versionNumber,
        sagDocumentId: chunksReceipt.documentId,
        sagVersionNo: chunksReceipt.versionNo,
        sourceStage: chunksReceipt.sourceStage,
        totalChunks: chunksReceipt.totalChunks,
        totalTokens: chunksReceipt.totalTokens,
        items: chunksReceipt.items,
      };
    } catch {
      return {
        documentId,
        version: versionNumber,
        sagDocumentId,
        sagVersionNo,
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }
  }

  async controlDocumentKnowledge(
    headers: CaptureRequestHeaders,
    projectId: string,
    documentId: string,
    action: DocumentKnowledgeControlAction,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(documentId)) throw documentNotFound();
    if (!this.sagTransport) {
      throw new ServiceUnavailableException({
        code: 'SAG_SYNC_UNAVAILABLE',
        message: 'SAG Knowledge synchronization service is unavailable.',
      });
    }
    const id = objectId(documentId);
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne({
        _id: id,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!document) throw documentNotFound();
    const isApprovedDoc = text(document.status) === 'APPROVED';
    // SEC-AUTH-007: Regular MEMBER authors cannot REVOKE/PAUSE/control approved SAG knowledge.
    const canControl = isApprovedDoc
      ? Boolean(actor.canReview)
      : String(document.createdByUserId) === actor.userId ||
        Boolean(actor.canReview);
    if (!canControl) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CONTROL_FORBIDDEN',
        message: isApprovedDoc
          ? 'Only a Project reviewer can control SAG processing for an approved Document.'
          : 'Only the Document owner or a Project reviewer can control SAG processing.',
      });
    }
    const versionNumber = Number(document.currentVersionNumber);
    const versionDoc = record(
      await db.collection('project_document_versions').findOne({
        documentId: id,
        versionNumber,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
      }),
    );
    if (!versionDoc) throw documentNotFound();

    const storedSync =
      normalizeKnowledgeSyncForVersion(
        versionDoc.knowledgeSync,
        versionNumber,
      ) ??
      normalizeKnowledgeSyncForVersion(document.knowledgeSync, versionNumber);
    const logicalSourceId = `continuum:project_document:${documentId}`;

    if (action === 'REVOKE') {
      let revokeReceipt;
      try {
        revokeReceipt = await this.sagTransport.revokeProjectDocument({
          organizationId: actor.organizationId,
          projectId,
          documentId,
          version: versionNumber,
          logicalSourceId,
          actorUserId: actor.userId,
          reason: 'MANUAL_REVOKE',
        });
      } catch (error) {
        this.mapSagTransportError(error, 'SAG_REVOKE_FAILED');
      }
      const revokedRecord: DocumentKnowledgeStatusRecord = {
        ...(storedSync ?? {}),
        documentId,
        version: versionNumber,
        ...(revokeReceipt.documentId
          ? { sagDocumentId: revokeReceipt.documentId }
          : {}),
        status: 'REVOKED',
        searchStatus: 'REVOKED',
        knowledgeStatus: 'REVOKED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'REVOKED',
        progress: 0,
        syncedAt: new Date().toISOString(),
      };
      await db.collection('project_document_versions').updateOne(
        {
          _id: versionDoc._id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { $set: { knowledgeSync: revokedRecord } },
      );
      await db.collection('project_documents').updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { $set: { knowledgeSync: revokedRecord } },
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_KNOWLEDGE_REVOKED',
        'PROJECT_DOCUMENT',
        documentId,
        {
          version: versionNumber,
          ...(revokeReceipt.documentId
            ? { sagDocumentId: revokeReceipt.documentId }
            : {}),
        },
      );
      return revokedRecord;
    }

    if (
      action === 'REPROCESS' &&
      actor.canReview &&
      (!storedSync ||
        storedSync.status === 'NOT_SYNCED' ||
        storedSync.status === 'REVOKED' ||
        storedSync.searchStatus === 'REVOKED')
    ) {
      return this.syncDocumentToSag(headers, projectId, documentId);
    }

    if (typeof this.sagTransport.controlProjectDocument !== 'function') {
      throw new ServiceUnavailableException({
        code: 'SAG_CONTROL_UNSUPPORTED',
        message: 'SAG Knowledge control transport is not available.',
      });
    }

    // E2E-INT-001: Do not generate/send ignored sourceUrl JSON body on /reprocess.
    const sagDocumentId = storedSync?.sagDocumentId || logicalSourceId;
    try {
      await this.sagTransport.controlProjectDocument({
        organizationId: actor.organizationId,
        projectId,
        sagDocumentId,
        actorUserId: actor.userId,
        action: action.toLowerCase() as 'pause' | 'resume' | 'reprocess',
      });
    } catch (error) {
      this.mapSagTransportError(error, 'SAG_CONTROL_FAILED');
    }

    const controlAuditAction =
      action === 'REPROCESS'
        ? 'DOCUMENT_KNOWLEDGE_REPROCESSED'
        : action === 'PAUSE'
          ? 'DOCUMENT_KNOWLEDGE_PAUSED'
          : 'DOCUMENT_KNOWLEDGE_RESUMED';
    await this.auditEvent(
      actor,
      controlAuditAction,
      'PROJECT_DOCUMENT',
      documentId,
      {
        version: versionNumber,
        sagDocumentId,
      },
    );

    if (action === 'REPROCESS') {
      const resetRecord: DocumentKnowledgeStatusRecord = {
        ...(storedSync ?? {}),
        documentId,
        version: versionNumber,
        sagDocumentId,
        status: 'RECEIVED',
        searchStatus: 'PENDING',
        knowledgeStatus: storedSync?.knowledgeStatus ?? 'NOT_STARTED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'RECEIVE',
        documentStatus: 'pending',
        progress: 0,
        chunkCount: 0,
        stageProgress: {},
        error: null,
        syncedAt: new Date().toISOString(),
      };
      await db.collection('project_document_versions').updateOne(
        {
          _id: versionDoc._id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { $set: { knowledgeSync: resetRecord } },
      );
      await db.collection('project_documents').updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { $set: { knowledgeSync: resetRecord } },
      );
      return resetRecord;
    }

    return this.getDocumentKnowledgeStatus(headers, projectId, documentId);
  }

  private mapSagTransportError(error: unknown, fallbackCode: string): never {
    if (error instanceof HttpException) {
      throw error;
    }
    const rawMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : '';
    const match = /^SAG_[A-Z_]+_FAILED_(\d{3}):([\s\S]*)$/.exec(rawMessage);
    if (match) {
      const statusCode = Number(match[1]);
      // SEC-BE-012: Never leak raw upstream stack traces, URLs, or internal topology.
      const safeMessage =
        statusCode === 400 || statusCode === 422
          ? 'The document could not be processed by the knowledge engine.'
          : statusCode === 403
            ? 'Knowledge processing permission denied.'
            : statusCode === 404
              ? 'Knowledge source was not found.'
              : statusCode === 409
                ? 'Knowledge source state conflict. Please retry.'
                : 'Knowledge processing service is temporarily unavailable.';
      if (statusCode === 400 || statusCode === 422) {
        throw new BadRequestException({
          code: fallbackCode,
          message: safeMessage,
        });
      }
      if (statusCode === 403) {
        throw new ForbiddenException({
          code: fallbackCode,
          message: safeMessage,
        });
      }
      if (statusCode === 404) {
        throw new NotFoundException({
          code: fallbackCode,
          message: safeMessage,
        });
      }
      if (statusCode === 409) {
        throw new ConflictException({
          code: fallbackCode,
          message: safeMessage,
        });
      }
      if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
        throw new ServiceUnavailableException({
          code: fallbackCode,
          message: safeMessage,
        });
      }
      throw new BadGatewayException({
        code: fallbackCode,
        message: safeMessage,
      });
    }
    throw new BadGatewayException({
      code: fallbackCode,
      message: 'Knowledge processing service request failed.',
    });
  }

  async getWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (scope === 'LEADER' && isActorPureMember(actor)) {
      throw this.reviewPermissionDenied();
    }
    const [timelines, hasActiveLeaders] = await Promise.all([
      this.scopedSettingsTimelines(actor),
      this.resolveHasActiveLeaders(actor, headers),
    ]);
    return this.settingsRecord(
      timelines,
      actor,
      new Date(),
      scope,
      hasActiveLeaders,
    );
  }

  async updateWorkReportReminder(
    headers: CaptureRequestHeaders,
    projectId: string,
    reminderLeadMinutes: number | null,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportSettingsRecord> {
    if (![null, 60, 120, 1440, 2880].includes(reminderLeadMinutes)) {
      throw new BadRequestException({
        code: 'INVALID_INPUT',
        message: 'Invalid reminder lead time.',
      });
    }
    const actor = await this.authorization.resolveProject(headers, projectId);
    const hasActiveLeaders = await this.resolveHasActiveLeaders(actor, headers);
    if (
      scope === 'LEADER'
        ? !this.canManageLeaderTier(actor)
        : !this.canManageMemberTier(actor, hasActiveLeaders)
    ) {
      throw this.reviewPermissionDenied();
    }
    const timelines = await this.scopedSettingsTimelines(actor);
    // Keep immediate reminder preferences on the stable first settings row,
    // independently of cadence segments and their effective dates.
    const root = timelines.memberRows[0];
    const field =
      scope === 'LEADER'
        ? 'leaderReminderLeadMinutes'
        : 'memberReminderLeadMinutes';
    await this.transaction(async (db, session) => {
      await db.collection('work_report_settings').updateOne(
        {
          _id: root._id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        { $set: { [field]: reminderLeadMinutes, updatedAt: new Date() } },
        { session },
      );
      await this.auditEvent(
        actor,
        'REPORT_REMINDER_CHANGED',
        'PROJECT',
        projectId,
        { scope, reminderLeadMinutes },
        session,
      );
    });
    return this.getWorkReportSettings(headers, projectId, scope);
  }

  async updateWorkReportSettings(
    headers: CaptureRequestHeaders,
    projectId: string,
    frequency: WorkReportFrequency,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportSettingsRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    const hasActiveLeaders = await this.resolveHasActiveLeaders(actor, headers);
    if (scope === 'LEADER') {
      if (!this.canManageLeaderTier(actor)) {
        throw this.reviewPermissionDenied();
      }
    } else if (!this.canManageMemberTier(actor, hasActiveLeaders)) {
      throw this.reviewPermissionDenied();
    }

    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    const scopeRows =
      scope === 'LEADER' ? timelines.leaderRows : timelines.memberRows;
    const active = this.activeSetting(scopeRows, now);
    const previousFrequency = (text(active.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const activeEffectiveAt =
      active.effectiveAt instanceof Date
        ? active.effectiveAt
        : new Date(String(active.effectiveAt));
    const existingHistory = this.extractSettingRowHistory(
      active,
      activeEffectiveAt,
      actor.userId,
    );

    const scopeReportFilter =
      scope === 'LEADER'
        ? { reportScope: 'LEADER' }
        : {
            $or: [
              { reportScope: 'MEMBER' },
              { reportScope: { $exists: false } },
            ],
          };
    const untouchedEmptyDraftCondition = {
      status: 'DRAFT',
      $and: [
        { contentSchemaVersion: { $ne: 2 } },
        {
          $or: [{ title: '' }, { title: null }, { title: { $exists: false } }],
        },
        {
          $or: [
            { contentMarkdown: '' },
            { contentMarkdown: null },
            { contentMarkdown: { $exists: false } },
          ],
        },
        {
          $or: [
            { accomplishments: '' },
            { accomplishments: { $exists: false } },
          ],
        },
        { $or: [{ approach: '' }, { approach: { $exists: false } }] },
        { $or: [{ reason: '' }, { reason: { $exists: false } }] },
        { $or: [{ blockers: '' }, { blockers: { $exists: false } }] },
        { $or: [{ nextSteps: '' }, { nextSteps: { $exists: false } }] },
        { $or: [{ file: null }, { file: { $exists: false } }] },
        {
          $or: [
            { documentIds: { $size: 0 } },
            { documentIds: { $exists: false } },
          ],
        },
      ],
    };
    const authoredOrSubmittedCondition = {
      $or: [
        { status: { $ne: 'DRAFT' } },
        { contentSchemaVersion: 2 },
        { title: { $nin: ['', null] } },
        { contentMarkdown: { $nin: ['', null] } },
        { accomplishments: { $nin: ['', null] } },
        { approach: { $nin: ['', null] } },
        { reason: { $nin: ['', null] } },
        { blockers: { $nin: ['', null] } },
        { nextSteps: { $nin: ['', null] } },
        { 'file.key': { $exists: true } },
        { 'documentIds.0': { $exists: true } },
      ],
    };

    let changeEffectiveAt = activeEffectiveAt;

    await this.transaction(async (db, session) => {
      const settingsCollection = db.collection('work_report_settings');
      const reportsCollection = db.collection('work_reports');

      // BE-LOGIC-003: Perform authored-report existence check INSIDE the MongoDB
      // transaction so concurrent draft creation/submission cannot race with cadence splitting.
      const existingAuthoredReport = await reportsCollection.findOne(
        {
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...scopeReportFilter,
          periodStart: { $gte: activeEffectiveAt },
          ...authoredOrSubmittedCondition,
        },
        { session },
      );
      const shouldSplitSegment =
        Boolean(existingAuthoredReport) &&
        activeEffectiveAt.getTime() < now.getTime();
      changeEffectiveAt = shouldSplitSegment ? now : activeEffectiveAt;

      await settingsCollection.deleteMany(
        {
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...(scope === 'LEADER'
            ? { reportScope: 'LEADER' }
            : {
                $or: [
                  { reportScope: 'MEMBER' },
                  { reportScope: { $exists: false } },
                ],
              }),
          _id: { $ne: active._id },
          effectiveAt: { $gt: now },
        },
        { session },
      );

      // Remove untouched auto-generated empty draft shells in the open window
      // so the next obligation pass cleanly materializes the updated cadence period.
      await reportsCollection.deleteMany(
        {
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          ...scopeReportFilter,
          periodEnd: { $gt: now },
          ...untouchedEmptyDraftCondition,
        },
        { session },
      );

      if (shouldSplitSegment) {
        // Close open authored draft period windows at the cadence boundary WITHOUT
        // truncating dueAt to now (preventing false instant OVERDUE transitions).
        await reportsCollection.updateMany(
          {
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            ...scopeReportFilter,
            status: 'DRAFT',
            periodEnd: { $gt: now },
          },
          {
            $set: {
              periodEnd: now,
              updatedAt: now,
            },
          },
          { session },
        );

        if (scope === 'LEADER' && !timelines.hasExplicitLeaderRows) {
          await settingsCollection.insertOne(
            {
              _id: new Types.ObjectId(),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              reportScope: 'LEADER',
              frequency: previousFrequency,
              effectiveAt: activeEffectiveAt,
              createdByUserId:
                active.createdByUserId instanceof Types.ObjectId
                  ? active.createdByUserId
                  : objectId(idText(active.createdByUserId) || actor.userId),
              updatedByUserId:
                active.updatedByUserId instanceof Types.ObjectId
                  ? active.updatedByUserId
                  : objectId(
                      idText(
                        active.updatedByUserId ?? active.createdByUserId,
                      ) || actor.userId,
                    ),
              history: existingHistory.map((entry) => ({
                frequency: entry.frequency,
                effectiveAt: new Date(entry.effectiveAt),
                updatedByUserId: validId(entry.updatedBy)
                  ? objectId(entry.updatedBy)
                  : objectId(actor.userId),
              })),
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
        }

        await settingsCollection.insertOne(
          {
            _id: new Types.ObjectId(),
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            reportScope: scope,
            frequency,
            effectiveAt: now,
            createdByUserId: objectId(actor.userId),
            updatedByUserId: objectId(actor.userId),
            history: [
              {
                frequency,
                effectiveAt: now,
                updatedByUserId: objectId(actor.userId),
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
      } else {
        const appendedHistory = [
          ...existingHistory.map((entry) => ({
            frequency: entry.frequency,
            effectiveAt: new Date(entry.effectiveAt),
            updatedByUserId: validId(entry.updatedBy)
              ? objectId(entry.updatedBy)
              : objectId(actor.userId),
          })),
          {
            frequency,
            effectiveAt: now,
            updatedByUserId: objectId(actor.userId),
          },
        ];

        if (scope === 'LEADER' && !timelines.hasExplicitLeaderRows) {
          await settingsCollection.insertOne(
            {
              _id: new Types.ObjectId(),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              reportScope: 'LEADER',
              frequency,
              effectiveAt: activeEffectiveAt,
              createdByUserId: objectId(actor.userId),
              updatedByUserId: objectId(actor.userId),
              history: appendedHistory,
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
        } else {
          await settingsCollection.updateOne(
            {
              _id: active._id,
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
            },
            {
              $set: {
                reportScope: scope,
                frequency,
                createdByUserId: objectId(actor.userId),
                updatedByUserId: objectId(actor.userId),
                history: appendedHistory,
                updatedAt: now,
              },
            },
            { session },
          );
        }
      }

      await this.appendOutbox(
        {
          eventName: 'WORK_REPORT_FREQUENCY_CHANGED',
          aggregateType: 'WORK_REPORT_SETTINGS',
          aggregateId: projectId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            scope,
            previousFrequency,
            frequency,
            effectiveAt: changeEffectiveAt.toISOString(),
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'REPORT_FREQUENCY_CHANGED',
        'PROJECT',
        projectId,
        {
          scope,
          previousFrequency,
          frequency,
          effectiveAt: changeEffectiveAt.toISOString(),
        },
        session,
      );
    });

    if (this.notifications) {
      try {
        const recipients =
          scope === 'LEADER'
            ? typeof this.authorization.listActiveLeaders === 'function'
              ? (
                  await this.authorization.listActiveLeaders(actor, headers)
                ).map((leader) => leader.userId)
              : await this.resolveProjectLeaderRecipientIds(
                  actor.organizationId,
                  projectId,
                )
            : (await this.authorization.listActiveMembers(actor, headers)).map(
                (member) => member.userId,
              );
        const days = getFrequencyDays(frequency);
        if (recipients.length > 0) {
          await this.notifications.emitSafe({
            type: 'WORK_REPORT_FREQUENCY_CHANGED',
            actorId: actor.userId,
            recipients,
            title:
              scope === 'LEADER'
                ? 'Leader reporting cadence updated'
                : 'Work report schedule updated',
            message:
              scope === 'LEADER'
                ? `Manager updated Leader work report schedule to every ${days} ${days === 1 ? 'day' : 'days'}.`
                : `Project reporting cadence is now every ${days} ${days === 1 ? 'day' : 'days'}.`,
            organizationId: actor.organizationId,
            projectId,
            target: {
              kind: 'PROJECT',
              url: `/projects/${projectId}/work-reports`,
              organizationId: actor.organizationId,
              projectId,
            },
            eventKey: `${scope.toLowerCase()}-report-cadence:${projectId}:${frequency}:${now.getTime()}`,
          });
        }
      } catch {
        // Do not fail setting mutation if notification emit fails
      }
    }

    const updated = await this.scopedSettingsTimelines(actor);
    return this.settingsRecord(updated, actor, now, scope, hasActiveLeaders);
  }

  async listWorkReports(
    headers: CaptureRequestHeaders,
    projectId: string,
    page: number,
    pageSize: number,
    status?: WorkReportStatus,
    scope: WorkReportScope = 'MEMBER',
    filters?: WorkReportsListFilters,
  ): Promise<WorkReportsPageRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (scope === 'LEADER' && isActorPureMember(actor)) {
      throw this.reviewPermissionDenied();
    }
    const now = new Date();
    const collection = this.database().collection('work_reports');

    // BE-PERF-001 & BE-PERF-003: Pure read-only GET (no write-on-read
    // ensureReportObligations / markOverdue mutations on GET; scheduled obligations
    // run in WorkReportOverdueScheduler and draft creation runs on-demand in
    // saveCurrentWorkReportDraft). Run timelines + roster in parallel (0 HTTP hops in monolith).
    const resolveCombinedRoster = async (): Promise<{
      members: Array<{ userId: string; fullName: string; joinedAt: string }>;
      leaders: Array<{ userId: string; fullName: string; joinedAt: string }>;
    }> => {
      if (typeof this.authorization.listActiveRoster === 'function') {
        return this.authorization.listActiveRoster(actor, headers);
      }
      const [members, leaders] = await Promise.all([
        typeof this.authorization.listActiveMembers === 'function'
          ? this.authorization.listActiveMembers(actor, headers)
          : Promise.resolve([]),
        typeof this.authorization.listActiveLeaders === 'function'
          ? this.authorization.listActiveLeaders(actor, headers).catch(() => [])
          : Promise.resolve([]),
      ]);
      return { members, leaders };
    };

    const canViewAllMembers = isActorLeader(actor) || isActorManager(actor);
    const needsRoster = scope === 'LEADER' || canViewAllMembers;
    const [timelines, combinedRoster] = await Promise.all([
      this.scopedSettingsTimelines(actor),
      needsRoster ? resolveCombinedRoster() : Promise.resolve(null),
    ]);

    if (scope === 'LEADER') {
      const canViewAllLeaders = isActorManager(actor);
      const roster = combinedRoster ?? { members: [], leaders: [] };
      const leaders = [...roster.leaders];
      if (isActorLeader(actor)) {
        const normalizedActorId = actor.userId.toLowerCase();
        if (
          !leaders.some((l) => l.userId.toLowerCase() === normalizedActorId)
        ) {
          leaders.push({
            userId: normalizedActorId,
            fullName: actor.userName || actor.userId,
            joinedAt:
              actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
                ? actor.joinedAt
                : startOfUtcWeek(now).toISOString(),
          });
        }
      }
      const hasActiveLeaders = leaders.length > 0 || isActorLeader(actor);
      const extraDirectoryMembers = canViewAllLeaders ? roster.members : [];
      const visibleRosterPeople = canViewAllLeaders
        ? leaders
        : leaders.filter(
            (leader) =>
              leader.userId.toLowerCase() === actor.userId.toLowerCase(),
          );
      const baseVisibilityFilter: Record<string, unknown> = {
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        reportScope: 'LEADER',
        ...(!canViewAllLeaders ? { memberUserId: objectId(actor.userId) } : {}),
      };
      return this.queryWorkReportsPage({
        collection,
        actor,
        scope: 'LEADER',
        scopeRows: timelines.leaderRows,
        rosterPeople: visibleRosterPeople,
        allDirectoryPeople: [...leaders, ...extraDirectoryMembers],
        canViewAllInScope: canViewAllLeaders,
        hasActiveLeaders,
        baseVisibilityFilter,
        page,
        pageSize,
        status,
        filters,
        now,
      });
    }

    let members: Array<{ userId: string; fullName: string; joinedAt: string }>;
    let extraDirectoryLeaders: Array<{
      userId: string;
      fullName: string;
      joinedAt: string;
    }>;
    let hasActiveLeaders: boolean;
    if (canViewAllMembers) {
      const roster = combinedRoster ?? { members: [], leaders: [] };
      members = roster.members;
      extraDirectoryLeaders = roster.leaders;
      hasActiveLeaders =
        isActorLeader(actor) || extraDirectoryLeaders.length > 0;
    } else {
      members = [this.resolveActorMemberObligation(actor)];
      extraDirectoryLeaders = [];
      hasActiveLeaders = true;
    }

    const baseVisibilityFilter: Record<string, unknown> = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      $or: [{ reportScope: 'MEMBER' }, { reportScope: { $exists: false } }],
      ...(!canViewAllMembers ? { memberUserId: objectId(actor.userId) } : {}),
    };
    return this.queryWorkReportsPage({
      collection,
      actor,
      scope: 'MEMBER',
      scopeRows: timelines.memberRows,
      rosterPeople: members,
      allDirectoryPeople: [...members, ...extraDirectoryLeaders],
      canViewAllInScope: canViewAllMembers,
      hasActiveLeaders,
      baseVisibilityFilter,
      page,
      pageSize,
      status,
      filters,
      now,
    });
  }

  async saveCurrentWorkReportDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: WorkReportInput,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (scope === 'LEADER') {
      if (!isActorLeader(actor)) {
        throw new ForbiddenException({
          code: 'WORK_REPORT_LEADER_ONLY',
          message: 'Only Project Leaders can save a Leader Work Report draft.',
        });
      }
      const now = new Date();
      let resolvedJoinedAt =
        actor.joinedAt && Number.isFinite(Date.parse(actor.joinedAt))
          ? actor.joinedAt
          : undefined;
      if (typeof this.authorization.listActiveLeaders === 'function') {
        try {
          const activeLeaders = await this.authorization.listActiveLeaders(
            actor,
            headers,
          );
          const matched = activeLeaders.find(
            (leader) =>
              leader.userId.toLowerCase() === actor.userId.toLowerCase(),
          );
          if (
            matched?.joinedAt &&
            Number.isFinite(Date.parse(matched.joinedAt))
          ) {
            resolvedJoinedAt = matched.joinedAt;
          }
        } catch {
          // Fallback safely to actor.joinedAt if directory lookup is unavailable
        }
      }
      const leaderObligation = {
        userId: actor.userId,
        fullName: actor.userName,
        joinedAt: resolvedJoinedAt ?? startOfUtcWeek(now).toISOString(),
      };
      const timelines = await this.scopedSettingsTimelines(actor);
      await this.ensureReportObligations(
        actor,
        [leaderObligation],
        timelines.leaderRows,
        now,
        'LEADER',
      );
      await this.markOverdue(
        actor,
        projectId,
        now,
        new Set([actor.userId.toLowerCase()]),
        'LEADER',
      );
      const currentSetting = this.activeSetting(timelines.leaderRows, now);
      const period = calculateReportPeriod(
        currentSetting.effectiveAt instanceof Date
          ? currentSetting.effectiveAt
          : new Date(String(currentSetting.effectiveAt)),
        text(currentSetting.frequency) as WorkReportFrequency,
        now,
      );
      const row = record(
        await this.database()
          .collection('work_reports')
          .findOne({
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            memberUserId: objectId(actor.userId),
            reportScope: 'LEADER',
            periodStart: period.periodStart,
          }),
      );
      if (!row) throw reportNotFound();
      return this.saveReportDraft(actor, row._id, input, 'LEADER');
    }

    if (!isActorPureMember(actor)) {
      throw new ForbiddenException({
        code: 'WORK_REPORT_MEMBER_ONLY',
        message:
          'Project Leaders and Managers are excluded from member Work Report obligations.',
      });
    }
    const member = this.resolveActorMemberObligation(actor);
    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    await this.ensureReportObligations(
      actor,
      [member],
      timelines.memberRows,
      now,
      'MEMBER',
    );
    await this.markOverdue(
      actor,
      projectId,
      now,
      new Set([member.userId.toLowerCase()]),
      'MEMBER',
    );
    const currentSetting = this.activeSetting(timelines.memberRows, now);
    const period = calculateReportPeriod(
      currentSetting.effectiveAt instanceof Date
        ? currentSetting.effectiveAt
        : new Date(String(currentSetting.effectiveAt)),
      text(currentSetting.frequency) as WorkReportFrequency,
      now,
    );
    const row = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          memberUserId: objectId(actor.userId),
          $or: [{ reportScope: 'MEMBER' }, { reportScope: { $exists: false } }],
          periodStart: period.periodStart,
        }),
    );
    if (!row) throw reportNotFound();
    return this.saveReportDraft(actor, row._id, input, 'MEMBER');
  }

  async uploadWorkReportFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    name: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const cleanName = name.trim();
    const resolvedContentType =
      bytes.length > 0 &&
      bytes.length <= 20 * 1024 * 1024 &&
      cleanName.length > 0 &&
      cleanName.length <= 180 &&
      !/[\\/]/.test(cleanName) &&
      ![...cleanName].some((character) => character.charCodeAt(0) < 32)
        ? resolveValidatedDocumentContentType(cleanName, contentType, bytes)
        : null;
    if (!resolvedContentType)
      throw new BadRequestException({
        code: 'DOCUMENT_FILE_INVALID',
        message:
          'A supported document file (PDF, DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, MD, CSV, TSV, JSON, YAML, XML, SQL, DRAWIO, PNG, JPG, WEBP) up to 20 MB is required.',
      });
    const id = objectId(reportId);
    const reports = this.database().collection('work_reports');
    const existing = await reports.findOne({
      _id: id,
      organizationId: objectId(actor.organizationId),
      projectId: objectId(projectId),
      memberUserId: objectId(actor.userId),
      status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
    });
    if (!existing) throw reportNotFound();
    const existingScope: WorkReportScope =
      text((existing as Record<string, unknown>).reportScope) === 'LEADER'
        ? 'LEADER'
        : 'MEMBER';
    this.assertCanAuthorScope(actor, existingScope);
    if (!this.documentStorage)
      throw new ServiceUnavailableException(
        'Project Document storage is unavailable.',
      );
    const key = `work-reports/${actor.organizationId}/${projectId}/${reportId}/${randomUUID()}`;
    await this.documentStorage.put(key, bytes, resolvedContentType);
    try {
      await this.transaction(async (db, session) => {
        const result = await db.collection('work_reports').updateOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            memberUserId: objectId(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
          },
          {
            $set: {
              file: {
                key,
                name: cleanName,
                contentType: resolvedContentType,
                size: bytes.length,
              },
              updatedAt: new Date(),
            },
          },
          { session },
        );
        if (result.matchedCount !== 1)
          throw conflict('The Work Report changed during file upload.');
        await this.auditEvent(
          actor,
          'REPORT_FILE_UPLOADED',
          'WORK_REPORT',
          reportId,
          { fileName: cleanName, size: bytes.length },
          session,
        );
      });
    } catch (error) {
      await this.documentStorage.delete(key).catch(() => undefined);
      throw error;
    }
    const oldKey = (existing.file as { key?: string } | undefined)?.key;
    if (oldKey && oldKey !== key) {
      await this.documentStorage.delete(oldKey).catch(() => undefined);
    }
    return this.getWorkReport(headers, projectId, reportId);
  }

  async resolveWorkReportFileDownloadUrl(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<DocumentDownloadUrlResponse> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const existingFile = row.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (existingFile?.key && existingFile.name && existingFile.contentType) {
      return this.buildDownloadUrlResponse({
        key: existingFile.key,
        name: existingFile.name,
        contentType: existingFile.contentType,
      });
    }
    if (text(row.status) === 'APPROVED') {
      const file = await this.ensureApprovedWorkReportMarkdownStored(
        actor,
        row,
      );
      return this.buildDownloadUrlResponse(file);
    }
    throw reportNotFound();
  }

  async downloadWorkReportFile(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<{ bytes: Buffer; name: string; contentType: string }> {
    const { actor, row: report } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const file = report.file as
      { key?: string; name?: string; contentType?: string } | undefined;
    if (file?.key && file.name && file.contentType) {
      if (!this.documentStorage) {
        throw new ServiceUnavailableException(
          'Project Document storage is unavailable.',
        );
      }
      return {
        bytes: await this.documentStorage.get(file.key),
        name: file.name,
        contentType: file.contentType,
      };
    }
    if (text(report.status) === 'APPROVED') {
      const generated = await this.ensureApprovedWorkReportMarkdownStored(
        actor,
        report,
      );
      if (generated.bytes) {
        return {
          bytes: generated.bytes,
          name: generated.name,
          contentType: generated.contentType,
        };
      }
      if (!this.documentStorage || !generated.key) {
        throw new ServiceUnavailableException(
          'Project Document storage is unavailable.',
        );
      }
      return {
        bytes: await this.documentStorage.get(generated.key),
        name: generated.name,
        contentType: generated.contentType,
      };
    }
    throw reportNotFound();
  }

  async getWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const row = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          _id: objectId(reportId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        }),
    );
    if (!row || !this.canViewWorkReportRow(actor, row)) {
      throw reportNotFound();
    }
    const memberId = String(row.memberUserId);
    const isLeaderReport = text(row.reportScope) === 'LEADER';
    const [memberName, hasActiveLeaders] = await Promise.all([
      memberId.toLowerCase() === actor.userId.toLowerCase()
        ? Promise.resolve(actor.userName)
        : isActorLeader(actor) || isActorManager(actor)
          ? (async () => {
              const normalizedMemberId = memberId.toLowerCase();
              const [members, leaders] = await Promise.all([
                isLeaderReport
                  ? this.authorization
                      .listActiveMembers(actor, headers)
                      .catch(() => [])
                  : this.authorization.listActiveMembers(actor, headers),
                typeof this.authorization.listActiveLeaders === 'function'
                  ? this.authorization
                      .listActiveLeaders(actor, headers)
                      .catch(() => [])
                  : Promise.resolve([]),
              ]);
              const primary = isLeaderReport ? leaders : members;
              const secondary = isLeaderReport ? members : leaders;
              return (
                primary.find(
                  (person) =>
                    person.userId.toLowerCase() === normalizedMemberId,
                )?.fullName ??
                secondary.find(
                  (person) =>
                    person.userId.toLowerCase() === normalizedMemberId,
                )?.fullName
              );
            })()
          : Promise.resolve(undefined),
      this.resolveHasActiveLeaders(actor, headers),
    ]);
    const mapped = this.workReportRecord(
      row,
      actor,
      memberName,
      hasActiveLeaders,
    );
    const hasLiveTransport =
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function';
    if (
      mapped.status === 'APPROVED' &&
      shouldRefreshLiveKnowledgeSync(mapped.knowledgeSync, hasLiveTransport)
    ) {
      const refreshed = await this.resolveWorkReportKnowledgeStatusForRow(
        actor,
        projectId,
        row,
      ).catch(() => mapped.knowledgeSync);
      if (refreshed) mapped.knowledgeSync = refreshed;
    }
    const [withStorageRef] = await this.attachWorkReportStorageReferences(
      actor.organizationId,
      projectId,
      [row],
      [mapped],
    );
    return withStorageRef ?? mapped;
  }

  async updateWorkReportDraft(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    input: WorkReportInput,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    return this.saveReportDraft(
      actor,
      objectId(reportId),
      input,
      undefined,
      headers,
    );
  }

  async submitWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    options?: { autoApprove?: boolean },
  ): Promise<WorkReportRecord> {
    void options;
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const id = objectId(reportId);
    const now = new Date();
    // BE-LOGIC-001: Self-approval is unconditionally forbidden. Submitting a
    // Work Report ALWAYS transitions to PENDING_REVIEW for an independent reviewer.
    const { submittedScope } = await this.transaction(async (db, session) => {
      const reports = db.collection('work_reports');
      const current = record(
        await reports.findOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            memberUserId: objectId(actor.userId),
            status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
          },
          { session },
        ),
      );
      if (!current) throw reportNotFound();
      const currentScope: WorkReportScope =
        text(current.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
      this.assertCanAuthorScope(actor, currentScope);
      const hasFreeformBody =
        Boolean(text(current.title).trim()) &&
        Boolean(text(current.contentMarkdown).trim());
      const hasStructuredBody =
        Boolean(text(current.accomplishments).trim()) &&
        Boolean(text(current.approach).trim()) &&
        Boolean(text(current.reason).trim());
      if (
        current.contentSchemaVersion === 2
          ? !hasFreeformBody
          : !hasFreeformBody && !hasStructuredBody
      )
        throw conflict(
          current.contentSchemaVersion === 2 ||
            Boolean(text(current.title).trim()) ||
            Boolean(text(current.contentMarkdown).trim())
            ? 'Complete title and content before submitting.'
            : 'Complete the three required report fields before submitting.',
        );
      const currentMemberId = String(current.memberUserId);
      const updated = await reports.updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
          memberUserId: objectId(actor.userId),
          status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
        },
        {
          $set: { status: 'PENDING_REVIEW', submittedAt: now, updatedAt: now },
        },
        { session },
      );
      if (updated.modifiedCount !== 1)
        throw conflict('The Work Report changed before it was submitted.');
      await this.appendOutbox(
        {
          eventName: 'WORK_REPORT_SUBMITTED',
          aggregateType: 'WORK_REPORT',
          aggregateId: reportId,
          payload: {
            organizationId: actor.organizationId,
            projectId,
            memberId: currentMemberId,
            scope: currentScope,
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'REPORT_SUBMITTED',
        'WORK_REPORT',
        reportId,
        {
          memberId: currentMemberId,
          scope: currentScope,
        },
        session,
      );
      return { memberId: currentMemberId, submittedScope: currentScope };
    });

    if (this.notifications) {
      try {
        const recipients =
          submittedScope === 'LEADER'
            ? await this.resolveOrganizationManagerRecipientIds(
                actor.organizationId,
              )
            : await this.resolveProjectLeaderRecipientIds(
                actor.organizationId,
                projectId,
              );
        if (recipients.length > 0) {
          const authorLabel = actor.userName || 'A team member';
          await this.notifications.emitSafe({
            type: 'WORK_REPORT_SUBMITTED',
            actorId: actor.userId,
            recipients,
            title:
              submittedScope === 'LEADER'
                ? 'Leader work report submitted for review'
                : 'Member work report submitted for review',
            message:
              submittedScope === 'LEADER'
                ? `${authorLabel} submitted a Leader work report awaiting Manager review.`
                : `${authorLabel} submitted a periodic work report awaiting Leader review.`,
            organizationId: actor.organizationId,
            projectId,
            target: {
              kind: 'PROJECT',
              url: `/projects/${projectId}/work-reports`,
              organizationId: actor.organizationId,
              projectId,
            },
            eventKey: `work-report-submitted:${reportId}:${now.getTime()}`,
          });
        }
      } catch {
        // Do not fail report submission if notification emit fails
      }
    }

    return this.getWorkReport(headers, projectId, reportId);
  }

  async reviewWorkReport(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED',
    input: ReviewInput,
  ): Promise<WorkReportRecord> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!isActorLeader(actor) && !isActorManager(actor)) {
      throw this.reviewPermissionDenied();
    }
    if (!validId(reportId)) throw reportNotFound();
    const id = objectId(reportId);
    const now = new Date();
    let reportVersion = 1;
    const { memberId, reviewedScope } = await this.transaction(
      async (db, session) => {
        const reports = db.collection('work_reports');
        const current = record(
          await reports.findOne(
            {
              _id: id,
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
              status: 'PENDING_REVIEW',
            },
            { session },
          ),
        );
        if (!current) throw reportNotFound();
        const isLeaderReport = text(current.reportScope) === 'LEADER';
        const currentScope: WorkReportScope = isLeaderReport
          ? 'LEADER'
          : 'MEMBER';
        // SEC-AUTH-007: Per 04_WORK_NOTE_WORKFLOWS.md, Managers can review BOTH
        // MEMBER and LEADER reports in active org projects (while LEADER reports
        // require Manager review and MEMBER schedule configuration stays Leader-owned).
        const canReviewScope = isLeaderReport
          ? this.canManageLeaderTier(actor)
          : this.canReviewMemberTier(actor);
        if (!canReviewScope) {
          throw this.reviewPermissionDenied();
        }
        const currentMemberId = String(current.memberUserId);
        assertReviewerCanReview(currentMemberId, actor.userId, canReviewScope);
        const reviewerRole: 'MANAGER' | 'LEADER' = isLeaderReport
          ? 'MANAGER'
          : isActorLeader(actor)
            ? 'LEADER'
            : 'MANAGER';
        reportVersion = Math.max(1, Number(current.currentVersionNumber ?? 1));
        const rawProv =
          current.provenance &&
          typeof current.provenance === 'object' &&
          !Array.isArray(current.provenance)
            ? (current.provenance as Record<string, unknown>)
            : {};
        const nextProv: Record<string, unknown> = { ...rawProv };
        if (action === 'APPROVED') {
          nextProv.knowledgeSync = {
            documentId: reportId,
            version: reportVersion,
            status: 'QUEUED_OUTBOX',
            searchStatus: 'PENDING',
            knowledgeStatus: 'NOT_STARTED',
            searchReady: false,
            knowledgeReady: false,
            currentStage: 'OUTBOX_QUEUE',
            progress: 5,
            syncedAt: now.toISOString(),
          } satisfies DocumentKnowledgeStatusRecord;
        } else {
          delete nextProv.knowledgeSync;
          delete nextProv.fileSha256;
        }
        const history = pickReviewHistory(current.reviewHistory);
        const updated = await reports.updateOne(
          {
            _id: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(projectId),
            status: 'PENDING_REVIEW',
          },
          {
            $set: {
              status: action,
              reviewedByUserId: objectId(actor.userId),
              reviewedByName: actor.userName,
              reviewedAt: now,
              ...(input.comment ? { reviewComment: input.comment } : {}),
              reviewHistory: [
                ...history,
                {
                  action,
                  reviewerId: actor.userId,
                  reviewerRole,
                  ...(input.comment ? { comment: input.comment } : {}),
                  at: now,
                },
              ],
              ...(Object.keys(nextProv).length > 0 ||
              current.provenance !== undefined
                ? { provenance: nextProv }
                : {}),
              updatedAt: now,
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1)
          throw conflict('The Work Report was reviewed by another user.');
        const eventName =
          action === 'APPROVED'
            ? 'WORK_REPORT_APPROVED'
            : action === 'CHANGES_REQUESTED'
              ? 'WORK_REPORT_CHANGES_REQUESTED'
              : 'WORK_REPORT_REJECTED';
        await this.appendOutbox(
          {
            eventName,
            aggregateType: 'WORK_REPORT',
            aggregateId: reportId,
            payload: {
              organizationId: actor.organizationId,
              projectId,
              memberId: currentMemberId,
              scope: currentScope,
              reviewerRole,
              ...(input.comment ? { comment: input.comment } : {}),
            },
          },
          session,
        );
        if (action === 'APPROVED') {
          await this.appendOutbox(
            {
              eventName: 'KNOWLEDGE_SOURCE_APPROVED',
              aggregateType: 'WORK_REPORT',
              aggregateId: reportId,
              payload: {
                sourceType: 'PERIODIC_REPORT',
                sourceId: reportId,
                organizationId: actor.organizationId,
                projectId,
                version: reportVersion,
                approvedAt: now.toISOString(),
              },
            },
            session,
          );
        }
        const auditAction =
          action === 'APPROVED'
            ? 'REPORT_APPROVED'
            : action === 'CHANGES_REQUESTED'
              ? 'REPORT_CHANGES_REQUESTED'
              : 'REPORT_REJECTED';
        await this.auditEvent(
          actor,
          auditAction,
          'WORK_REPORT',
          reportId,
          {
            memberId: currentMemberId,
            scope: currentScope,
            reviewerRole,
          },
          session,
        );
        return { memberId: currentMemberId, reviewedScope: currentScope };
      },
    );
    if (action === 'APPROVED') {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        reportId,
        'KNOWLEDGE_SOURCE_APPROVED',
        reportVersion,
        headers.requestId,
      );
    }
    if (this.notifications && memberId) {
      const notificationType =
        action === 'APPROVED'
          ? 'WORK_REPORT_APPROVED'
          : action === 'CHANGES_REQUESTED'
            ? 'WORK_REPORT_CHANGES_REQUESTED'
            : 'WORK_REPORT_REJECTED';
      await this.notifications.emitSafe({
        type: notificationType,
        actorId: actor.userId,
        recipients: [memberId],
        title:
          action === 'APPROVED'
            ? reviewedScope === 'LEADER'
              ? 'Leader work report approved'
              : 'Work report approved'
            : action === 'CHANGES_REQUESTED'
              ? reviewedScope === 'LEADER'
                ? 'Changes requested on Leader work report'
                : 'Changes requested on work report'
              : reviewedScope === 'LEADER'
                ? 'Leader work report rejected'
                : 'Work report rejected',
        message: input.comment
          ? `Reviewer feedback: ${input.comment}`
          : `Your work report status was updated to ${action.replace('_', ' ').toLowerCase()}.`,
        organizationId: actor.organizationId,
        projectId,
        target: {
          kind: 'PROJECT',
          url: `/projects/${projectId}/work-reports`,
          organizationId: actor.organizationId,
          projectId,
        },
        eventKey: `work-report-review:${reportId}:${action}:${now.getTime()}`,
      });
    }
    return this.getWorkReport(headers, projectId, reportId);
  }

  async getWorkReportKnowledgeStatus(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    return this.resolveWorkReportKnowledgeStatusForRow(actor, projectId, row);
  }

  async getWorkReportKnowledgeChunks(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<DocumentKnowledgeChunksResponse> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    return this.resolveEntityKnowledgeChunks({
      actor,
      projectId,
      aggregateType: 'WORK_REPORT',
      entityId: reportId,
      versionNumber,
      rawProvenance: rawProv,
      options,
    });
  }

  async syncWorkReportToSag(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    // BE-LOGIC-001: Sync NEVER auto-approves or promotes unapproved Work Reports.
    if (text(row.status) !== 'APPROVED') {
      if (!actor.canReview && !isActorLeader(actor) && !isActorManager(actor)) {
        throw new ForbiddenException({
          code: 'LEADER_APPROVAL_REQUIRED',
          message:
            'Only an approved Work Report can be synchronized to SAG. Approve the report first.',
        });
      }
      throw conflict(
        'Only an approved Work Report can be synchronized to SAG. Approve it via the review workflow first.',
      );
    }
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    return this.syncApprovedArtifactToSag({
      actor,
      projectId,
      aggregateType: 'WORK_REPORT',
      logicalPrefix: 'work_report',
      entityId: reportId,
      versionNumber,
      rawProvenance: rawProv,
      ensureStoredFile: () =>
        this.ensureApprovedWorkReportMarkdownStored(actor, row),
      persistSync: (syncRecord) =>
        this.persistWorkReportKnowledgeSyncRecord(
          reportId,
          versionNumber,
          syncRecord,
        ),
      auditAction: 'WORK_REPORT_KNOWLEDGE_SYNCED',
    });
  }

  async controlWorkReportKnowledge(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    action: DocumentKnowledgeControlAction,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const memberId = String(row.memberUserId);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const isApproved = text(row.status) === 'APPROVED';
    const isLeaderReport = text(row.reportScope) === 'LEADER';
    const isReviewer = isLeaderReport
      ? this.canManageLeaderTier(actor)
      : this.canReviewMemberTier(actor);
    // SEC-AUTH-007: Regular MEMBER authors cannot REVOKE/PAUSE/control approved SAG knowledge.
    const canControl = isApproved
      ? isReviewer
      : memberId.toLowerCase() === actor.userId.toLowerCase() || isReviewer;
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    return this.controlEntityKnowledge({
      actor,
      projectId,
      aggregateType: 'WORK_REPORT',
      logicalPrefix: 'work_report',
      entityId: reportId,
      versionNumber,
      canControl,
      rawProvenance: rawProv,
      action,
      ensureStoredFile: () =>
        this.ensureApprovedWorkReportMarkdownStored(actor, row),
      persistSync: (syncRecord) =>
        this.persistWorkReportKnowledgeSyncRecord(
          reportId,
          versionNumber,
          syncRecord,
        ),
      resyncFn: () => this.syncWorkReportToSag(headers, projectId, reportId),
      getStatusFn: () =>
        this.getWorkReportKnowledgeStatus(headers, projectId, reportId),
      auditPrefix: 'WORK_REPORT',
    });
  }

  async purgeWorkReportArtifact(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
    options?: { reopen?: boolean; comment?: string },
  ): Promise<PurgeArtifactResult> {
    const { actor, row } = await this.loadAuthorizedWorkReportRow(
      headers,
      projectId,
      reportId,
    );
    const hasActiveLeaders = await this.resolveHasActiveLeaders(actor, headers);
    const memberId = String(row.memberUserId);
    const isOwner = memberId.toLowerCase() === actor.userId.toLowerCase();
    const isLeaderReport = text(row.reportScope) === 'LEADER';
    const canManageScope = isLeaderReport
      ? this.canManageLeaderTier(actor)
      : this.canManageMemberTier(actor, hasActiveLeaders);
    const currentStatus = text(row.status) as WorkReportStatus;

    if (!canManageScope && !(isOwner && currentStatus !== 'APPROVED')) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CONTROL_FORBIDDEN',
        message:
          'Only a Project reviewer or the draft owner can remove Work Report storage artifacts.',
      });
    }

    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const existingSync = normalizeKnowledgeSyncForVersion(
      rawProv.knowledgeSync,
      versionNumber,
    );
    const fileKey = (row.file as { key?: string } | undefined)?.key;
    const shouldRevokeSag =
      currentStatus === 'APPROVED' ||
      Boolean(existingSync?.sagDocumentId) ||
      (Boolean(existingSync?.status) && existingSync?.status !== 'REVOKED');

    let sagRevoked = false;
    if (shouldRevokeSag) {
      if (typeof this.sagTransport?.revokeProjectDocument === 'function') {
        await this.sagTransport
          .revokeProjectDocument({
            organizationId: actor.organizationId,
            projectId,
            documentId: reportId,
            version: versionNumber,
            logicalSourceId: `continuum:work_report:${reportId}`,
            actorUserId: actor.userId,
            reason: options?.reopen
              ? 'WORK_REPORT_REOPENED'
              : 'ARTIFACT_PURGED',
          })
          .then(() => {
            sagRevoked = true;
          })
          .catch(() => undefined);
      } else {
        sagRevoked = true;
      }
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const shouldReopen = Boolean(options?.reopen && canManageScope);
    const nextStatus: WorkReportStatus = shouldReopen
      ? 'CHANGES_REQUESTED'
      : currentStatus;
    const comment = options?.comment?.trim() || undefined;
    const reviewerRole: 'MANAGER' | 'LEADER' = isLeaderReport
      ? 'MANAGER'
      : isActorLeader(actor)
        ? 'LEADER'
        : 'MANAGER';
    const history = pickReviewHistory(row.reviewHistory);
    const nextProv: Record<string, unknown> = { ...rawProv };
    delete nextProv.fileSha256;
    if (shouldReopen) {
      delete nextProv.knowledgeSync;
    } else if (shouldRevokeSag) {
      nextProv.knowledgeSync = {
        ...(existingSync ?? {}),
        documentId: reportId,
        version: versionNumber,
        status: 'REVOKED',
        searchStatus: 'REVOKED',
        knowledgeStatus: 'REVOKED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'REVOKED',
        progress: 0,
        syncedAt: nowIso,
      } satisfies DocumentKnowledgeStatusRecord;
    }

    await this.transaction(async (db, session) => {
      await db.collection('work_reports').updateOne(
        {
          _id: objectId(reportId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        {
          $set: {
            ...(shouldReopen
              ? {
                  status: 'CHANGES_REQUESTED',
                  reviewedByUserId: objectId(actor.userId),
                  reviewedByName: actor.userName,
                  reviewedAt: now,
                  ...(comment ? { reviewComment: comment } : {}),
                  reviewHistory: [
                    ...history,
                    {
                      action: 'CHANGES_REQUESTED',
                      reviewerId: actor.userId,
                      reviewerRole,
                      ...(comment ? { comment } : {}),
                      at: now,
                    },
                  ],
                }
              : {}),
            provenance: nextProv,
            updatedAt: now,
          },
          $unset: { file: '' },
        },
        { session },
      );

      if (this.outbox && shouldRevokeSag) {
        await this.appendOutbox(
          {
            eventName: 'KNOWLEDGE_SOURCE_REVOKED',
            aggregateType: 'WORK_REPORT',
            aggregateId: reportId,
            payload: {
              sourceType: 'PERIODIC_REPORT',
              sourceId: reportId,
              organizationId: actor.organizationId,
              projectId,
              version: versionNumber,
              reason: shouldReopen ? 'REOPENED' : 'ARTIFACT_PURGED',
            },
          },
          session,
        );
      }

      await this.auditEvent(
        actor,
        'WORK_REPORT_ARTIFACT_PURGED',
        'WORK_REPORT',
        reportId,
        {
          version: versionNumber,
          reopened: shouldReopen,
          hadStorageKey: Boolean(fileKey),
        },
        session,
      );
    });

    if (shouldRevokeSag) {
      await this.dispatchKnowledgeIngestionJob(
        projectId,
        reportId,
        'KNOWLEDGE_SOURCE_REVOKED',
        versionNumber,
        headers.requestId,
      );
    }

    let r2DeletedKeys = 0;
    let r2RetainedSharedKeys = 0;
    if (fileKey) {
      const stillReferenced = await this.isStorageKeyStillReferenced(
        actor.organizationId,
        projectId,
        fileKey,
        { excludeWorkReportId: reportId },
      );
      if (stillReferenced) {
        r2RetainedSharedKeys = 1;
      } else if (this.documentStorage) {
        await this.documentStorage.delete(fileKey).catch(() => undefined);
        r2DeletedKeys = 1;
      }
    }

    return {
      entityId: reportId,
      status: nextStatus,
      sagRevoked,
      r2DeletedKeys,
      r2RetainedSharedKeys,
    };
  }

  async bulkWorkReportAction(
    headers: CaptureRequestHeaders,
    projectId: string,
    input: BulkGovernanceActionInput<BulkWorkReportGovernanceAction>,
  ): Promise<BulkGovernanceResult> {
    const uniqueIds = Array.from(
      new Set(input.ids.map((id) => id.trim()).filter(Boolean)),
    ).slice(0, 50);
    const outcomes = new Array<
      { ok: true; id: string } | { ok: false; id: string; message: string }
    >(uniqueIds.length);

    await runWithConcurrency(
      uniqueIds.map((id, index) => ({ id, index })),
      BULK_ACTION_CONCURRENCY,
      async ({ id, index }) => {
        try {
          switch (input.action) {
            case 'APPROVE':
              await this.reviewWorkReport(headers, projectId, id, 'APPROVED', {
                comment: input.comment,
              });
              break;
            case 'REQUEST_CHANGES':
              await this.reviewWorkReport(
                headers,
                projectId,
                id,
                'CHANGES_REQUESTED',
                { comment: input.comment },
              );
              break;
            case 'REJECT':
              await this.reviewWorkReport(headers, projectId, id, 'REJECTED', {
                comment: input.comment,
              });
              break;
            case 'SYNC':
              await this.syncWorkReportToSag(headers, projectId, id);
              break;
            case 'PAUSE':
            case 'RESUME':
            case 'REPROCESS':
            case 'REVOKE':
              await this.controlWorkReportKnowledge(
                headers,
                projectId,
                id,
                input.action,
              );
              break;
            case 'PURGE_ARTIFACT':
              await this.purgeWorkReportArtifact(headers, projectId, id, {
                reopen: input.reopen,
                comment: input.comment,
              });
              break;
            case 'REOPEN':
              await this.purgeWorkReportArtifact(headers, projectId, id, {
                reopen: true,
                comment: input.comment,
              });
              break;
            default:
              throw new BadRequestException({ code: 'INVALID_BULK_ACTION' });
          }
          outcomes[index] = { ok: true, id };
        } catch (err) {
          outcomes[index] = {
            ok: false,
            id,
            message: sanitizeClientErrorMessage(err, 'Operation failed.'),
          };
        }
      },
    );

    const succeededIds: string[] = [];
    const failed: Array<{ id: string; message: string }> = [];
    for (const outcome of outcomes) {
      if (outcome.ok) succeededIds.push(outcome.id);
      else failed.push({ id: outcome.id, message: outcome.message });
    }

    return {
      action: input.action,
      requestedCount: uniqueIds.length,
      succeededIds,
      failed,
    };
  }

  async sweepOverdueReports(
    activeRosters?: ReportingProjectMembers[],
  ): Promise<number> {
    const db = this.database();
    const now = new Date();
    const rostersByProject = activeRosters
      ? new Map(
          activeRosters.map((roster) => [
            roster.projectId.toLowerCase(),
            {
              members: new Set(
                roster.members.map((member) => member.userId.toLowerCase()),
              ),
              leaders: roster.leaders
                ? new Set(
                    roster.leaders.map((leader) => leader.userId.toLowerCase()),
                  )
                : undefined,
            },
          ]),
        )
      : undefined;

    // BE-LOGIC-003: Keyset-paginate over { dueAt, _id } across ALL overdue batches
    // so inactive/archived rows never starve later active projects past row 500.
    const batchSize = 500;
    let lastDueAt: Date | null = null;
    let lastId: Types.ObjectId | null = null;
    let transitioned = 0;

    while (true) {
      const query: Record<string, unknown> = {
        status: 'DRAFT',
        dueAt: { $lte: now },
      };
      if (lastDueAt && lastId) {
        query.$or = [
          { dueAt: { $gt: lastDueAt } },
          { dueAt: lastDueAt, _id: { $gt: lastId } },
        ];
      }
      const rows = await db
        .collection('work_reports')
        .find(query)
        .sort({ dueAt: 1, _id: 1 })
        .limit(batchSize)
        .toArray();
      if (rows.length === 0) break;

      const tail = rows[rows.length - 1] as unknown as Record<string, unknown>;
      lastDueAt =
        tail.dueAt instanceof Date ? tail.dueAt : new Date(String(tail.dueAt));
      lastId =
        tail._id instanceof Types.ObjectId
          ? tail._id
          : objectId(String(tail._id));

      for (const candidate of rows) {
        const item = candidate as unknown as Record<string, unknown>;
        const candidateProjectId = String(item.projectId).toLowerCase();
        const candidateMemberId = String(item.memberUserId).toLowerCase();
        const candidateScope: WorkReportScope =
          text(item.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
        if (rostersByProject) {
          const projectRoster = rostersByProject.get(candidateProjectId);
          if (!projectRoster) {
            continue;
          }
          if (candidateScope === 'LEADER') {
            if (
              projectRoster.leaders &&
              !projectRoster.leaders.has(candidateMemberId)
            ) {
              continue;
            }
          } else if (!projectRoster.members.has(candidateMemberId)) {
            continue;
          }
        }
        const id = objectId(String(item._id));
        const didTransition = await this.transaction(
          async (transactionDb, session) => {
            const update = await transactionDb
              .collection('work_reports')
              .updateOne(
                {
                  _id: id,
                  organizationId: item.organizationId,
                  projectId: item.projectId,
                  status: 'DRAFT',
                  dueAt: { $lte: now },
                },
                { $set: { status: 'OVERDUE', updatedAt: now } },
                { session },
              );
            if (update.modifiedCount !== 1) return false;
            const projectId = String(item.projectId);
            const memberId = String(item.memberUserId);
            const commonPayload = {
              organizationId: String(item.organizationId),
              projectId,
              memberId,
              scope: candidateScope,
              periodStart: iso(item.periodStart),
              periodEnd: iso(item.periodEnd),
              dueAt: iso(item.dueAt),
            };
            await this.appendOutbox(
              {
                eventName: 'WORK_REPORT_DUE',
                aggregateType: 'WORK_REPORT',
                aggregateId: String(id),
                payload: commonPayload,
              },
              session,
            );
            await this.appendOutbox(
              {
                eventName: 'WORK_REPORT_OVERDUE',
                aggregateType: 'WORK_REPORT',
                aggregateId: String(id),
                payload: commonPayload,
              },
              session,
            );
            return true;
          },
        );
        if (didTransition) {
          transitioned += 1;
          if (this.notifications) {
            await this.notifications.emitSafe({
              type: 'WORK_REPORT_OVERDUE',
              actorId: null,
              recipients: [String(item.memberUserId)],
              title:
                candidateScope === 'LEADER'
                  ? 'Leader work report overdue'
                  : 'Work report overdue',
              message:
                'Your periodic work report has passed its due date. Please complete and submit your report.',
              organizationId: String(item.organizationId),
              projectId: String(item.projectId),
              target: {
                kind: 'PROJECT',
                url: `/projects/${String(item.projectId)}/work-reports`,
                organizationId: String(item.organizationId),
                projectId: String(item.projectId),
              },
              eventKey: `work-report-overdue:${String(id)}`,
            });
          }
        }
      }

      if (rows.length < batchSize) break;
    }
    return transitioned;
  }

  async ensureScheduledReportObligations(
    project: ReportingProjectMembers,
  ): Promise<void> {
    const actor: WorkNotesActor = {
      userId: project.projectCreatedBy,
      userName: '',
      organizationId: project.organizationId,
      projectId: project.projectId,
      canReview: true,
      canConfigure: true,
    };
    const timelines = await this.scopedSettingsTimelines(actor);
    const now = new Date();
    if (project.members.length > 0) {
      await this.ensureReportObligations(
        actor,
        project.members,
        timelines.memberRows,
        now,
        'MEMBER',
      );
    }
    if ((project.leaders?.length ?? 0) > 0) {
      await this.ensureReportObligations(
        actor,
        project.leaders!,
        timelines.leaderRows,
        now,
        'LEADER',
      );
    }
  }

  private async saveReportDraft(
    actor: WorkNotesActor,
    reportId: Types.ObjectId,
    input: WorkReportInput,
    expectedScope?: WorkReportScope,
    headers?: CaptureRequestHeaders,
  ): Promise<WorkReportRecord> {
    const reports = this.database().collection('work_reports');
    const existingReport = record(
      await reports.findOne({
        _id: reportId,
        organizationId: objectId(actor.organizationId),
        projectId: objectId(actor.projectId),
      }),
    );
    const resolvedScope: WorkReportScope =
      expectedScope ??
      (text(existingReport?.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER');
    this.assertCanAuthorScope(actor, resolvedScope);
    if (!existingReport) throw reportNotFound();
    if (headers) {
      this.assertIfMatch(headers, existingReport.updatedAt);
    }
    // SEC-AUTH-015: Validate every attached documentId belongs to the SAME
    // (organizationId, projectId) — reject cross-tenant/cross-project foreign IDs.
    if (input.documentIds && input.documentIds.length > 0) {
      const uniqueDocIds = Array.from(
        new Set(input.documentIds.map((id) => id.trim()).filter(Boolean)),
      );
      if (uniqueDocIds.some((id) => !validId(id))) {
        throw new BadRequestException({
          code: 'INVALID_DOCUMENT_REFERENCE',
          message: 'One or more attached document references are invalid.',
        });
      }
      const existingCount = await this.database()
        .collection('project_documents')
        .countDocuments({
          _id: { $in: uniqueDocIds.map(objectId) },
          organizationId: objectId(actor.organizationId),
          projectId: objectId(actor.projectId),
        });
      if (existingCount !== uniqueDocIds.length) {
        throw new BadRequestException({
          code: 'INVALID_DOCUMENT_REFERENCE',
          message:
            'One or more attached Project Documents do not belong to this project.',
        });
      }
    }
    const isFreeformInput = 'content' in input;
    if (existingReport.contentSchemaVersion === 2 && !isFreeformInput)
      throw conflict(
        'NOTE_EDITOR_UPGRADE_REQUIRED: use the freeform editor to preserve canonical content.',
      );
    const now = new Date();
    await this.transaction(async (db, session) => {
      const txReports = db.collection('work_reports');
      const update = await txReports.updateOne(
        {
          _id: reportId,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(actor.projectId),
          memberUserId: objectId(actor.userId),
          ...(isFreeformInput ? {} : { contentSchemaVersion: { $ne: 2 } }),
          status: { $in: ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'] },
        },
        {
          $set: isFreeformInput
            ? {
                title: input.title,
                contentMarkdown: input.content,
                accomplishments: '',
                approach: '',
                reason: '',
                blockers: '',
                nextSteps: '',
                ...(input.documentIds !== undefined
                  ? { documentIds: input.documentIds }
                  : {}),
                updatedAt: now,
              }
            : {
                title: '',
                contentMarkdown: '',
                accomplishments: input.accomplishments,
                approach: input.approach,
                reason: input.reason,
                blockers: input.blockers ?? '',
                nextSteps: input.nextSteps ?? '',
                ...(input.documentIds !== undefined
                  ? { documentIds: input.documentIds }
                  : {}),
                updatedAt: now,
              },
          ...(isFreeformInput && existingReport.contentSchemaVersion === 2
            ? { $inc: { currentVersionNumber: 1 } }
            : {}),
        },
        { session },
      );
      if (update.matchedCount !== 1) {
        const exists = await txReports.findOne(
          {
            _id: reportId,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(actor.projectId),
          },
          { session },
        );
        if (!exists) throw reportNotFound();
        if (exists.contentSchemaVersion === 2 && !isFreeformInput)
          throw conflict(
            'NOTE_EDITOR_UPGRADE_REQUIRED: use the freeform editor to preserve canonical content.',
          );
        throw conflict('Only your unsubmitted Work Report can be edited.');
      }
      await this.auditEvent(
        actor,
        'REPORT_DRAFT_SAVED',
        'WORK_REPORT',
        String(reportId),
        undefined,
        session,
      );
    });
    const row = await reports.findOne({ _id: reportId });
    if (!row) throw reportNotFound();
    return this.workReportRecord(row, actor);
  }

  private assertCanAuthorScope(
    actor: WorkNotesActor,
    scope: WorkReportScope,
  ): void {
    if (scope === 'LEADER') {
      if (!isActorLeader(actor)) {
        throw new ForbiddenException({
          code: 'WORK_REPORT_LEADER_ONLY',
          message: 'Only Project Leaders can author a Leader Work Report.',
        });
      }
      return;
    }
    if (!isActorPureMember(actor)) {
      throw new ForbiddenException({
        code: 'WORK_REPORT_MEMBER_ONLY',
        message:
          'Project Leaders and Managers are excluded from member Work Report obligations.',
      });
    }
  }

  private canManageLeaderTier(actor: WorkNotesActor): boolean {
    return isActorManager(actor);
  }

  private canReviewMemberTier(actor: WorkNotesActor): boolean {
    return isActorLeader(actor) || isActorManager(actor);
  }

  private canManageMemberTier(
    actor: WorkNotesActor,
    hasActiveLeaders = true,
  ): boolean {
    return isActorLeader(actor) || (isActorManager(actor) && !hasActiveLeaders);
  }

  private canViewWorkReportRow(
    actor: WorkNotesActor,
    row: Record<string, unknown>,
  ): boolean {
    const reportScope: WorkReportScope =
      text(row.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
    const isOwner =
      String(row.memberUserId).toLowerCase() === actor.userId.toLowerCase();
    if (reportScope === 'LEADER') {
      return isActorManager(actor) || (isActorLeader(actor) && isOwner);
    }
    return isActorLeader(actor) || isActorManager(actor) || isOwner;
  }

  private async resolveHasActiveLeaders(
    actor: WorkNotesActor,
    headers: CaptureRequestHeaders,
  ): Promise<boolean> {
    if (isActorLeader(actor)) return true;
    if (!isActorManager(actor)) return true;
    if (typeof this.authorization.listActiveLeaders === 'function') {
      const leaders = await this.authorization.listActiveLeaders(
        actor,
        headers,
      );
      return leaders.length > 0;
    }
    if (this.reportRoster) {
      const leaderIds = await this.reportRoster.listActiveProjectLeaderIds(
        actor.organizationId,
        actor.projectId,
      );
      return leaderIds.length > 0;
    }
    return true;
  }

  private async resolveProjectLeaderRecipientIds(
    organizationId: string,
    projectId: string,
  ): Promise<string[]> {
    if (!this.reportRoster) return [];
    try {
      return await this.reportRoster.listActiveProjectLeaderIds(
        organizationId,
        projectId,
      );
    } catch {
      return [];
    }
  }

  private async resolveOrganizationManagerRecipientIds(
    organizationId: string,
  ): Promise<string[]> {
    if (!this.reportRoster) return [];
    try {
      return await this.reportRoster.listActiveOrganizationManagerIds(
        organizationId,
      );
    } catch {
      return [];
    }
  }

  private async queryWorkReportsPage(params: {
    collection: ReturnType<Db['collection']>;
    actor: WorkNotesActor;
    scope: WorkReportScope;
    scopeRows: MongoRecord[];
    rosterPeople: Array<{ userId: string; fullName: string; joinedAt: string }>;
    allDirectoryPeople: Array<{
      userId: string;
      fullName: string;
      joinedAt: string;
    }>;
    canViewAllInScope: boolean;
    hasActiveLeaders: boolean;
    baseVisibilityFilter: Record<string, unknown>;
    page: number;
    pageSize: number;
    status?: WorkReportStatus;
    filters?: WorkReportsListFilters;
    now: Date;
  }): Promise<WorkReportsPageRecord> {
    const {
      collection,
      actor,
      scope,
      scopeRows,
      rosterPeople,
      allDirectoryPeople,
      canViewAllInScope,
      hasActiveLeaders,
      baseVisibilityFilter,
      page,
      pageSize,
      status,
      filters,
      now,
    } = params;

    const currentActiveSetting = this.activeSetting(scopeRows, now);
    const currentFrequency = (text(currentActiveSetting.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const currentEffectiveAt =
      currentActiveSetting.effectiveAt instanceof Date
        ? currentActiveSetting.effectiveAt
        : new Date(String(currentActiveSetting.effectiveAt));
    const currentPeriodDates = calculateReportPeriod(
      currentEffectiveAt,
      currentFrequency,
      now,
    );
    const currentPeriod = {
      periodStart: currentPeriodDates.periodStart.toISOString(),
      periodEnd: currentPeriodDates.periodEnd.toISOString(),
      dueAt: currentPeriodDates.periodEnd.toISOString(),
      frequency: currentFrequency,
    };

    const periodFilter =
      filters?.period === 'CURRENT'
        ? { periodStart: currentPeriodDates.periodStart }
        : {};

    const summaryMatchFilter: Record<string, unknown> = {
      ...baseVisibilityFilter,
      ...periodFilter,
    };

    const queryConditions: Record<string, unknown>[] = [
      baseVisibilityFilter,
      ...(filters?.period === 'CURRENT'
        ? [{ periodStart: currentPeriodDates.periodStart }]
        : []),
      ...(status ? [{ status }] : []),
    ];

    if (filters?.memberId) {
      if (
        !canViewAllInScope &&
        filters.memberId.toLowerCase() !== actor.userId.toLowerCase()
      ) {
        queryConditions.push({
          memberUserId: new Types.ObjectId('000000000000000000000000'),
        });
      } else {
        queryConditions.push({ memberUserId: objectId(filters.memberId) });
      }
    }

    if (filters?.search) {
      const escaped = escapeRegex(filters.search);
      const regex = new RegExp(escaped, 'i');
      const matchingPeopleIds = allDirectoryPeople
        .filter((person) => regex.test(person.fullName))
        .map((person) => person.userId)
        .filter(validId)
        .map(objectId);
      queryConditions.push({
        $or: [
          { title: regex },
          { contentMarkdown: regex },
          { accomplishments: regex },
          { approach: regex },
          { reason: regex },
          { blockers: regex },
          { nextSteps: regex },
          { reviewComment: regex },
          ...(matchingPeopleIds.length > 0
            ? [{ memberUserId: { $in: matchingPeopleIds } }]
            : []),
        ],
      });
    }

    const finalFilter: Record<string, unknown> =
      queryConditions.length === 1
        ? queryConditions[0]
        : { $and: queryConditions };

    const [rows, totalItems, statusBuckets, currentPeriodRows] =
      await Promise.all([
        collection
          .find(finalFilter)
          .sort({ periodStart: -1, memberUserId: 1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray(),
        collection.countDocuments(finalFilter),
        collection
          .aggregate<{ _id: string; count: number }>([
            { $match: summaryMatchFilter },
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .toArray(),
        collection
          .find({
            ...baseVisibilityFilter,
            periodStart: currentPeriodDates.periodStart,
          })
          .toArray(),
      ]);

    const summary: WorkReportSummaryCounts = {
      total: 0,
      draft: 0,
      pendingReview: 0,
      changesRequested: 0,
      approved: 0,
      rejected: 0,
      overdue: 0,
    };
    for (const bucket of statusBuckets) {
      const count = Number(bucket.count) || 0;
      summary.total += count;
      switch (bucket._id) {
        case 'DRAFT':
          summary.draft = count;
          break;
        case 'PENDING_REVIEW':
          summary.pendingReview = count;
          break;
        case 'CHANGES_REQUESTED':
          summary.changesRequested = count;
          break;
        case 'APPROVED':
          summary.approved = count;
          break;
        case 'REJECTED':
          summary.rejected = count;
          break;
        case 'OVERDUE':
          summary.overdue = count;
          break;
        default:
          break;
      }
    }

    const currentReportByUserId = new Map<string, Record<string, unknown>>();
    for (const currentRow of currentPeriodRows) {
      const item = currentRow as unknown as Record<string, unknown>;
      currentReportByUserId.set(String(item.memberUserId).toLowerCase(), item);
    }

    const mappedData = rows.map((row) => {
      const authorId = String(row.memberUserId).toLowerCase();
      const authorName = allDirectoryPeople.find(
        (person) => person.userId.toLowerCase() === authorId,
      )?.fullName;
      return this.workReportRecord(row, actor, authorName, hasActiveLeaders);
    });
    // BE-PERF-001: Serve persisted knowledgeSync on list GET (no 12 synchronous live SAG HTTP calls).
    const enrichedData = await this.attachWorkReportStorageReferences(
      actor.organizationId,
      actor.projectId,
      rows,
      mappedData,
    );
    const refreshedSyncByReportId = new Map<
      string,
      DocumentKnowledgeStatusRecord
    >();
    for (const item of enrichedData) {
      if (item.knowledgeSync) {
        refreshedSyncByReportId.set(item.id, item.knowledgeSync);
      }
    }

    const roster: WorkReportRosterEntry[] = rosterPeople.map((person) => {
      const currentReport = currentReportByUserId.get(
        person.userId.toLowerCase(),
      );
      const reportStatus = currentReport
        ? (text(currentReport.status) as WorkReportStatus)
        : 'NOT_STARTED';
      const reportIdStr = currentReport ? String(currentReport._id) : undefined;
      let compactSync: WorkReportRosterEntry['knowledgeSync'] | undefined;
      if (currentReport && reportStatus === 'APPROVED' && reportIdStr) {
        const currentVer = Math.max(
          1,
          Number(currentReport.currentVersionNumber ?? 1),
        );
        const rawProv =
          currentReport.provenance &&
          typeof currentReport.provenance === 'object' &&
          !Array.isArray(currentReport.provenance)
            ? (currentReport.provenance as Record<string, unknown>)
            : undefined;
        const fullSync =
          refreshedSyncByReportId.get(reportIdStr) ??
          normalizeKnowledgeSyncForVersion(rawProv?.knowledgeSync, currentVer);
        if (fullSync) {
          compactSync = {
            status: fullSync.status,
            searchStatus: fullSync.searchStatus,
            searchReady: fullSync.searchReady,
            knowledgeReady: fullSync.knowledgeReady,
            progress: fullSync.progress,
            currentStage: fullSync.currentStage ?? null,
          };
        }
      }
      return {
        userId: person.userId,
        fullName: person.fullName,
        joinedAt: person.joinedAt,
        ...(reportIdStr ? { reportId: reportIdStr } : {}),
        status: reportStatus,
        dueAt: iso(currentReport?.dueAt) ?? currentPeriod.dueAt,
        ...(iso(currentReport?.submittedAt)
          ? { submittedAt: iso(currentReport?.submittedAt) }
          : {}),
        ...(iso(currentReport?.reviewedAt)
          ? { reviewedAt: iso(currentReport?.reviewedAt) }
          : {}),
        ...(compactSync ? { knowledgeSync: compactSync } : {}),
      };
    });

    return {
      data: enrichedData,
      pagination: this.pagination(page, pageSize, totalItems),
      scope,
      summary,
      currentPeriod,
      roster,
    };
  }

  private async scopedSettingsTimelines(actor: WorkNotesActor): Promise<{
    memberRows: MongoRecord[];
    leaderRows: MongoRecord[];
    hasExplicitLeaderRows: boolean;
  }> {
    const collection = this.database().collection('work_report_settings');
    const filter = {
      organizationId: objectId(actor.organizationId),
      projectId: objectId(actor.projectId),
    };
    let rows: MongoRecord[] = await collection
      .find(filter)
      .sort({ effectiveAt: 1, _id: 1 })
      .toArray();

    if (rows.length === 0) {
      const now = new Date();
      const effectiveAt = startOfUtcWeek(now);
      const actorObjectId = validId(actor.userId)
        ? objectId(actor.userId)
        : new Types.ObjectId();
      const defaultMemberSetting = {
        _id: new Types.ObjectId(),
        ...filter,
        reportScope: 'MEMBER' as const,
        frequency: 'WEEKLY' as const,
        effectiveAt,
        createdByUserId: actorObjectId,
        updatedByUserId: actorObjectId,
        history: [
          {
            frequency: 'WEEKLY' as const,
            effectiveAt,
            updatedByUserId: actorObjectId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const defaultLeaderSetting = {
        _id: new Types.ObjectId(),
        ...filter,
        reportScope: 'LEADER' as const,
        frequency: 'WEEKLY' as const,
        effectiveAt,
        createdByUserId: actorObjectId,
        updatedByUserId: actorObjectId,
        history: [
          {
            frequency: 'WEEKLY' as const,
            effectiveAt,
            updatedByUserId: actorObjectId,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      for (const candidate of [defaultMemberSetting, defaultLeaderSetting]) {
        try {
          await collection.insertOne(candidate);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 11000
          ) {
            throw error;
          }
        }
      }
      rows = await collection
        .find(filter)
        .sort({ effectiveAt: 1, _id: 1 })
        .toArray();
    }

    const memberRows = rows.filter((row) => text(row.reportScope) !== 'LEADER');
    const explicitLeaderRows = rows.filter(
      (row) => text(row.reportScope) === 'LEADER',
    );
    if (explicitLeaderRows.length > 0) {
      return {
        memberRows:
          memberRows.length > 0 ? memberRows : [explicitLeaderRows[0]],
        leaderRows: explicitLeaderRows,
        hasExplicitLeaderRows: true,
      };
    }

    const legacyLeaderRows = this.legacyLeaderSettingsTimeline(
      memberRows,
      actor.userId,
    );
    return {
      memberRows,
      leaderRows: legacyLeaderRows,
      hasExplicitLeaderRows: false,
    };
  }

  private legacyLeaderSettingsTimeline(
    memberSettings: MongoRecord[],
    fallbackUserId: string,
  ): MongoRecord[] {
    const root = memberSettings[0];
    if (!root) return [];
    const frequency = (text(root.leaderFrequency) ||
      'WEEKLY') as WorkReportFrequency;
    const effectiveAt =
      root.leaderEffectiveAt instanceof Date
        ? root.leaderEffectiveAt
        : new Date(String(root.leaderEffectiveAt ?? root.effectiveAt));
    const updatedBy =
      idText(root.leaderUpdatedByUserId ?? root.createdByUserId) ||
      fallbackUserId;
    const history = Array.isArray(root.leaderHistory)
      ? (root.leaderHistory as Array<Record<string, unknown>>)
      : [{ frequency, effectiveAt, updatedBy }];
    return history.map((entry) => ({
      _id: root._id,
      organizationId: root.organizationId,
      projectId: root.projectId,
      reportScope: 'LEADER',
      frequency: text(entry.frequency) || frequency,
      effectiveAt:
        entry.effectiveAt instanceof Date
          ? entry.effectiveAt
          : new Date(String(entry.effectiveAt)),
      createdByUserId: entry.updatedByUserId ?? entry.updatedBy ?? updatedBy,
      updatedByUserId: entry.updatedByUserId ?? entry.updatedBy ?? updatedBy,
    }));
  }

  private extractSettingRowHistory(
    row: MongoRecord,
    defaultEffectiveAt: Date,
    fallbackUserId: string,
  ): Array<{
    frequency: WorkReportFrequency;
    effectiveAt: string;
    updatedBy: string;
  }> {
    const rowFrequency = (text(row.frequency) ||
      'WEEKLY') as WorkReportFrequency;
    const rowUpdatedBy =
      idText(row.updatedByUserId ?? row.createdByUserId) || fallbackUserId;
    if (Array.isArray(row.history) && row.history.length > 0) {
      return (row.history as Array<Record<string, unknown>>).map((entry) => ({
        frequency: (text(entry.frequency) ||
          rowFrequency) as WorkReportFrequency,
        effectiveAt: iso(entry.effectiveAt) ?? defaultEffectiveAt.toISOString(),
        updatedBy:
          idText(entry.updatedByUserId ?? entry.updatedBy) || rowUpdatedBy,
      }));
    }
    return [
      {
        frequency: rowFrequency,
        effectiveAt: iso(row.effectiveAt) ?? defaultEffectiveAt.toISOString(),
        updatedBy: rowUpdatedBy,
      },
    ];
  }

  private buildTierSettingsSummary(
    rows: MongoRecord[],
    actor: WorkNotesActor,
    now: Date,
    permissions: {
      canConfigure: boolean;
      canReview: boolean;
      canSubmit: boolean;
    },
  ): WorkReportTierSettingsSummary {
    const active = this.activeSetting(rows, now);
    const next = rows.find(
      (item) => new Date(String(item.effectiveAt)).getTime() > now.getTime(),
    );
    const activeEffectiveAt =
      active.effectiveAt instanceof Date
        ? active.effectiveAt
        : new Date(String(active.effectiveAt));
    const history = rows.flatMap((item) => {
      const itemEffectiveAt =
        item.effectiveAt instanceof Date
          ? item.effectiveAt
          : new Date(String(item.effectiveAt));
      return this.extractSettingRowHistory(item, itemEffectiveAt, actor.userId);
    });
    const latestHistoryEntry = history.at(-1);
    const updatedBy =
      latestHistoryEntry?.updatedBy ||
      idText(active.updatedByUserId ?? active.createdByUserId) ||
      actor.userId;

    return {
      frequency: (text(active.frequency) || 'WEEKLY') as WorkReportFrequency,
      effectiveAt: iso(active.effectiveAt) ?? activeEffectiveAt.toISOString(),
      ...(next
        ? {
            nextFrequency: text(next.frequency) as WorkReportFrequency,
            nextEffectiveAt: iso(next.effectiveAt),
          }
        : {}),
      updatedBy,
      history,
      permissions,
    };
  }

  private activeSetting(settings: MongoRecord[], now: Date): MongoRecord {
    const active = settings
      .filter(
        (item) => new Date(String(item.effectiveAt)).getTime() <= now.getTime(),
      )
      .at(-1);
    if (active) return active;
    if (settings[0]) return settings[0];
    throw new ServiceUnavailableException({
      code: 'WORK_REPORT_SETTINGS_UNAVAILABLE',
      message: 'Work Report settings are unavailable.',
    });
  }

  private settingsRecord(
    timelines: {
      memberRows: MongoRecord[];
      leaderRows: MongoRecord[];
    },
    actor: WorkNotesActor,
    now: Date,
    scope: WorkReportScope = 'MEMBER',
    hasActiveLeaders = true,
  ): WorkReportSettingsRecord {
    const isManager = isActorManager(actor);
    const isLeader = isActorLeader(actor);
    const isPureMember = isActorPureMember(actor);
    const actorRole: 'MANAGER' | 'LEADER' | 'MEMBER' = isManager
      ? 'MANAGER'
      : isLeader
        ? 'LEADER'
        : 'MEMBER';

    const memberCanManage = this.canManageMemberTier(actor, hasActiveLeaders);
    const leaderCanManage = this.canManageLeaderTier(actor);

    const memberSummary = this.buildTierSettingsSummary(
      timelines.memberRows,
      actor,
      now,
      {
        canConfigure: memberCanManage,
        canReview: memberCanManage,
        canSubmit: isPureMember,
      },
    );
    const leaderSummary = this.buildTierSettingsSummary(
      timelines.leaderRows,
      actor,
      now,
      {
        canConfigure: leaderCanManage,
        canReview: leaderCanManage,
        canSubmit: isLeader,
      },
    );

    const activeTier = scope === 'LEADER' ? leaderSummary : memberSummary;
    return {
      projectId: actor.projectId,
      scope,
      actorRole,
      isManager,
      isLeader,
      hasActiveLeaders,
      reminderLeadMinutes:
        (timelines.memberRows[0]?.[
          scope === 'LEADER'
            ? 'leaderReminderLeadMinutes'
            : 'memberReminderLeadMinutes'
        ] as number | null | undefined) ?? null,
      frequency: activeTier.frequency,
      effectiveAt: activeTier.effectiveAt,
      ...(activeTier.nextFrequency
        ? {
            nextFrequency: activeTier.nextFrequency,
            nextEffectiveAt: activeTier.nextEffectiveAt,
          }
        : {}),
      updatedBy: activeTier.updatedBy,
      history: activeTier.history,
      permissions: activeTier.permissions,
      memberSettings: memberSummary,
      ...(!isPureMember ? { leaderSettings: leaderSummary } : {}),
    };
  }

  private async ensureReportObligations(
    actor: WorkNotesActor,
    members: Array<{ userId: string; joinedAt: string }>,
    settings: MongoRecord[],
    now: Date,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<void> {
    const reports = this.database().collection('work_reports');
    const operations: Array<{
      updateOne: {
        filter: Record<string, unknown>;
        update: { $setOnInsert: Record<string, unknown> };
        upsert: true;
      };
    }> = [];
    const currentPeriodNotifications: Array<{
      memberId: string;
      frequency: WorkReportFrequency;
      periodStart: Date;
      dueAt: Date;
    }> = [];
    const maxPeriodsPerMember = 20_000;
    const periodStartByUser = new Map<string, number>();

    for (let index = 0; index < settings.length; index += 1) {
      const setting = settings[index];
      const segmentStart =
        setting.effectiveAt instanceof Date
          ? setting.effectiveAt
          : new Date(String(setting.effectiveAt));
      const nextSetting = settings[index + 1];
      const segmentEnd = nextSetting
        ? nextSetting.effectiveAt instanceof Date
          ? nextSetting.effectiveAt
          : new Date(String(nextSetting.effectiveAt))
        : undefined;
      if (segmentStart.getTime() > now.getTime()) continue;

      const frequency = text(setting.frequency) as WorkReportFrequency;
      const periodLengthMs = getFrequencyDays(frequency) * 24 * 60 * 60 * 1000;
      let periodStart = segmentStart;
      while (
        periodStart.getTime() <= now.getTime() &&
        (!segmentEnd || periodStart.getTime() < segmentEnd.getTime())
      ) {
        const calculated = calculateReportPeriod(
          segmentStart,
          frequency,
          periodStart,
        );
        const start = calculated.periodStart;
        let end = calculated.periodEnd;
        if (segmentEnd && end.getTime() > segmentEnd.getTime())
          end = segmentEnd;
        if (end.getTime() <= start.getTime()) break;
        const isCurrentPeriod =
          start.getTime() <= now.getTime() && end.getTime() > now.getTime();
        for (const member of members) {
          const memberId = member.userId;
          if (!validId(memberId)) continue;
          const joinedAt = new Date(member.joinedAt);
          if (
            !Number.isFinite(joinedAt.getTime()) ||
            joinedAt.getTime() >= end.getTime()
          )
            continue;
          const count = (periodStartByUser.get(memberId) ?? 0) + 1;
          if (count > maxPeriodsPerMember) {
            throw new ServiceUnavailableException({
              code: 'WORK_REPORT_HISTORY_TOO_LARGE',
              message: 'Work Report periods need administrative catch-up.',
            });
          }
          periodStartByUser.set(memberId, count);
          const projectObjectId = objectId(actor.projectId);
          const memberObjectId = objectId(memberId);
          const id = new Types.ObjectId();
          operations.push({
            updateOne: {
              filter: {
                projectId: projectObjectId,
                memberUserId: memberObjectId,
                reportScope: scope,
                periodStart: start,
              },
              update: {
                $setOnInsert: {
                  _id: id,
                  organizationId: objectId(actor.organizationId),
                  projectId: projectObjectId,
                  memberUserId: memberObjectId,
                  reportScope: scope,
                  frequency,
                  periodStart: start,
                  periodEnd: end,
                  dueAt: end,
                  accomplishments: '',
                  approach: '',
                  reason: '',
                  blockers: '',
                  nextSteps: '',
                  documentIds: [],
                  status: 'DRAFT',
                  reviewHistory: [],
                  createdAt: now,
                  updatedAt: now,
                },
              },
              upsert: true,
            },
          });
          if (isCurrentPeriod) {
            currentPeriodNotifications.push({
              memberId,
              frequency,
              periodStart: start,
              dueAt: end,
            });
          }
        }
        periodStart = new Date(periodStart.getTime() + periodLengthMs);
      }
    }

    let upsertedCount = 0;
    for (let offset = 0; offset < operations.length; offset += 500) {
      const batch = operations.slice(offset, offset + 500);
      try {
        const result = await reports.bulkWrite(batch, { ordered: false });
        upsertedCount += result.upsertedCount ?? 0;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          error.code !== 11000
        )
          throw error;
      }
    }

    if (
      upsertedCount > 0 &&
      this.notifications &&
      currentPeriodNotifications.length > 0
    ) {
      for (const item of currentPeriodNotifications) {
        const days = getFrequencyDays(item.frequency);
        const dueDateLabel = item.dueAt.toISOString().slice(0, 10);
        await this.notifications.emitSafe({
          type: 'TASK_DEADLINE_APPROACHING',
          actorId: null,
          recipients: [item.memberId],
          title:
            scope === 'LEADER'
              ? 'Leader work report due to Manager'
              : 'Periodic work report due',
          message:
            scope === 'LEADER'
              ? `Your Leader report (every ${days} ${days === 1 ? 'day' : 'days'}) is due by ${dueDateLabel}.`
              : `Your periodic work report (every ${days} ${days === 1 ? 'day' : 'days'}) is due by ${dueDateLabel}.`,
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          target: {
            kind: 'PROJECT',
            url: `/projects/${actor.projectId}/work-reports`,
            organizationId: actor.organizationId,
            projectId: actor.projectId,
          },
          eventKey: `work-report-due:${actor.projectId}:${scope}:${item.memberId}:${item.periodStart.toISOString()}`,
        });
      }
    }
  }

  private workReportRecord(
    row: Document,
    actor: WorkNotesActor,
    resolvedMemberName?: string,
    hasActiveLeaders = true,
  ): WorkReportRecord {
    const value = row as unknown as Record<string, unknown>;
    const memberId = String(value.memberUserId);
    const status = text(value.status) as WorkReportStatus;
    const reportScope: WorkReportScope =
      text(value.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER';
    const isOwner = memberId.toLowerCase() === actor.userId.toLowerCase();
    const canAuthorReport =
      reportScope === 'LEADER'
        ? isActorLeader(actor)
        : isActorPureMember(actor);
    const canReviewScope =
      reportScope === 'LEADER'
        ? this.canManageLeaderTier(actor)
        : this.canReviewMemberTier(actor);
    const canManageScope =
      reportScope === 'LEADER'
        ? this.canManageLeaderTier(actor)
        : this.canManageMemberTier(actor, hasActiveLeaders);
    const canReviewReport =
      canReviewScope && !isOwner && status === 'PENDING_REVIEW';
    const canConfigureReport = canManageScope;

    return {
      id: String(value._id),
      projectId: String(value.projectId),
      memberId,
      memberName: isOwner ? actor.userName : resolvedMemberName || memberId,
      reportScope,
      frequency: text(value.frequency) as WorkReportFrequency,
      periodStart: iso(value.periodStart) ?? '',
      periodEnd: iso(value.periodEnd) ?? '',
      dueAt: iso(value.dueAt) ?? '',
      status,
      accomplishments: text(value.accomplishments),
      ...(value.contentSchemaVersion === 2
        ? {
            title: text(value.title),
            contentMarkdown: text(value.contentMarkdown),
            contentSchemaVersion: 2 as const,
            currentVersionNumber: Number(value.currentVersionNumber),
          }
        : {
            ...(typeof value.title === 'string' && value.title.length > 0
              ? { title: value.title }
              : {}),
            ...(typeof value.contentMarkdown === 'string' &&
            value.contentMarkdown.length > 0
              ? {
                  content: value.contentMarkdown,
                  contentMarkdown: value.contentMarkdown,
                }
              : {}),
          }),
      approach: text(value.approach),
      reason: text(value.reason),
      blockers: text(value.blockers),
      nextSteps: text(value.nextSteps),
      ...(Array.isArray(value.documentIds)
        ? {
            documentIds: (value.documentIds as unknown[])
              .filter((id): id is string => typeof id === 'string')
              .map((id) => id.trim()),
          }
        : {}),
      ...(value.file && typeof value.file === 'object'
        ? (() => {
            const rawProv =
              value.provenance &&
              typeof value.provenance === 'object' &&
              !Array.isArray(value.provenance)
                ? (value.provenance as Record<string, unknown>)
                : undefined;
            const fileSha256 =
              typeof rawProv?.fileSha256 === 'string' &&
              rawProv.fileSha256.length > 0
                ? rawProv.fileSha256
                : undefined;
            return {
              file: {
                name: text((value.file as Record<string, unknown>).name),
                contentType: text(
                  (value.file as Record<string, unknown>).contentType,
                ),
                size: Number((value.file as Record<string, unknown>).size),
                ...(fileSha256 ? { sha256: fileSha256 } : {}),
              },
            };
          })()
        : {}),
      ...(status === 'APPROVED'
        ? (() => {
            const rawProv =
              value.provenance &&
              typeof value.provenance === 'object' &&
              !Array.isArray(value.provenance)
                ? (value.provenance as Record<string, unknown>)
                : undefined;
            const reportVersion = Math.max(
              1,
              Number(value.currentVersionNumber ?? 1),
            );
            const normalizedSync = normalizeKnowledgeSyncForVersion(
              rawProv?.knowledgeSync,
              reportVersion,
            );
            return normalizedSync ? { knowledgeSync: normalizedSync } : {};
          })()
        : {}),
      createdAt: iso(value.createdAt) ?? '',
      updatedAt: iso(value.updatedAt) ?? '',
      ...(iso(value.submittedAt)
        ? { submittedAt: iso(value.submittedAt) }
        : {}),
      ...(value.reviewedByUserId
        ? {
            reviewedBy: idText(value.reviewedByUserId),
            ...(typeof value.reviewedByName === 'string' &&
            value.reviewedByName.trim()
              ? { reviewerName: value.reviewedByName.trim() }
              : idText(value.reviewedByUserId).toLowerCase() ===
                    actor.userId.toLowerCase() && actor.userName
                ? { reviewerName: actor.userName }
                : {}),
          }
        : {}),
      ...(iso(value.reviewedAt) ? { reviewedAt: iso(value.reviewedAt) } : {}),
      ...(typeof value.reviewComment === 'string'
        ? { reviewComment: value.reviewComment }
        : {}),
      reviewHistory: pickReviewHistory(value.reviewHistory),
      permissions: {
        canCreate: canAuthorReport,
        canEdit:
          canAuthorReport &&
          isOwner &&
          ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canSubmit:
          canAuthorReport &&
          isOwner &&
          ['DRAFT', 'OVERDUE', 'CHANGES_REQUESTED'].includes(status),
        canReview: canReviewReport,
        canConfigure: canConfigureReport,
        canControlKnowledge:
          status === 'APPROVED'
            ? canManageScope || isOwner
            : Boolean(canManageScope || actor.canReview),
        canPurgeArtifact: canManageScope || (isOwner && status !== 'APPROVED'),
      },
    };
  }

  private resolveActorMemberObligation(actor: WorkNotesActor): {
    userId: string;
    fullName: string;
    joinedAt: string;
  } {
    if (!actor.joinedAt || !Number.isFinite(Date.parse(actor.joinedAt))) {
      throw new ServiceUnavailableException({
        code: 'PROJECT_MEMBERS_UNAVAILABLE',
        message: 'Active Project member join date is unavailable.',
      });
    }
    return {
      userId: actor.userId,
      fullName: actor.userName,
      joinedAt: actor.joinedAt,
    };
  }

  private async markOverdue(
    actor: WorkNotesActor,
    projectId: string,
    now: Date,
    activeMemberIds?: ReadonlySet<string>,
    scope: WorkReportScope = 'MEMBER',
  ): Promise<void> {
    if (activeMemberIds && activeMemberIds.size === 0) return;
    const allowedMemberObjectIds = activeMemberIds
      ? [...activeMemberIds].filter(validId).map(objectId)
      : undefined;
    const candidates = await this.database()
      .collection('work_reports')
      .find({
        organizationId: objectId(actor.organizationId),
        projectId: objectId(projectId),
        ...(scope === 'LEADER'
          ? { reportScope: 'LEADER' }
          : {
              $or: [
                { reportScope: 'MEMBER' },
                { reportScope: { $exists: false } },
              ],
            }),
        ...(allowedMemberObjectIds
          ? { memberUserId: { $in: allowedMemberObjectIds } }
          : {}),
        status: 'DRAFT',
        dueAt: { $lte: now },
      })
      .limit(500)
      .toArray();
    for (const candidate of candidates) {
      const item = candidate as unknown as Record<string, unknown>;
      const id = objectId(String(item._id));
      let didTransition = false;
      await this.transaction(async (db, session) => {
        const update = await db
          .collection('work_reports')
          .updateOne(
            { _id: id, status: 'DRAFT', dueAt: { $lte: now } },
            { $set: { status: 'OVERDUE', updatedAt: now } },
            { session },
          );
        if (update.modifiedCount !== 1) return;
        didTransition = true;
        const commonPayload = {
          organizationId: actor.organizationId,
          projectId,
          memberId: String(item.memberUserId),
          scope,
          periodStart: iso(item.periodStart),
          periodEnd: iso(item.periodEnd),
          dueAt: iso(item.dueAt),
        };
        await this.appendOutbox(
          {
            eventName: 'WORK_REPORT_DUE',
            aggregateType: 'WORK_REPORT',
            aggregateId: String(id),
            payload: commonPayload,
          },
          session,
        );
        await this.appendOutbox(
          {
            eventName: 'WORK_REPORT_OVERDUE',
            aggregateType: 'WORK_REPORT',
            aggregateId: String(id),
            payload: commonPayload,
          },
          session,
        );
      });
      if (didTransition && this.notifications) {
        await this.notifications.emitSafe({
          type: 'WORK_REPORT_OVERDUE',
          actorId: null,
          recipients: [String(item.memberUserId)],
          title:
            scope === 'LEADER'
              ? 'Leader work report overdue'
              : 'Work report overdue',
          message:
            'Your periodic work report has passed its due date. Please complete and submit your report.',
          organizationId: actor.organizationId,
          projectId,
          target: {
            kind: 'PROJECT',
            url: `/projects/${projectId}/work-reports`,
            organizationId: actor.organizationId,
            projectId,
          },
          eventKey: `work-report-overdue:${String(id)}`,
        });
      }
    }
  }

  private taskNoteRecord(row: Document, actor: WorkNotesActor): TaskNoteRecord {
    const value = row as unknown as Record<string, unknown>;
    const provenance =
      value.provenance && typeof value.provenance === 'object'
        ? (value.provenance as Record<string, unknown>)
        : undefined;
    const aiChatSource = serializeAiChatSource(provenance?.aiChatSource);
    const authorId = String(value.authorUserId);
    const reviewObj =
      provenance?.review &&
      typeof provenance.review === 'object' &&
      !Array.isArray(provenance.review)
        ? (provenance.review as Record<string, unknown>)
        : undefined;
    const rawReviewStatus = reviewObj?.status;
    const reviewStatus: TaskNoteReviewStatus =
      rawReviewStatus === 'APPROVED' ||
      rawReviewStatus === 'CHANGES_REQUESTED' ||
      rawReviewStatus === 'REJECTED' ||
      rawReviewStatus === 'PENDING_REVIEW'
        ? rawReviewStatus
        : 'PENDING_REVIEW';
    const versionNumber = Math.max(1, Number(value.currentVersionNumber ?? 1));
    const createdAtIso = iso(value.createdAt) ?? '';
    const submittedAt = text(reviewObj?.submittedAt) || createdAtIso;
    const reviewedBy = text(reviewObj?.reviewedBy) || undefined;
    const reviewerName =
      text(reviewObj?.reviewerName) ||
      (reviewedBy &&
      reviewedBy.toLowerCase() === actor.userId.toLowerCase() &&
      actor.userName
        ? actor.userName
        : undefined);
    const reviewedAt = text(reviewObj?.reviewedAt) || undefined;
    const reviewComment =
      typeof reviewObj?.comment === 'string' ? reviewObj.comment : undefined;
    const reviewHistory = pickReviewHistory(reviewObj?.history);
    const rawMdFile =
      provenance?.mdFile &&
      typeof provenance.mdFile === 'object' &&
      !Array.isArray(provenance.mdFile)
        ? (provenance.mdFile as Record<string, unknown>)
        : undefined;
    const mdFile =
      reviewStatus === 'APPROVED' &&
      rawMdFile &&
      typeof rawMdFile.name === 'string' &&
      (rawMdFile.version === undefined ||
        Number(rawMdFile.version) === versionNumber)
        ? {
            name: text(rawMdFile.name),
            contentType: text(rawMdFile.contentType) || 'text/markdown',
            size: Number(rawMdFile.size ?? 0),
            ...(typeof rawMdFile.sha256 === 'string' && rawMdFile.sha256
              ? { sha256: rawMdFile.sha256 }
              : {}),
          }
        : undefined;
    const knowledgeSync =
      reviewStatus === 'APPROVED'
        ? normalizeKnowledgeSyncForVersion(
            provenance?.knowledgeSync,
            versionNumber,
          )
        : undefined;

    return {
      id: String(value._id),
      projectId: String(value.projectId),
      taskId: String(value.taskId),
      ...(actor.taskKey ? { taskKey: actor.taskKey } : {}),
      ...(actor.taskTitle ? { taskTitle: actor.taskTitle } : {}),
      authorId,
      authorName:
        text(value.authorName) ||
        (authorId === actor.userId ? actor.userName : authorId),
      type: 'TASK_NOTE',
      status: 'CONFIRMED',
      reviewStatus,
      ...(submittedAt ? { submittedAt } : {}),
      ...(reviewedBy ? { reviewedBy } : {}),
      ...(reviewerName ? { reviewerName } : {}),
      ...(reviewedAt ? { reviewedAt } : {}),
      ...(reviewComment !== undefined ? { reviewComment } : {}),
      ...(reviewHistory.length > 0 ? { reviewHistory } : {}),
      ...(mdFile ? { file: mdFile } : {}),
      ...(knowledgeSync ? { knowledgeSync } : {}),
      title: text(value.title),
      ...(typeof value.contentMarkdown === 'string'
        ? {
            contentMarkdown: value.contentMarkdown,
            contentSchemaVersion: 2 as const,
            currentVersionNumber: versionNumber,
          }
        : {}),
      ...(aiChatSource ? { aiChatSource } : {}),
      accomplishments: text(value.whatDone),
      approach: text(value.howSolved),
      reason: text(value.whyThisWay),
      createdAt: createdAtIso,
      updatedAt: iso(value.updatedAt) ?? '',
      permissions: this.taskNotePermissions(actor, authorId, reviewStatus),
    };
  }

  private documentSummary(
    row: Document,
    actor: WorkNotesActor,
  ): ProjectDocumentSummaryRecord {
    const value = row as unknown as Record<string, unknown>;
    const createdBy = String(value.createdByUserId);
    const status = text(value.status) as DocumentStatus;
    const currentVersionNumber = Number(value.currentVersionNumber);
    const normalizedKnowledgeSync = normalizeKnowledgeSyncForVersion(
      value.knowledgeSync,
      currentVersionNumber,
    );
    return {
      id: String(value._id),
      projectId: String(value.projectId),
      title: text(value.title),
      ...(typeof value.description === 'string'
        ? { description: value.description }
        : {}),
      type: text(value.documentType) as ProjectDocumentRecord['type'],
      version: currentVersionNumber,
      status,
      createdBy,
      createdAt: iso(value.createdAt) ?? '',
      updatedAt: iso(value.updatedAt) ?? '',
      ...(normalizedKnowledgeSync
        ? { knowledgeSync: normalizedKnowledgeSync }
        : {}),
      permissions: {
        ...this.permissions(actor, createdBy, status),
        canCreate: !isNonMemberManager(actor),
        canEdit:
          createdBy === actor.userId &&
          ['DRAFT', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED'].includes(
            status,
          ),
        canDelete:
          isActorLeader(actor) ||
          (createdBy === actor.userId &&
            status !== 'APPROVED' &&
            status !== 'ARCHIVED'),
        canSubmit: createdBy === actor.userId && status === 'DRAFT',
      },
    };
  }

  /** Internal editor contract: actor must come from current server Project authority. */
  async editorSourceRecord(
    actor: WorkNotesActor,
    workflow: 'PROJECT_DOCUMENT' | 'WORK_REPORT',
    id: string,
    session?: ClientSession,
  ): Promise<ProjectDocumentRecord | WorkReportRecord> {
    if (!validId(id)) throw documentNotFound();
    if (workflow === 'PROJECT_DOCUMENT') {
      const doc = await this.readDocument(actor, objectId(id), session);
      if (!doc) throw documentNotFound();
      return doc;
    }
    const row = await this.database()
      .collection('work_reports')
      .findOne(
        {
          _id: objectId(id),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(actor.projectId),
          ...(!actor.canReview ? { memberUserId: objectId(actor.userId) } : {}),
        },
        { session },
      );
    if (!row || !this.canViewWorkReportRow(actor, row)) throw reportNotFound();
    return this.workReportRecord(row, actor);
  }
  private async readDocument(
    actor: WorkNotesActor,
    id: Types.ObjectId,
    session?: ClientSession,
  ): Promise<ProjectDocumentRecord | null> {
    const db = this.database();
    const document = record(
      await db.collection('project_documents').findOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(actor.projectId),
        },
        { session },
      ),
    );
    if (!document) return null;
    const [versions, auditRows] = await Promise.all([
      db
        .collection('project_document_versions')
        .find(
          {
            documentId: id,
            organizationId: objectId(actor.organizationId),
            projectId: objectId(actor.projectId),
          },
          { session },
        )
        .sort({ versionNumber: 1 })
        .toArray(),
      typeof this.audit?.listForTarget === 'function'
        ? this.audit
            .listForTarget(
              {
                organizationId: actor.organizationId,
                projectId: actor.projectId,
                targetResource: 'PROJECT_DOCUMENT',
                targetResourceId: String(id),
              },
              150,
            )
            .catch(() => [] as AuditEventRecord[])
        : Promise.resolve([] as AuditEventRecord[]),
    ]);
    const versionRecords = versions.map((item) =>
      this.documentVersion(item as Document),
    );
    const current = versionRecords.find(
      (item) => item.version === Number(document.currentVersionNumber),
    );
    if (!current) throw documentNotFound();
    const summary = this.documentSummary(document, actor);
    const allDocKeys: string[] = [];
    let currentSha256: string | undefined;
    for (const rawVer of versions) {
      const verObj = rawVer as unknown as Record<string, unknown>;
      const rawFile = verObj.file as
        { key?: unknown; sha256?: unknown } | undefined;
      if (typeof rawFile?.key === 'string' && rawFile.key.trim()) {
        allDocKeys.push(rawFile.key.trim());
      }
      if (
        Number(verObj.versionNumber) ===
          Number(document.currentVersionNumber) &&
        typeof rawFile?.sha256 === 'string' &&
        rawFile.sha256.trim()
      ) {
        currentSha256 = rawFile.sha256.trim();
      }
    }
    const storageRefsByDoc = await this.resolveStorageReferencesByDocument(
      actor.organizationId,
      actor.projectId,
      [
        {
          documentId: summary.id,
          keys: allDocKeys,
          ...(currentSha256 ? { currentSha256 } : {}),
        },
      ],
    );
    const storageReference = storageRefsByDoc.get(summary.id);
    const activityHistory = this.buildDocumentActivityHistory(
      summary,
      versionRecords,
      auditRows,
    );
    return {
      ...summary,
      submittedAt: current.submittedAt,
      reviewedBy: current.reviewedBy,
      reviewedAt: current.reviewedAt,
      reviewComment: current.reviewComment,
      content: current.content,
      ...(current.file ? { file: current.file } : {}),
      ...(storageReference ? { storageReference } : {}),
      versions: versionRecords.map(
        ({ version, status, createdAt, editedBy, file }) => ({
          version,
          status,
          createdAt,
          editedBy,
          ...(file ? { file } : {}),
        }),
      ),
      reviewHistory: versionRecords
        .flatMap((item) => item.reviewHistory)
        .sort((left, right) => left.at.localeCompare(right.at)),
      activityHistory,
    };
  }

  private async resolveStorageReferencesByDocument(
    organizationId: string,
    projectId: string,
    entries: Array<{
      documentId: string;
      keys: string[];
      currentSha256?: string;
    }>,
  ): Promise<Map<string, DocumentStorageReferenceRecord>> {
    const result = new Map<string, DocumentStorageReferenceRecord>();
    const uniqueKeys = Array.from(
      new Set(
        entries
          .flatMap((entry) => entry.keys)
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    );
    if (uniqueKeys.length === 0) return result;

    const uniqueKeySet = new Set(uniqueKeys);
    const distinctDocsByKey = new Map<string, Set<string>>();
    for (const key of uniqueKeys) {
      distinctDocsByKey.set(key, new Set<string>());
    }

    // SEC-AUTH-002 / BE-DATA-001: Strictly scope all storage reference lookups
    // by BOTH organizationId AND projectId (eliminates cross-project existence oracle).
    const scopeFilter = {
      organizationId: objectId(organizationId),
      projectId: objectId(projectId),
    };

    try {
      const versionsCol = this.database().collection(
        'project_document_versions',
      );
      if (typeof versionsCol.find === 'function') {
        const cursor = versionsCol.find({
          ...scopeFilter,
          'file.key': { $in: uniqueKeys },
        });
        const rows =
          cursor && typeof cursor.toArray === 'function'
            ? await cursor.toArray()
            : [];
        for (const row of rows) {
          const raw = row as unknown as Record<string, unknown>;
          const rawFile = raw.file as { key?: unknown } | undefined;
          const key =
            typeof rawFile?.key === 'string' ? rawFile.key.trim() : '';
          const docId = idText(raw.documentId);
          if (key && docId && uniqueKeySet.has(key)) {
            distinctDocsByKey.get(key)?.add(docId);
          }
        }
      }
    } catch {
      // Fall back to local document ownership if projection query fails on stubbed collections.
    }

    try {
      const notesCol = this.database().collection('work_notes');
      if (typeof notesCol.find === 'function') {
        const cursor = notesCol.find({
          ...scopeFilter,
          status: 'CONFIRMED',
          'provenance.mdFile.key': { $in: uniqueKeys },
        });
        const rows =
          cursor && typeof cursor.toArray === 'function'
            ? await cursor.toArray()
            : [];
        for (const row of rows) {
          const raw = row as unknown as Record<string, unknown>;
          const rawProv =
            raw.provenance && typeof raw.provenance === 'object'
              ? (raw.provenance as { mdFile?: { key?: unknown } })
              : undefined;
          const key =
            typeof rawProv?.mdFile?.key === 'string'
              ? rawProv.mdFile.key.trim()
              : '';
          const noteId = idText(raw._id);
          if (key && noteId && uniqueKeySet.has(key)) {
            distinctDocsByKey.get(key)?.add(noteId);
          }
        }
      }
    } catch {
      // Optional collection in isolated unit tests
    }

    try {
      const reportsCol = this.database().collection('work_reports');
      if (typeof reportsCol.find === 'function') {
        const cursor = reportsCol.find({
          ...scopeFilter,
          'file.key': { $in: uniqueKeys },
        });
        const rows =
          cursor && typeof cursor.toArray === 'function'
            ? await cursor.toArray()
            : [];
        for (const row of rows) {
          const raw = row as unknown as Record<string, unknown>;
          const rawFile = raw.file as { key?: unknown } | undefined;
          const key =
            typeof rawFile?.key === 'string' ? rawFile.key.trim() : '';
          const reportId = idText(raw._id);
          if (key && reportId && uniqueKeySet.has(key)) {
            distinctDocsByKey.get(key)?.add(reportId);
          }
        }
      }
    } catch {
      // Optional collection in isolated unit tests
    }

    const provider: 'CLOUDFLARE_R2' | 'LOCAL' =
      typeof this.documentStorage?.isDirectCloudEnabled === 'function' &&
      this.documentStorage.isDirectCloudEnabled()
        ? 'CLOUDFLARE_R2'
        : 'LOCAL';

    for (const entry of entries) {
      const docUniqueKeys = Array.from(
        new Set(entry.keys.map((k) => k.trim()).filter(Boolean)),
      );
      if (docUniqueKeys.length === 0) continue;

      let deletableObjectCount = 0;
      let sharedObjectCount = 0;
      const allReferencingDocs = new Set<string>([entry.documentId]);
      const externalDocs = new Set<string>();

      for (const key of docUniqueKeys) {
        const refSet = distinctDocsByKey.get(key) ?? new Set<string>();
        refSet.add(entry.documentId);
        let hasExternal = false;
        for (const refDocId of refSet) {
          allReferencingDocs.add(refDocId);
          if (refDocId !== entry.documentId) {
            externalDocs.add(refDocId);
            hasExternal = true;
          }
        }
        if (hasExternal) {
          sharedObjectCount += 1;
        } else {
          deletableObjectCount += 1;
        }
      }

      result.set(entry.documentId, {
        provider,
        objectCount: docUniqueKeys.length,
        deletableObjectCount,
        sharedObjectCount,
        refCount: allReferencingDocs.size,
        externalDocumentRefs: externalDocs.size,
        willDeleteFromStorage: deletableObjectCount > 0,
        ...(entry.currentSha256 ? { sha256: entry.currentSha256 } : {}),
      });
    }

    return result;
  }

  private async attachTaskNoteStorageReferences(
    organizationId: string,
    projectId: string,
    rawRows: Array<Record<string, unknown>>,
    mapped: TaskNoteRecord[],
  ): Promise<TaskNoteRecord[]> {
    const keyEntries: Array<{
      documentId: string;
      keys: string[];
      currentSha256?: string;
    }> = [];
    const rawById = new Map<string, Record<string, unknown>>();
    for (const row of rawRows) {
      if (row && typeof row === 'object' && row._id) {
        rawById.set(idText(row._id), row);
      }
    }
    for (const item of mapped) {
      if (item.reviewStatus !== 'APPROVED' || !item.file) continue;
      const raw = rawById.get(item.id);
      const rawProv =
        raw?.provenance && typeof raw.provenance === 'object'
          ? (raw.provenance as {
              mdFile?: { key?: unknown; sha256?: unknown };
            })
          : undefined;
      const key =
        typeof rawProv?.mdFile?.key === 'string'
          ? rawProv.mdFile.key.trim()
          : '';
      if (!key) continue;
      const currentSha256 =
        typeof rawProv?.mdFile?.sha256 === 'string' &&
        rawProv.mdFile.sha256.trim()
          ? rawProv.mdFile.sha256.trim()
          : item.file.sha256;
      keyEntries.push({
        documentId: item.id,
        keys: [key],
        ...(currentSha256 ? { currentSha256 } : {}),
      });
    }
    if (keyEntries.length === 0) return mapped;
    const refs = await this.resolveStorageReferencesByDocument(
      organizationId,
      projectId,
      keyEntries,
    );
    return mapped.map((item) => {
      const storageReference = refs.get(item.id);
      return storageReference ? { ...item, storageReference } : item;
    });
  }

  private async attachWorkReportStorageReferences(
    organizationId: string,
    projectId: string,
    rawRows: Array<Record<string, unknown>>,
    mapped: WorkReportRecord[],
  ): Promise<WorkReportRecord[]> {
    const keyEntries: Array<{
      documentId: string;
      keys: string[];
      currentSha256?: string;
    }> = [];
    const rawById = new Map<string, Record<string, unknown>>();
    for (const row of rawRows) {
      if (row && typeof row === 'object' && row._id) {
        rawById.set(idText(row._id), row);
      }
    }
    for (const item of mapped) {
      if (!item.file) continue;
      const raw = rawById.get(item.id);
      const rawFile =
        raw?.file && typeof raw.file === 'object'
          ? (raw.file as { key?: unknown })
          : undefined;
      const key = typeof rawFile?.key === 'string' ? rawFile.key.trim() : '';
      if (!key) continue;
      const currentSha256 = item.file.sha256;
      keyEntries.push({
        documentId: item.id,
        keys: [key],
        ...(currentSha256 ? { currentSha256 } : {}),
      });
    }
    if (keyEntries.length === 0) return mapped;
    const refs = await this.resolveStorageReferencesByDocument(
      organizationId,
      projectId,
      keyEntries,
    );
    return mapped.map((item) => {
      const storageReference = refs.get(item.id);
      return storageReference ? { ...item, storageReference } : item;
    });
  }

  private buildDocumentActivityHistory(
    summary: ProjectDocumentSummaryRecord,
    versionRecords: DocumentVersionRecord[],
    auditRows: AuditEventRecord[],
  ): DocumentActivityEvent[] {
    const versionByNo = new Map(
      versionRecords.map((ver) => [ver.version, ver]),
    );
    const events: DocumentActivityEvent[] = [];

    const mapAuditAction = (
      rawAction: string,
    ): DocumentActivityAction | null => {
      switch (rawAction) {
        case 'DOCUMENT_DRAFT_CREATED':
          return 'CREATED';
        case 'DOCUMENT_DRAFT_UPDATED':
          return 'UPDATED';
        case 'DOCUMENT_FILE_UPLOADED':
          return 'FILE_UPLOADED';
        case 'DOCUMENT_SUBMITTED':
          return 'SUBMITTED';
        case 'DOCUMENT_REVIEW_COMMENTED':
          return 'COMMENTED';
        case 'DOCUMENT_APPROVED':
          return 'APPROVED';
        case 'DOCUMENT_AUTO_APPROVED':
          return 'AUTO_APPROVED';
        case 'DOCUMENT_CHANGES_REQUESTED':
          return 'CHANGES_REQUESTED';
        case 'DOCUMENT_REJECTED':
          return 'REJECTED';
        case 'DOCUMENT_ARCHIVED':
          return 'ARCHIVED';
        case 'DOCUMENT_KNOWLEDGE_SYNCED':
          return 'KNOWLEDGE_SYNCED';
        case 'DOCUMENT_KNOWLEDGE_REPROCESSED':
          return 'KNOWLEDGE_REPROCESSED';
        case 'DOCUMENT_KNOWLEDGE_PAUSED':
          return 'KNOWLEDGE_PAUSED';
        case 'DOCUMENT_KNOWLEDGE_RESUMED':
          return 'KNOWLEDGE_RESUMED';
        case 'DOCUMENT_KNOWLEDGE_REVOKED':
          return 'KNOWLEDGE_REVOKED';
        default:
          return null;
      }
    };

    for (const row of auditRows) {
      const mapped = mapAuditAction(row.action);
      if (!mapped) continue;
      const meta = row.metadata ?? {};
      const verNum =
        typeof meta.version === 'number' && meta.version > 0
          ? meta.version
          : mapped === 'CREATED'
            ? 1
            : undefined;
      const matchingVersion = verNum ? versionByNo.get(verNum) : undefined;
      const fileName =
        typeof meta.fileName === 'string' && meta.fileName.trim()
          ? meta.fileName.trim()
          : mapped === 'FILE_UPLOADED' && matchingVersion?.file?.name
            ? matchingVersion.file.name
            : undefined;
      const comment =
        typeof meta.comment === 'string' && meta.comment.trim()
          ? meta.comment.trim()
          : undefined;
      const deduplicated =
        typeof meta.deduplicated === 'boolean'
          ? meta.deduplicated
          : typeof meta.isDuplicate === 'boolean'
            ? meta.isDuplicate
            : undefined;

      const occurredAtIso =
        row.occurredAt instanceof Date
          ? row.occurredAt.toISOString()
          : new Date(String(row.occurredAt)).toISOString();

      events.push({
        id: `audit-${row.id}`,
        action: mapped,
        actorId: row.actorUserId || summary.createdBy,
        ...(verNum ? { version: verNum } : {}),
        ...(fileName ? { fileName } : {}),
        ...(comment ? { comment } : {}),
        ...(deduplicated !== undefined ? { deduplicated } : {}),
        at: occurredAtIso,
      });
    }

    const hasActionForVersion = (
      actions: readonly DocumentActivityAction[],
      ver?: number,
    ) =>
      events.some(
        (ev) =>
          actions.includes(ev.action) &&
          (ver === undefined || ev.version === undefined || ev.version === ver),
      );

    if (!events.some((ev) => ev.action === 'CREATED')) {
      const firstVersion = versionRecords[0];
      events.push({
        id: `synth-created-${summary.id}`,
        action: 'CREATED',
        actorId: summary.createdBy,
        version: firstVersion?.version ?? 1,
        at: firstVersion?.createdAt || summary.createdAt,
      });
    }

    for (const ver of versionRecords) {
      if (ver.version > 1 && !hasActionForVersion(['UPDATED'], ver.version)) {
        events.push({
          id: `synth-version-${summary.id}-v${ver.version}`,
          action: 'UPDATED',
          actorId: ver.editedBy || summary.createdBy,
          version: ver.version,
          at: ver.createdAt,
        });
      }

      if (ver.file && !hasActionForVersion(['FILE_UPLOADED'], ver.version)) {
        events.push({
          id: `synth-upload-${summary.id}-v${ver.version}`,
          action: 'FILE_UPLOADED',
          actorId: ver.editedBy || summary.createdBy,
          version: ver.version,
          fileName: ver.file.name,
          at: ver.createdAt,
        });
      }

      if (ver.submittedAt && !hasActionForVersion(['SUBMITTED'], ver.version)) {
        events.push({
          id: `synth-submit-${summary.id}-v${ver.version}`,
          action: 'SUBMITTED',
          actorId: ver.editedBy || summary.createdBy,
          version: ver.version,
          at: ver.submittedAt,
        });
      }

      for (let idx = 0; idx < ver.reviewHistory.length; idx += 1) {
        const rh = ver.reviewHistory[idx];
        const rhAction: DocumentActivityAction =
          rh.action === 'PENDING_REVIEW' ? 'COMMENTED' : rh.action;
        const rhMs = new Date(rh.at).getTime();
        const existingMatch = events.find(
          (ev) =>
            ev.action === rhAction &&
            (ev.version === undefined || ev.version === ver.version) &&
            Math.abs(new Date(ev.at).getTime() - rhMs) <= 15_000,
        );
        if (existingMatch) {
          if (!existingMatch.comment && rh.comment) {
            existingMatch.comment = rh.comment;
          }
          if (!existingMatch.version) {
            existingMatch.version = ver.version;
          }
        } else {
          events.push({
            id: `synth-review-${summary.id}-v${ver.version}-${idx}`,
            action: rhAction,
            actorId: rh.reviewerId,
            version: ver.version,
            ...(rh.comment ? { comment: rh.comment } : {}),
            at: rh.at,
          });
        }
      }

      if (
        ver.status === 'APPROVED' &&
        ver.reviewedAt &&
        !hasActionForVersion(['APPROVED', 'AUTO_APPROVED'], ver.version)
      ) {
        events.push({
          id: `synth-auto-approve-${summary.id}-v${ver.version}`,
          action: 'AUTO_APPROVED',
          actorId: ver.reviewedBy || summary.createdBy,
          version: ver.version,
          ...(ver.reviewComment ? { comment: ver.reviewComment } : {}),
          at: ver.reviewedAt,
        });
      }
    }

    if (
      summary.knowledgeSync?.syncedAt &&
      summary.knowledgeSync.status !== 'NOT_SYNCED' &&
      !events.some((ev) => ev.action.startsWith('KNOWLEDGE_'))
    ) {
      const isRevoked =
        summary.knowledgeSync.status === 'REVOKED' ||
        summary.knowledgeSync.searchStatus === 'REVOKED';
      events.push({
        id: `synth-knowledge-${summary.id}`,
        action: isRevoked ? 'KNOWLEDGE_REVOKED' : 'KNOWLEDGE_SYNCED',
        actorId: summary.createdBy,
        version: summary.knowledgeSync.version || summary.version,
        ...(summary.knowledgeSync.isDuplicate ? { deduplicated: true } : {}),
        at: summary.knowledgeSync.syncedAt,
      });
    }

    if (
      summary.status === 'ARCHIVED' &&
      !events.some((ev) => ev.action === 'ARCHIVED')
    ) {
      events.push({
        id: `synth-archived-${summary.id}`,
        action: 'ARCHIVED',
        actorId: summary.createdBy,
        version: summary.version,
        at: summary.updatedAt,
      });
    }

    const actionOrder: Record<DocumentActivityAction, number> = {
      CREATED: 1,
      UPDATED: 2,
      FILE_UPLOADED: 3,
      SUBMITTED: 4,
      COMMENTED: 5,
      AUTO_APPROVED: 6,
      APPROVED: 7,
      CHANGES_REQUESTED: 8,
      REJECTED: 9,
      KNOWLEDGE_SYNCED: 10,
      KNOWLEDGE_REPROCESSED: 11,
      KNOWLEDGE_PAUSED: 12,
      KNOWLEDGE_RESUMED: 13,
      KNOWLEDGE_REVOKED: 14,
      ARCHIVED: 15,
    };

    return events.sort((a, b) => {
      const diff = new Date(a.at).getTime() - new Date(b.at).getTime();
      if (Math.abs(diff) > 100) return diff;
      if ((a.version ?? 0) !== (b.version ?? 0)) {
        return (a.version ?? 0) - (b.version ?? 0);
      }
      return (actionOrder[a.action] ?? 99) - (actionOrder[b.action] ?? 99);
    });
  }

  private documentVersion(row: Document): DocumentVersionRecord {
    const value = row as unknown as Record<string, unknown>;
    return {
      version: Number(value.versionNumber),
      title: text(value.title),
      ...(typeof value.description === 'string'
        ? { description: value.description }
        : {}),
      type: text(value.documentType) as ProjectDocumentRecord['type'],
      content: text(value.content),
      ...(value.file && typeof value.file === 'object'
        ? {
            file: {
              name: text((value.file as Record<string, unknown>).name),
              contentType: text(
                (value.file as Record<string, unknown>).contentType,
              ),
              size: Number((value.file as Record<string, unknown>).size),
            },
          }
        : {}),
      status: text(value.status) as DocumentStatus,
      editedBy: String(value.editedByUserId),
      createdAt: iso(value.createdAt) ?? '',
      ...(iso(value.submittedAt)
        ? { submittedAt: iso(value.submittedAt) }
        : {}),
      ...(value.reviewedByUserId
        ? { reviewedBy: idText(value.reviewedByUserId) }
        : {}),
      ...(iso(value.reviewedAt) ? { reviewedAt: iso(value.reviewedAt) } : {}),
      ...(typeof value.reviewComment === 'string'
        ? { reviewComment: value.reviewComment }
        : {}),
      reviewHistory: pickReviewHistory(value.reviewHistory),
    };
  }

  private permissions(
    actor: WorkNotesActor,
    authorId: string,
    status: string,
  ): WorkNotesPermissions {
    return {
      canCreate: true,
      canEdit: authorId === actor.userId && status === 'DRAFT',
      canSubmit: authorId === actor.userId && status === 'DRAFT',
      canReview:
        actor.canReview &&
        authorId !== actor.userId &&
        status === 'PENDING_REVIEW',
      canConfigure: actor.canConfigure,
    };
  }

  private taskNotePermissions(
    actor: WorkNotesActor,
    authorId: string,
    reviewStatus: TaskNoteReviewStatus = 'PENDING_REVIEW',
  ): WorkNotesPermissions {
    const isOwner = actor.userId.toLowerCase() === authorId.toLowerCase();
    const readOnlyManager = isNonMemberManager(actor);
    const canManage = !readOnlyManager && (isOwner || actor.canReview);
    const canManageApproved = !readOnlyManager && Boolean(actor.canReview);
    return {
      canCreate: !readOnlyManager,
      canEdit: canManage,
      canDelete: reviewStatus === 'APPROVED' ? canManageApproved : canManage,
      canSubmit: false,
      canReview: Boolean(
        actor.canReview && !isOwner && reviewStatus === 'PENDING_REVIEW',
      ),
      canConfigure: false,
      canControlKnowledge:
        reviewStatus === 'APPROVED' ? Boolean(actor.canReview) : canManage,
      canPurgeArtifact:
        reviewStatus === 'APPROVED' ? canManageApproved : canManage,
    };
  }

  private pagination(page: number, pageSize: number, totalItems: number) {
    return {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    };
  }

  private taskNoteNotFound() {
    return new NotFoundException({
      code: 'TASK_NOTE_NOT_FOUND',
      message: 'Task Note not found.',
    });
  }

  private reviewPermissionDenied() {
    return new ForbiddenException({
      code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
      message: 'Project review permission is required.',
    });
  }

  private database(): Db {
    if (!this.connection?.db) {
      throw new ServiceUnavailableException({
        code: 'CAPTURE_PERSISTENCE_UNAVAILABLE',
        message: 'Work Notes persistence is unavailable.',
      });
    }
    return this.connection.db;
  }

  private async transaction<T>(
    operation: (db: Db, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const db = this.database();
    const session = await this.connection!.startSession();
    try {
      const result = await session.withTransaction(() =>
        operation(db, session),
      );
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async appendOutbox(
    event: {
      eventName: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
    session: ClientSession,
  ): Promise<void> {
    if (!this.outbox) {
      throw new ServiceUnavailableException({
        code: 'CAPTURE_OUTBOX_UNAVAILABLE',
        message: 'Work Notes event delivery is unavailable.',
      });
    }
    await this.outbox.append(event, session);
  }

  private async auditEvent(
    actor: WorkNotesActor,
    action: string,
    targetResource: string,
    targetResourceId: string,
    metadata?: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<void> {
    await this.audit?.append(
      {
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        actorUserId: actor.userId,
        action,
        targetResource,
        targetResourceId,
        ...(metadata ? { metadata } : {}),
      },
      session,
    );
  }

  private uploadIntentSigningKey(): Buffer {
    // BE-DATA-002 / SEC-BE-002: Never reuse JWT_SECRET and never fall back to a
    // hardcoded forgeable string; require DOCUMENT_UPLOAD_TOKEN_SECRET in production
    // and use a random ephemeral per-process key in local dev/test when unset.
    const nodeEnv = String(
      this.config?.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? '',
    )
      .trim()
      .toLowerCase();
    const rawSecret =
      this.config?.get<string>('DOCUMENT_UPLOAD_TOKEN_SECRET')?.trim() ||
      process.env.DOCUMENT_UPLOAD_TOKEN_SECRET?.trim() ||
      (nodeEnv === 'production' ? '' : EPHEMERAL_DEV_UPLOAD_SECRET);
    if (!rawSecret) {
      throw new ServiceUnavailableException({
        code: 'DOCUMENT_UPLOAD_SIGNING_KEY_MISSING',
        message: 'Document upload signing secret is not configured.',
      });
    }
    return createHmac('sha256', rawSecret)
      .update('continuum:document-upload-intent:v1')
      .digest();
  }

  /**
   * BE-DATA-002: Single-use anti-replay check for upload-intent tokens (`jti`).
   */
  private async consumeUploadTokenJti(
    jti: string,
    expSec: number,
  ): Promise<void> {
    if (!jti || typeof jti !== 'string') {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token is missing a replay protection identifier.',
      });
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const ttlSeconds = Math.max(60, expSec - nowSec + 60);
    if (this.redis && typeof this.redis.setIfAbsent === 'function') {
      const fresh = await this.redis
        .setIfAbsent(`capture:upload-jti:${jti}`, '1', ttlSeconds)
        .catch(() => null);
      if (fresh === false) {
        throw new BadRequestException({
          code: 'DOCUMENT_UPLOAD_TOKEN_REPLAYED',
          message: 'Upload token has already been used.',
        });
      }
      if (fresh === true) return;
    }
    const nowMs = Date.now();
    if (this.consumedUploadJtis.size > 4096) {
      for (const [key, expiresAt] of this.consumedUploadJtis) {
        if (expiresAt <= nowMs) this.consumedUploadJtis.delete(key);
      }
    }
    const existingExpiry = this.consumedUploadJtis.get(jti);
    if (existingExpiry && existingExpiry > nowMs) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_REPLAYED',
        message: 'Upload token has already been used.',
      });
    }
    this.consumedUploadJtis.set(jti, nowMs + ttlSeconds * 1000);
  }

  private signDocumentUploadClaims(claims: SignedDocumentUploadClaims): string {
    const encodedPayload = Buffer.from(
      JSON.stringify(claims),
      'utf-8',
    ).toString('base64url');
    const signature = createHmac('sha256', this.uploadIntentSigningKey())
      .update(`v1.${encodedPayload}`)
      .digest('base64url');
    return `v1.${encodedPayload}.${signature}`;
  }

  private verifyDocumentUploadClaims(
    token: string,
  ): SignedDocumentUploadClaims {
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'v1' || !parts[1] || !parts[2]) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token is malformed.',
      });
    }
    const expectedSig = createHmac('sha256', this.uploadIntentSigningKey())
      .update(`v1.${parts[1]}`)
      .digest();
    let providedSig: Buffer;
    try {
      providedSig = Buffer.from(parts[2], 'base64url');
    } catch {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token signature is invalid.',
      });
    }
    if (
      providedSig.length !== expectedSig.length ||
      !timingSafeEqual(providedSig, expectedSig)
    ) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token signature is invalid.',
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
    } catch {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token payload is invalid.',
      });
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_INVALID',
        message: 'Upload token payload is invalid.',
      });
    }
    const claims = parsed as SignedDocumentUploadClaims;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < nowSec) {
      throw new BadRequestException({
        code: 'DOCUMENT_UPLOAD_TOKEN_EXPIRED',
        message: 'Upload token has expired. Please start the upload again.',
      });
    }
    return claims;
  }

  private async dispatchKnowledgeIngestionJob(
    projectId: string,
    documentId: string,
    event: string,
    version: number,
    requestId?: string,
  ): Promise<void> {
    if (!this.queueRuntime) return;
    // BE-REL-001: Deterministic BullMQ jobId without Date.now() so duplicate
    // dispatches for the same document/event/version deduplicate cleanly.
    await this.queueRuntime
      .add(
        QUEUE_NAMES.ingestion,
        'knowledge-outbox-sync',
        {
          event,
          payload: {
            projectId,
            documentId,
            version,
          },
          ...(requestId ? { requestId } : {}),
        },
        {
          jobId: `knowledge:${documentId}:${event}:v${version}`,
        },
      )
      .catch(() => undefined);
  }

  private async syncOrEnqueueApprovedDocument(
    headers: CaptureRequestHeaders,
    actor: WorkNotesActor,
    projectId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<void> {
    if (this.sagTransport) {
      const synced = await this.syncDocumentToSag(
        headers,
        projectId,
        documentId,
      ).catch(() => null);
      if (synced) return;
    }

    if (!this.outbox) return;
    const id = objectId(documentId);
    const now = new Date();
    await this.transaction(async (db, session) => {
      const queuedSync: DocumentKnowledgeStatusRecord = {
        documentId,
        version: versionNumber,
        status: 'QUEUED',
        searchStatus: 'PENDING',
        knowledgeStatus: 'NOT_STARTED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'QUEUED',
        progress: 0,
        syncedAt: now.toISOString(),
      };
      await db.collection('project_document_versions').updateOne(
        {
          documentId: id,
          versionNumber,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        {
          $set: {
            status: 'APPROVED',
            reviewedByUserId: objectId(actor.userId),
            reviewedAt: now,
            updatedAt: now,
            knowledgeSync: queuedSync,
          },
        },
        { session },
      );
      await db.collection('project_documents').updateOne(
        {
          _id: id,
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        },
        {
          $set: {
            status: 'APPROVED',
            latestApprovedVersionNumber: versionNumber,
            updatedByUserId: objectId(actor.userId),
            updatedAt: now,
            knowledgeSync: queuedSync,
          },
        },
        { session },
      );
      await this.appendOutbox(
        {
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: documentId,
          payload: {
            sourceType: 'PROJECT_DOCUMENT',
            sourceId: documentId,
            organizationId: actor.organizationId,
            projectId,
            version: versionNumber,
            approvedAt: now.toISOString(),
          },
        },
        session,
      );
      await this.auditEvent(
        actor,
        'DOCUMENT_AUTO_APPROVED',
        'PROJECT_DOCUMENT',
        documentId,
        { version: versionNumber },
        session,
      );
    }).catch(() => undefined);

    await this.dispatchKnowledgeIngestionJob(
      projectId,
      documentId,
      'KNOWLEDGE_SOURCE_APPROVED',
      versionNumber,
      headers.requestId,
    );
  }

  private async loadAuthorizedTaskNoteRow(
    headers: CaptureRequestHeaders,
    projectId: string,
    noteId: string,
  ): Promise<{ actor: WorkNotesActor; row: Record<string, unknown> }> {
    const projectActor = await this.authorization.resolveProject(
      headers,
      projectId,
    );
    if (!validId(noteId)) throw this.taskNoteNotFound();
    const raw = await this.database()
      .collection('work_notes')
      .findOne({
        _id: objectId(noteId),
        organizationId: objectId(projectActor.organizationId),
        projectId: objectId(projectId),
        type: 'TASK_NOTE',
        status: 'CONFIRMED',
      });
    const row = record(raw);
    const taskId = row ? idText(row.taskId) : '';
    if (!row || !validId(taskId)) throw this.taskNoteNotFound();
    const actor = await this.authorization.resolveTask(
      headers,
      projectId,
      taskId,
    );
    return { actor, row };
  }

  private async loadAuthorizedWorkReportRow(
    headers: CaptureRequestHeaders,
    projectId: string,
    reportId: string,
  ): Promise<{ actor: WorkNotesActor; row: Record<string, unknown> }> {
    const actor = await this.authorization.resolveProject(headers, projectId);
    if (!validId(reportId)) throw reportNotFound();
    const row = record(
      await this.database()
        .collection('work_reports')
        .findOne({
          _id: objectId(reportId),
          organizationId: objectId(actor.organizationId),
          projectId: objectId(projectId),
        }),
    );
    if (!row || !this.canViewWorkReportRow(actor, row)) {
      throw reportNotFound();
    }
    return { actor, row };
  }

  private async ensureApprovedTaskNoteMarkdownStored(
    actor: WorkNotesActor,
    row: Record<string, unknown>,
  ): Promise<{
    key?: string;
    name: string;
    contentType: string;
    size: number;
    sha256: string;
    bytes?: Buffer;
  }> {
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const reviewStatus = (rawProv.review as { status?: string } | undefined)
      ?.status;
    if (reviewStatus !== 'APPROVED') {
      throw this.taskNoteNotFound();
    }
    const noteId = String(row._id);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const existingMd =
      rawProv.mdFile && typeof rawProv.mdFile === 'object'
        ? (rawProv.mdFile as {
            key?: string;
            name?: string;
            contentType?: string;
            size?: number;
            sha256?: string;
            version?: number;
          })
        : undefined;
    if (
      existingMd?.key &&
      existingMd.name &&
      existingMd.contentType &&
      existingMd.sha256 &&
      (existingMd.version === undefined ||
        Number(existingMd.version) === versionNumber)
    ) {
      return {
        key: existingMd.key,
        name: existingMd.name,
        contentType: existingMd.contentType,
        size: Number(existingMd.size ?? 0),
        sha256: existingMd.sha256,
      };
    }

    const authorId = String(row.authorUserId);
    const reviewObj =
      rawProv.review && typeof rawProv.review === 'object'
        ? (rawProv.review as { reviewedAt?: string })
        : undefined;
    const artifact = buildTaskNoteMarkdownArtifact({
      noteId,
      taskId: idText(row.taskId),
      taskKey: actor.taskKey,
      taskTitle: actor.taskTitle,
      authorId,
      authorName:
        text(row.authorName) ||
        (authorId === actor.userId ? actor.userName : authorId),
      title: text(row.title),
      contentMarkdown:
        typeof row.contentMarkdown === 'string'
          ? row.contentMarkdown
          : undefined,
      accomplishments: text(row.whatDone),
      approach: text(row.howSolved),
      reason: text(row.whyThisWay),
      version: versionNumber,
      approvedAt: reviewObj?.reviewedAt ?? iso(row.updatedAt),
    });

    if (!this.documentStorage) {
      return {
        name: artifact.fileName,
        contentType: artifact.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      };
    }

    const projectIdStr = String(row.projectId);
    const reusedKey = await this.findExistingStorageKeyBySha256(
      actor.organizationId,
      projectIdStr,
      artifact.sha256,
    );
    const key =
      reusedKey ??
      `work-notes/${actor.organizationId}/${projectIdStr}/${noteId}/v${versionNumber}-${artifact.sha256.slice(0, 12)}.md`;
    if (!reusedKey) {
      await this.documentStorage
        .put(key, artifact.bytes, artifact.contentType)
        .catch((err: { code?: string }) => {
          if (err?.code !== 'EEXIST') throw err;
        });
    }

    const mdFileRecord = {
      key,
      name: artifact.fileName,
      contentType: artifact.contentType,
      size: artifact.size,
      sha256: artifact.sha256,
      version: versionNumber,
    };
    const db = this.database();
    await db
      .collection('work_notes')
      .updateOne(
        { _id: objectId(noteId) },
        { $set: { 'provenance.mdFile': mdFileRecord } },
      );
    try {
      await db
        .collection('work_note_versions')
        .updateOne(
          { workNoteId: objectId(noteId), versionNumber },
          { $set: { 'provenance.mdFile': mdFileRecord } },
        );
    } catch {
      // Optional version collection in isolated unit tests
    }

    return {
      key,
      name: artifact.fileName,
      contentType: artifact.contentType,
      size: artifact.size,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
  }

  private async ensureApprovedWorkReportMarkdownStored(
    actor: WorkNotesActor,
    row: Record<string, unknown>,
  ): Promise<{
    key?: string;
    name: string;
    contentType: string;
    size: number;
    sha256: string;
    bytes?: Buffer;
  }> {
    if (text(row.status) !== 'APPROVED') {
      throw reportNotFound();
    }
    const reportId = String(row._id);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const existingFile =
      row.file && typeof row.file === 'object'
        ? (row.file as {
            key?: string;
            name?: string;
            contentType?: string;
            size?: number;
          })
        : undefined;
    if (existingFile?.key && existingFile.name && existingFile.contentType) {
      const storedSha =
        typeof rawProv.fileSha256 === 'string' && rawProv.fileSha256
          ? rawProv.fileSha256
          : undefined;
      if (storedSha) {
        return {
          key: existingFile.key,
          name: existingFile.name,
          contentType: existingFile.contentType,
          size: Number(existingFile.size ?? 0),
          sha256: storedSha,
        };
      }
      if (!this.documentStorage) {
        throw new ServiceUnavailableException(
          'Project Document storage is unavailable.',
        );
      }
      const bytes = await this.documentStorage.get(existingFile.key);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return {
        key: existingFile.key,
        name: existingFile.name,
        contentType: existingFile.contentType,
        size: bytes.length,
        sha256,
        bytes,
      };
    }

    const artifact = buildWorkReportMarkdownArtifact({
      reportId,
      memberId: String(row.memberUserId),
      reportScope: text(row.reportScope) === 'LEADER' ? 'LEADER' : 'MEMBER',
      frequency: text(row.frequency) || 'WEEKLY',
      periodStart: iso(row.periodStart) ?? '',
      periodEnd: iso(row.periodEnd) ?? '',
      title: typeof row.title === 'string' ? row.title : undefined,
      contentMarkdown:
        typeof row.contentMarkdown === 'string'
          ? row.contentMarkdown
          : undefined,
      accomplishments: text(row.accomplishments),
      approach: text(row.approach),
      reason: text(row.reason),
      blockers: text(row.blockers),
      nextSteps: text(row.nextSteps),
      version: versionNumber,
      approvedAt: iso(row.reviewedAt) ?? iso(row.updatedAt),
    });

    if (!this.documentStorage) {
      return {
        name: artifact.fileName,
        contentType: artifact.contentType,
        size: artifact.size,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      };
    }

    const projectIdStr = String(row.projectId);
    const reusedKey = await this.findExistingStorageKeyBySha256(
      actor.organizationId,
      projectIdStr,
      artifact.sha256,
    );
    const key =
      reusedKey ??
      `work-reports/${actor.organizationId}/${projectIdStr}/${reportId}/v${versionNumber}-${artifact.sha256.slice(0, 12)}.md`;
    if (!reusedKey) {
      await this.documentStorage
        .put(key, artifact.bytes, artifact.contentType)
        .catch((err: { code?: string }) => {
          if (err?.code !== 'EEXIST') throw err;
        });
    }

    await this.database()
      .collection('work_reports')
      .updateOne(
        { _id: objectId(reportId) },
        {
          $set: {
            file: {
              key,
              name: artifact.fileName,
              contentType: artifact.contentType,
              size: artifact.size,
            },
            'provenance.fileSha256': artifact.sha256,
            'provenance.mdFileVersion': versionNumber,
          },
        },
      );

    return {
      key,
      name: artifact.fileName,
      contentType: artifact.contentType,
      size: artifact.size,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    };
  }

  private async findExistingStorageKeyBySha256(
    organizationId: string,
    projectId: string,
    sha256: string,
  ): Promise<string | null> {
    const db = this.database();
    const orgOid = objectId(organizationId);
    const projOid = objectId(projectId);
    try {
      const existingDocVer = await db
        .collection('project_document_versions')
        .findOne(
          {
            organizationId: orgOid,
            projectId: projOid,
            'file.sha256': sha256,
          },
          { projection: { 'file.key': 1 } },
        );
      const docKey = (existingDocVer?.file as { key?: string } | undefined)
        ?.key;
      if (docKey) return docKey;
    } catch {
      // Optional collection in isolated unit tests
    }
    try {
      const existingNote = await db.collection('work_notes').findOne(
        {
          organizationId: orgOid,
          projectId: projOid,
          status: 'CONFIRMED',
          'provenance.mdFile.sha256': sha256,
        },
        { projection: { 'provenance.mdFile.key': 1 } },
      );
      const noteKey = (
        existingNote?.provenance as { mdFile?: { key?: string } } | undefined
      )?.mdFile?.key;
      if (noteKey) return noteKey;
    } catch {
      // Optional collection in isolated unit tests
    }
    try {
      const existingReport = await db.collection('work_reports').findOne(
        {
          organizationId: orgOid,
          projectId: projOid,
          'provenance.fileSha256': sha256,
        },
        { projection: { 'file.key': 1 } },
      );
      const reportKey = (existingReport?.file as { key?: string } | undefined)
        ?.key;
      if (reportKey) return reportKey;
    } catch {
      // Optional collection in isolated unit tests
    }
    return null;
  }

  private async isStorageKeyStillReferenced(
    organizationId: string,
    projectId: string,
    key: string,
    exclude?: {
      excludeDocumentVersionId?: string;
      excludeWorkNoteId?: string;
      excludeWorkReportId?: string;
    },
  ): Promise<boolean> {
    const db = this.database();
    const scopeFilter = {
      organizationId: objectId(organizationId),
      projectId: objectId(projectId),
    };
    try {
      const docCount = await db
        .collection('project_document_versions')
        .countDocuments(
          {
            ...scopeFilter,
            'file.key': key,
            ...(exclude?.excludeDocumentVersionId &&
            validId(exclude.excludeDocumentVersionId)
              ? { _id: { $ne: objectId(exclude.excludeDocumentVersionId) } }
              : {}),
          },
          { limit: 1 },
        );
      if (docCount > 0) return true;
    } catch {
      // Optional collection
    }
    try {
      const noteCount = await db.collection('work_notes').countDocuments(
        {
          ...scopeFilter,
          status: 'CONFIRMED',
          'provenance.mdFile.key': key,
          ...(exclude?.excludeWorkNoteId && validId(exclude.excludeWorkNoteId)
            ? { _id: { $ne: objectId(exclude.excludeWorkNoteId) } }
            : {}),
        },
        { limit: 1 },
      );
      if (noteCount > 0) return true;
    } catch {
      // Optional collection
    }
    try {
      const reportCount = await db.collection('work_reports').countDocuments(
        {
          ...scopeFilter,
          $or: [{ 'file.key': key }, { 'provenance.mdFile.key': key }],
          ...(exclude?.excludeWorkReportId &&
          validId(exclude.excludeWorkReportId)
            ? { _id: { $ne: objectId(exclude.excludeWorkReportId) } }
            : {}),
        },
        { limit: 1 },
      );
      if (reportCount > 0) return true;
    } catch {
      // Optional collection
    }
    return false;
  }

  private async buildDownloadUrlResponse(file: {
    key?: string;
    name: string;
    contentType: string;
  }): Promise<DocumentDownloadUrlResponse> {
    if (
      file.key &&
      this.documentStorage &&
      typeof this.documentStorage.isDirectCloudEnabled === 'function' &&
      this.documentStorage.isDirectCloudEnabled() &&
      typeof this.documentStorage.createDirectDownloadUrl === 'function'
    ) {
      const expiresInSeconds = Math.max(
        30,
        Math.min(
          3600,
          Number(
            this.config?.get<number>('R2_PRESIGNED_DOWNLOAD_TTL_SECONDS') ??
              120,
          ) || 120,
        ),
      );
      const downloadUrl = await this.documentStorage.createDirectDownloadUrl(
        file.key,
        expiresInSeconds,
        {
          fileName: file.name,
          contentType: file.contentType,
          disposition: 'attachment',
        },
      );
      return {
        mode: 'DIRECT_GET',
        downloadUrl,
        fileName: file.name,
        contentType: file.contentType,
        expiresInSeconds,
      };
    }
    return {
      mode: 'LEGACY_PROXY',
      fileName: file.name,
      contentType: file.contentType,
    };
  }

  private async persistTaskNoteKnowledgeSyncRecord(
    noteId: string,
    versionNumber: number,
    syncRecord: DocumentKnowledgeStatusRecord,
  ): Promise<void> {
    const db = this.database();
    await db
      .collection('work_notes')
      .updateOne(
        { _id: objectId(noteId) },
        { $set: { 'provenance.knowledgeSync': syncRecord } },
      );
    try {
      await db
        .collection('work_note_versions')
        .updateOne(
          { workNoteId: objectId(noteId), versionNumber },
          { $set: { 'provenance.knowledgeSync': syncRecord } },
        );
    } catch {
      // Optional version collection in isolated unit tests
    }
  }

  private async persistWorkReportKnowledgeSyncRecord(
    reportId: string,
    _versionNumber: number,
    syncRecord: DocumentKnowledgeStatusRecord,
  ): Promise<void> {
    await this.database()
      .collection('work_reports')
      .updateOne(
        { _id: objectId(reportId) },
        { $set: { 'provenance.knowledgeSync': syncRecord } },
      );
  }

  private async resolveTaskNoteKnowledgeStatusForRow(
    actor: WorkNotesActor,
    projectId: string,
    row: Record<string, unknown>,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const noteId = String(row._id);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const fileSha256 = (rawProv.mdFile as { sha256?: string } | undefined)
      ?.sha256;
    return this.resolveEntityKnowledgeStatus({
      actor,
      projectId,
      aggregateType: 'WORK_NOTE',
      entityId: noteId,
      versionNumber,
      rawProvenance: rawProv,
      fileSha256,
      persistSync: (syncRecord) =>
        this.persistTaskNoteKnowledgeSyncRecord(
          noteId,
          versionNumber,
          syncRecord,
        ),
    });
  }

  private async resolveWorkReportKnowledgeStatusForRow(
    actor: WorkNotesActor,
    projectId: string,
    row: Record<string, unknown>,
  ): Promise<DocumentKnowledgeStatusRecord> {
    const reportId = String(row._id);
    const versionNumber = Math.max(1, Number(row.currentVersionNumber ?? 1));
    const rawProv =
      row.provenance &&
      typeof row.provenance === 'object' &&
      !Array.isArray(row.provenance)
        ? (row.provenance as Record<string, unknown>)
        : {};
    const fileSha256 =
      typeof rawProv.fileSha256 === 'string' && rawProv.fileSha256
        ? rawProv.fileSha256
        : undefined;
    return this.resolveEntityKnowledgeStatus({
      actor,
      projectId,
      aggregateType: 'WORK_REPORT',
      entityId: reportId,
      versionNumber,
      rawProvenance: rawProv,
      fileSha256,
      persistSync: (syncRecord) =>
        this.persistWorkReportKnowledgeSyncRecord(
          reportId,
          versionNumber,
          syncRecord,
        ),
    });
  }

  private async refreshTaskNotesLiveKnowledge(
    actor: WorkNotesActor,
    projectId: string,
    items: TaskNoteRecord[],
  ): Promise<TaskNoteRecord[]> {
    const hasLiveTransport =
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function';
    const candidates = items.filter(
      (item) =>
        item.reviewStatus === 'APPROVED' &&
        shouldRefreshLiveKnowledgeSync(item.knowledgeSync, hasLiveTransport),
    );
    if (candidates.length === 0) return items;
    const db = this.database();
    const refreshedById = new Map<string, DocumentKnowledgeStatusRecord>();
    await Promise.all(
      candidates.slice(0, 12).map(async (item) => {
        try {
          const row = record(
            await db.collection('work_notes').findOne({
              _id: objectId(item.id),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
            }),
          );
          if (!row) return;
          const live = await this.resolveTaskNoteKnowledgeStatusForRow(
            actor,
            projectId,
            row,
          );
          refreshedById.set(item.id, live);
        } catch {
          // Best-effort live polling refresh
        }
      }),
    );
    if (refreshedById.size === 0) return items;
    return items.map((item) => {
      const live = refreshedById.get(item.id);
      return live ? { ...item, knowledgeSync: live } : item;
    });
  }

  private async refreshWorkReportsLiveKnowledge(
    actor: WorkNotesActor,
    projectId: string,
    items: WorkReportRecord[],
  ): Promise<WorkReportRecord[]> {
    const hasLiveTransport =
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function';
    const candidates = items.filter(
      (item) =>
        item.status === 'APPROVED' &&
        shouldRefreshLiveKnowledgeSync(item.knowledgeSync, hasLiveTransport),
    );
    if (candidates.length === 0) return items;
    const db = this.database();
    const refreshedById = new Map<string, DocumentKnowledgeStatusRecord>();
    await Promise.all(
      candidates.slice(0, 12).map(async (item) => {
        try {
          const row = record(
            await db.collection('work_reports').findOne({
              _id: objectId(item.id),
              organizationId: objectId(actor.organizationId),
              projectId: objectId(projectId),
            }),
          );
          if (!row) return;
          const live = await this.resolveWorkReportKnowledgeStatusForRow(
            actor,
            projectId,
            row,
          );
          refreshedById.set(item.id, live);
        } catch {
          // Best-effort live polling refresh
        }
      }),
    );
    if (refreshedById.size === 0) return items;
    return items.map((item) => {
      const live = refreshedById.get(item.id);
      return live ? { ...item, knowledgeSync: live } : item;
    });
  }

  private async resolveEntityKnowledgeStatus(params: {
    actor: WorkNotesActor;
    projectId: string;
    aggregateType: 'WORK_NOTE' | 'WORK_REPORT';
    entityId: string;
    versionNumber: number;
    rawProvenance: Record<string, unknown>;
    fileSha256?: string;
    persistSync: (syncRecord: DocumentKnowledgeStatusRecord) => Promise<void>;
  }): Promise<DocumentKnowledgeStatusRecord> {
    const {
      actor,
      projectId,
      aggregateType,
      entityId,
      versionNumber,
      rawProvenance,
      fileSha256,
      persistSync,
    } = params;
    const storedSync = normalizeKnowledgeSyncForVersion(
      rawProvenance.knowledgeSync,
      versionNumber,
    );

    if (
      storedSync?.sagDocumentId &&
      storedSync.sagVersionNo &&
      typeof this.sagTransport?.getProjectDocumentVersionStatus === 'function'
    ) {
      try {
        const live = await this.sagTransport.getProjectDocumentVersionStatus({
          organizationId: actor.organizationId,
          projectId,
          sagDocumentId: storedSync.sagDocumentId,
          versionNo: storedSync.sagVersionNo,
          actorUserId: actor.userId,
        });
        const merged: DocumentKnowledgeStatusRecord = {
          ...storedSync,
          documentId: entityId,
          version: versionNumber,
          sagDocumentId: live.documentId,
          sagVersionNo: live.versionNo,
          status: live.status,
          searchStatus: live.searchStatus,
          knowledgeStatus: live.knowledgeStatus,
          searchReady: live.searchReady,
          knowledgeReady: Boolean(
            live.knowledgeReady ||
            isKnowledgeSettledStatus(live.knowledgeStatus),
          ),
          currentStage: live.currentStage ?? storedSync.currentStage ?? null,
          progress:
            typeof live.progress === 'number'
              ? live.progress
              : live.searchReady
                ? 100
                : (storedSync.progress ?? 10),
          ...(live.documentStatus !== undefined
            ? { documentStatus: live.documentStatus }
            : {}),
          ...(live.parserProvider !== undefined
            ? { parserProvider: live.parserProvider }
            : {}),
          ...(live.parserStatus !== undefined
            ? { parserStatus: live.parserStatus }
            : {}),
          ...(typeof live.chunkCount === 'number'
            ? { chunkCount: live.chunkCount }
            : {}),
          ...(typeof live.eventCount === 'number'
            ? { eventCount: live.eventCount }
            : {}),
          ...(typeof live.tokenUsage === 'number'
            ? { tokenUsage: live.tokenUsage }
            : {}),
          ...(live.stageProgress !== undefined
            ? { stageProgress: live.stageProgress }
            : {}),
          error: live.error ?? null,
        };
        if (typeof live.tokenUsage === 'number' && live.tokenUsage > 0) {
          void recordKnowledgeSyncTokenUsageLog(this.database(), {
            organizationId: actor.organizationId,
            projectId,
            userId: actor.userId,
            sagDocumentId: storedSync.sagDocumentId,
            sagVersionNo: storedSync.sagVersionNo ?? versionNumber,
            tokenUsage: live.tokenUsage,
          });
        }
        if (JSON.stringify(merged) !== JSON.stringify(storedSync)) {
          await persistSync(merged);
        }
        return merged;
      } catch {
        return storedSync;
      }
    }

    const isPreReceiptPlaceholder = Boolean(
      storedSync &&
      !storedSync.sagDocumentId &&
      (storedSync.status === 'QUEUED_OUTBOX' || storedSync.status === 'QUEUED'),
    );
    if (storedSync && !isPreReceiptPlaceholder) {
      return storedSync;
    }

    const pendingOutbox = await this.database()
      .collection('outbox_events')
      .findOne({
        aggregateType,
        aggregateId: entityId,
        eventName: 'KNOWLEDGE_SOURCE_APPROVED',
        'payload.version': versionNumber,
        status: { $in: ['PENDING', 'PUBLISHED', 'FAILED'] },
      });

    if (pendingOutbox) {
      const deliveryReceipt = (
        pendingOutbox.payload as
          { delivery?: { receipt?: Record<string, unknown> } } | undefined
      )?.delivery?.receipt;
      if (
        deliveryReceipt &&
        typeof deliveryReceipt.documentId === 'string' &&
        typeof deliveryReceipt.versionNo === 'number'
      ) {
        let recovered: DocumentKnowledgeStatusRecord = {
          documentId: entityId,
          version: versionNumber,
          sagDocumentId: deliveryReceipt.documentId,
          sagVersionId:
            typeof deliveryReceipt.versionId === 'string'
              ? deliveryReceipt.versionId
              : undefined,
          sagVersionNo: deliveryReceipt.versionNo,
          status:
            typeof deliveryReceipt.status === 'string'
              ? deliveryReceipt.status
              : 'SEARCH_READY',
          searchStatus:
            typeof deliveryReceipt.searchStatus === 'string'
              ? deliveryReceipt.searchStatus
              : 'SEARCH_READY',
          knowledgeStatus:
            typeof deliveryReceipt.knowledgeStatus === 'string'
              ? deliveryReceipt.knowledgeStatus
              : 'NOT_STARTED',
          searchReady: Boolean(deliveryReceipt.searchReady ?? true),
          knowledgeReady: Boolean(
            deliveryReceipt.knowledgeReady ||
            isKnowledgeSettledStatus(deliveryReceipt.knowledgeStatus),
          ),
          progress: 100,
          ...(fileSha256 ? { fileHash: fileSha256 } : {}),
        };
        if (
          typeof this.sagTransport?.getProjectDocumentVersionStatus ===
          'function'
        ) {
          try {
            const live =
              await this.sagTransport.getProjectDocumentVersionStatus({
                organizationId: actor.organizationId,
                projectId,
                sagDocumentId: deliveryReceipt.documentId,
                versionNo: deliveryReceipt.versionNo,
                actorUserId: actor.userId,
              });
            recovered = {
              ...recovered,
              status: live.status,
              searchStatus: live.searchStatus,
              knowledgeStatus: live.knowledgeStatus,
              searchReady: live.searchReady,
              knowledgeReady: Boolean(
                live.knowledgeReady ||
                isKnowledgeSettledStatus(live.knowledgeStatus),
              ),
              currentStage: live.currentStage ?? null,
              progress:
                typeof live.progress === 'number'
                  ? live.progress
                  : live.searchReady
                    ? 100
                    : 15,
              ...(live.documentStatus !== undefined
                ? { documentStatus: live.documentStatus }
                : {}),
              ...(live.parserProvider !== undefined
                ? { parserProvider: live.parserProvider }
                : {}),
              ...(live.parserStatus !== undefined
                ? { parserStatus: live.parserStatus }
                : {}),
              ...(typeof live.chunkCount === 'number'
                ? { chunkCount: live.chunkCount }
                : {}),
              ...(typeof live.eventCount === 'number'
                ? { eventCount: live.eventCount }
                : {}),
              ...(typeof live.tokenUsage === 'number'
                ? { tokenUsage: live.tokenUsage }
                : {}),
              ...(live.stageProgress !== undefined
                ? { stageProgress: live.stageProgress }
                : {}),
              error: live.error ?? null,
            };
            if (typeof live.tokenUsage === 'number' && live.tokenUsage > 0) {
              void recordKnowledgeSyncTokenUsageLog(this.database(), {
                organizationId: actor.organizationId,
                projectId,
                userId: actor.userId,
                sagDocumentId: deliveryReceipt.documentId,
                sagVersionNo: deliveryReceipt.versionNo,
                tokenUsage: live.tokenUsage,
              });
            }
          } catch {
            // Fall back to recovered outbox receipt
          }
        }
        await persistSync(recovered);
        return recovered;
      }
      if (pendingOutbox.status === 'PENDING') {
        return (
          storedSync ?? {
            documentId: entityId,
            version: versionNumber,
            ...(fileSha256 ? { fileHash: fileSha256 } : {}),
            status: 'QUEUED_OUTBOX',
            searchStatus: 'PENDING',
            knowledgeStatus: 'NOT_STARTED',
            searchReady: false,
            knowledgeReady: false,
            currentStage: 'OUTBOX_QUEUE',
            progress: 5,
          }
        );
      }
      if (pendingOutbox.status === 'FAILED') {
        const failedSync: DocumentKnowledgeStatusRecord = {
          documentId: entityId,
          version: versionNumber,
          ...(fileSha256 ? { fileHash: fileSha256 } : {}),
          status: 'FAILED',
          searchStatus: 'FAILED',
          knowledgeStatus: 'FAILED',
          searchReady: false,
          knowledgeReady: false,
          currentStage: 'OUTBOX_DELIVERY',
          progress: 0,
          error: {
            message:
              'Failed to deliver Markdown artifact to SAG processing engine.',
          },
        };
        await persistSync(failedSync);
        return failedSync;
      }
    }

    if (storedSync) return storedSync;

    return {
      documentId: entityId,
      version: versionNumber,
      ...(fileSha256 ? { fileHash: fileSha256 } : {}),
      status: 'NOT_SYNCED',
      searchStatus: 'NOT_STARTED',
      knowledgeStatus: 'NOT_STARTED',
      searchReady: false,
      knowledgeReady: false,
      currentStage: null,
      progress: 0,
    };
  }

  private async resolveEntityKnowledgeChunks(params: {
    actor: WorkNotesActor;
    projectId: string;
    aggregateType: 'WORK_NOTE' | 'WORK_REPORT';
    entityId: string;
    versionNumber: number;
    rawProvenance: Record<string, unknown>;
    options?: { limit?: number; offset?: number };
  }): Promise<DocumentKnowledgeChunksResponse> {
    const {
      actor,
      projectId,
      aggregateType,
      entityId,
      versionNumber,
      rawProvenance,
      options,
    } = params;
    let sagDocumentId: string | undefined;
    let sagVersionNo: number | undefined;
    const storedSync = normalizeKnowledgeSyncForVersion(
      rawProvenance.knowledgeSync,
      versionNumber,
    );

    if (storedSync?.status === 'REVOKED') {
      return {
        documentId: entityId,
        version: versionNumber,
        ...(storedSync.sagDocumentId
          ? { sagDocumentId: storedSync.sagDocumentId }
          : {}),
        ...(storedSync.sagVersionNo
          ? { sagVersionNo: storedSync.sagVersionNo }
          : {}),
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }

    if (storedSync?.sagDocumentId && storedSync.sagVersionNo) {
      sagDocumentId = storedSync.sagDocumentId;
      sagVersionNo = storedSync.sagVersionNo;
    } else {
      const pendingOutbox = await this.database()
        .collection('outbox_events')
        .findOne({
          aggregateType,
          aggregateId: entityId,
          eventName: 'KNOWLEDGE_SOURCE_APPROVED',
          'payload.version': versionNumber,
          status: { $in: ['PENDING', 'PUBLISHED', 'FAILED'] },
        });
      const deliveryReceipt = (
        pendingOutbox?.payload as
          { delivery?: { receipt?: Record<string, unknown> } } | undefined
      )?.delivery?.receipt;
      if (
        deliveryReceipt &&
        typeof deliveryReceipt.documentId === 'string' &&
        typeof deliveryReceipt.versionNo === 'number'
      ) {
        sagDocumentId = deliveryReceipt.documentId;
        sagVersionNo = deliveryReceipt.versionNo;
      }
    }

    if (
      !sagDocumentId ||
      !sagVersionNo ||
      typeof this.sagTransport?.getProjectDocumentVersionChunks !== 'function'
    ) {
      return {
        documentId: entityId,
        version: versionNumber,
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }

    try {
      const chunksReceipt =
        await this.sagTransport.getProjectDocumentVersionChunks({
          organizationId: actor.organizationId,
          projectId,
          sagDocumentId,
          versionNo: sagVersionNo,
          actorUserId: actor.userId,
          limit: options?.limit ?? 50,
          offset: options?.offset ?? 0,
        });
      return {
        documentId: entityId,
        version: versionNumber,
        sagDocumentId: chunksReceipt.documentId,
        sagVersionNo: chunksReceipt.versionNo,
        sourceStage: chunksReceipt.sourceStage,
        totalChunks: chunksReceipt.totalChunks,
        totalTokens: chunksReceipt.totalTokens,
        items: chunksReceipt.items,
      };
    } catch {
      return {
        documentId: entityId,
        version: versionNumber,
        sagDocumentId,
        sagVersionNo,
        sourceStage: 'EMPTY',
        totalChunks: 0,
        totalTokens: 0,
        items: [],
      };
    }
  }

  private async syncApprovedArtifactToSag(params: {
    actor: WorkNotesActor;
    projectId: string;
    aggregateType: 'WORK_NOTE' | 'WORK_REPORT';
    logicalPrefix: 'work_note' | 'work_report';
    entityId: string;
    versionNumber: number;
    rawProvenance: Record<string, unknown>;
    ensureStoredFile: () => Promise<{
      key?: string;
      name: string;
      contentType: string;
      size: number;
      sha256: string;
      bytes?: Buffer;
    }>;
    persistSync: (syncRecord: DocumentKnowledgeStatusRecord) => Promise<void>;
    auditAction: string;
  }): Promise<DocumentKnowledgeStatusRecord> {
    const {
      actor,
      projectId,
      aggregateType,
      logicalPrefix,
      entityId,
      versionNumber,
      rawProvenance,
      ensureStoredFile,
      persistSync,
      auditAction,
    } = params;
    if (!this.sagTransport) {
      throw new ServiceUnavailableException({
        code: 'SAG_SYNC_UNAVAILABLE',
        message: 'SAG Knowledge synchronization service is unavailable.',
      });
    }

    const fileMeta = await ensureStoredFile();
    const existingSync = normalizeKnowledgeSyncForVersion(
      rawProvenance.knowledgeSync,
      versionNumber,
    );
    const needsFreshIdempotencyKey = Boolean(
      existingSync &&
      ['REVOKED', 'FAILED', 'INDEX_FAILED'].some(
        (terminalState) =>
          String(existingSync.status ?? '').toUpperCase() === terminalState ||
          String(existingSync.searchStatus ?? '').toUpperCase() ===
            terminalState,
      ),
    );
    const resyncSuffix = needsFreshIdempotencyKey
      ? `:resync:${Date.now()}`
      : '';
    const logicalSourceId = `continuum:${logicalPrefix}:${entityId}`;
    const fileHash = fileMeta.sha256;
    const idempotencyKey = `continuum:${logicalPrefix}:${entityId}:v${versionNumber}:${fileHash.slice(0, 16)}${resyncSuffix}`;

    // E2E-INT-001: Always upload bytes via POST /api/v1/projects/{projectId}/documents/upload
    // (never call SAG's deleted /documents/ingest-object endpoint).
    let bytes = fileMeta.bytes;
    if (!bytes) {
      if (!this.documentStorage || !fileMeta.key) {
        throw new ServiceUnavailableException(
          'Project Document storage is unavailable.',
        );
      }
      bytes = await this.documentStorage.get(fileMeta.key);
    }
    let receipt: SagProjectDocumentUploadReceipt;
    try {
      receipt = await this.sagTransport.uploadProjectDocument({
        organizationId: actor.organizationId,
        projectId,
        documentId: entityId,
        version: versionNumber,
        logicalSourceId,
        idempotencyKey,
        actorUserId: actor.userId,
        fileName: fileMeta.name,
        contentType: fileMeta.contentType,
        bytes,
      });
    } catch (error) {
      this.mapSagTransportError(error, 'SAG_SYNC_FAILED');
    }

    const syncedAt = new Date().toISOString();
    const searchStatus = receipt.searchStatus ?? 'PENDING';
    const knowledgeStatus = receipt.knowledgeStatus ?? 'NOT_STARTED';
    const sameActiveSagVersion = Boolean(
      existingSync &&
      existingSync.sagDocumentId === receipt.documentId &&
      existingSync.sagVersionNo === receipt.versionNo &&
      !needsFreshIdempotencyKey,
    );
    const existingProgress = sameActiveSagVersion
      ? Number(existingSync?.progress ?? 0)
      : 0;
    const searchReady = Boolean(
      receipt.searchReady ||
      searchStatus === 'SEARCH_READY' ||
      (sameActiveSagVersion && existingSync?.searchReady === true),
    );
    const knowledgeReady = Boolean(
      isKnowledgeSettledStatus(knowledgeStatus) ||
      (sameActiveSagVersion && existingSync?.knowledgeReady === true),
    );

    const syncRecord: DocumentKnowledgeStatusRecord = {
      documentId: entityId,
      version: versionNumber,
      sagDocumentId: receipt.documentId,
      sagVersionId: receipt.versionId,
      sagVersionNo: receipt.versionNo,
      ...(receipt.runId ? { runId: receipt.runId } : {}),
      fileHash: receipt.fileHash ?? fileHash,
      status: searchReady ? 'SEARCH_READY' : receipt.status,
      searchStatus: searchReady ? 'SEARCH_READY' : searchStatus,
      knowledgeStatus,
      searchReady,
      knowledgeReady,
      isDuplicate: Boolean(receipt.isDuplicate),
      currentStage: searchReady
        ? 'COMPLETE'
        : sameActiveSagVersion &&
            existingProgress > 10 &&
            existingSync?.currentStage
          ? existingSync.currentStage
          : receipt.isDuplicate
            ? 'DUPLICATE'
            : 'RECEIVE',
      progress: searchReady ? 100 : Math.max(0, existingProgress),
      syncedAt,
    };

    await persistSync(syncRecord);
    await this.auditEvent(actor, auditAction, aggregateType, entityId, {
      version: versionNumber,
      sagDocumentId: receipt.documentId,
      sagVersionNo: receipt.versionNo,
      isDuplicate: Boolean(receipt.isDuplicate),
    });
    return syncRecord;
  }

  private async controlEntityKnowledge(params: {
    actor: WorkNotesActor;
    projectId: string;
    aggregateType: 'WORK_NOTE' | 'WORK_REPORT';
    logicalPrefix: 'work_note' | 'work_report';
    entityId: string;
    versionNumber: number;
    canControl: boolean;
    rawProvenance: Record<string, unknown>;
    action: DocumentKnowledgeControlAction;
    ensureStoredFile: () => Promise<{
      key?: string;
      name: string;
      contentType: string;
      size: number;
      sha256: string;
      bytes?: Buffer;
    }>;
    persistSync: (syncRecord: DocumentKnowledgeStatusRecord) => Promise<void>;
    resyncFn: () => Promise<DocumentKnowledgeStatusRecord>;
    getStatusFn: () => Promise<DocumentKnowledgeStatusRecord>;
    auditPrefix: string;
  }): Promise<DocumentKnowledgeStatusRecord> {
    const {
      actor,
      projectId,
      aggregateType,
      logicalPrefix,
      entityId,
      versionNumber,
      canControl,
      rawProvenance,
      action,
      ensureStoredFile,
      persistSync,
      resyncFn,
      getStatusFn,
      auditPrefix,
    } = params;
    if (!this.sagTransport) {
      throw new ServiceUnavailableException({
        code: 'SAG_SYNC_UNAVAILABLE',
        message: 'SAG Knowledge synchronization service is unavailable.',
      });
    }
    if (!canControl) {
      throw new ForbiddenException({
        code: 'DOCUMENT_CONTROL_FORBIDDEN',
        message:
          'Only the author or a Project reviewer can control SAG processing.',
      });
    }

    const storedSync = normalizeKnowledgeSyncForVersion(
      rawProvenance.knowledgeSync,
      versionNumber,
    );
    const logicalSourceId = `continuum:${logicalPrefix}:${entityId}`;

    if (action === 'REVOKE') {
      let revokeReceipt;
      try {
        revokeReceipt = await this.sagTransport.revokeProjectDocument({
          organizationId: actor.organizationId,
          projectId,
          documentId: entityId,
          version: versionNumber,
          logicalSourceId,
          actorUserId: actor.userId,
          reason: 'MANUAL_REVOKE',
        });
      } catch (error) {
        this.mapSagTransportError(error, 'SAG_REVOKE_FAILED');
      }
      const revokedRecord: DocumentKnowledgeStatusRecord = {
        ...(storedSync ?? {}),
        documentId: entityId,
        version: versionNumber,
        ...(revokeReceipt.documentId
          ? { sagDocumentId: revokeReceipt.documentId }
          : {}),
        status: 'REVOKED',
        searchStatus: 'REVOKED',
        knowledgeStatus: 'REVOKED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'REVOKED',
        progress: 0,
        syncedAt: new Date().toISOString(),
      };
      await persistSync(revokedRecord);
      await this.auditEvent(
        actor,
        `${auditPrefix}_KNOWLEDGE_REVOKED`,
        aggregateType,
        entityId,
        {
          version: versionNumber,
          ...(revokeReceipt.documentId
            ? { sagDocumentId: revokeReceipt.documentId }
            : {}),
        },
      );
      return revokedRecord;
    }

    if (
      action === 'REPROCESS' &&
      actor.canReview &&
      (!storedSync ||
        storedSync.status === 'NOT_SYNCED' ||
        storedSync.status === 'REVOKED' ||
        storedSync.searchStatus === 'REVOKED')
    ) {
      return resyncFn();
    }

    if (typeof this.sagTransport.controlProjectDocument !== 'function') {
      throw new ServiceUnavailableException({
        code: 'SAG_CONTROL_UNSUPPORTED',
        message: 'SAG Knowledge control transport is not available.',
      });
    }

    // E2E-INT-001: Do not generate/send ignored sourceUrl JSON body on /reprocess.
    void ensureStoredFile;
    const sagDocumentId = storedSync?.sagDocumentId || logicalSourceId;
    try {
      await this.sagTransport.controlProjectDocument({
        organizationId: actor.organizationId,
        projectId,
        sagDocumentId,
        actorUserId: actor.userId,
        action: action.toLowerCase() as 'pause' | 'resume' | 'reprocess',
      });
    } catch (error) {
      this.mapSagTransportError(error, 'SAG_CONTROL_FAILED');
    }

    const controlAuditAction =
      action === 'REPROCESS'
        ? `${auditPrefix}_KNOWLEDGE_REPROCESSED`
        : action === 'PAUSE'
          ? `${auditPrefix}_KNOWLEDGE_PAUSED`
          : `${auditPrefix}_KNOWLEDGE_RESUMED`;
    await this.auditEvent(actor, controlAuditAction, aggregateType, entityId, {
      version: versionNumber,
      sagDocumentId,
    });

    if (action === 'REPROCESS') {
      const resetRecord: DocumentKnowledgeStatusRecord = {
        ...(storedSync ?? {}),
        documentId: entityId,
        version: versionNumber,
        sagDocumentId,
        status: 'RECEIVED',
        searchStatus: 'PENDING',
        knowledgeStatus: storedSync?.knowledgeStatus ?? 'NOT_STARTED',
        searchReady: false,
        knowledgeReady: false,
        currentStage: 'RECEIVE',
        documentStatus: 'pending',
        progress: 0,
        chunkCount: 0,
        stageProgress: {},
        error: null,
        syncedAt: new Date().toISOString(),
      };
      await persistSync(resetRecord);
      return resetRecord;
    }

    return getStatusFn();
  }
}
