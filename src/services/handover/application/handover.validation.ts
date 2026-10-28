import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type {
  AcceptRequestDto,
  AcknowledgeRequestDto,
  CancelRequestDto,
  CitationDto,
  CompleteRequestDto,
  CreateHandoverDto,
  DraftItemDto,
  DraftItemInputDto,
  DraftRequestDto,
  GapAssignmentDto,
  GenerateRequestDto,
  ItemProjectionDto,
  OptionalExceptionDto,
  PublishRequestDto,
  PublishReviewDto,
  QuestionRequestDto,
  ReconcileTransferDto,
  ResolveFollowUpDto,
  RetryJobDto,
  ReviewEvidenceDto,
  SetCoordinatorDto,
  SetSuccessorDto,
  SourceJobRequestDto,
  SourceRefDto,
  StartTransferDto,
  SubmitEvidenceDto,
  TransferTaskInputDto,
  UpdateMetadataDto,
} from './handover.types';

const ID_RE = /^[a-f0-9]{24}$/;
const UUID_V4_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const ETAG_RE = /^"(handover|handover-followup):([a-f0-9]{24}):([1-9][0-9]*)"$/;
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HTTPS_LINK_RE = /^https:\/\/[^\s]+$/;

const SOURCE_KINDS = new Set([
  'TASK_NOTE',
  'PROJECT_DOCUMENT',
  'WORK_REPORT',
  'KNOWLEDGE_OBJECT',
]);
const LOCATOR_KINDS = new Set(['CHUNK', 'PAGE', 'LINE', 'SECTION']);

function badRequest(message: string, field?: string): never {
  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message,
    details: field ? { field } : {},
  });
}

function assertObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badRequest(`${label} must be a JSON object.`);
  }
  const obj = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      badRequest(`Unknown or forbidden field '${key}' in ${label}.`, key);
    }
  }
  return obj;
}

export function assertHexId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    badRequest(
      `${field} must be a 24-character lowercase hex identifier.`,
      field,
    );
  }
  return value;
}

function assertNullableHexId(value: unknown, field: string): string | null {
  if (value === null) return null;
  return assertHexId(value, field);
}

function assertString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    badRequest(`${field} must be a string.`, field);
  }
  if (value.length < minLength || value.length > maxLength) {
    badRequest(
      `${field} length must be between ${minLength} and ${maxLength}.`,
      field,
    );
  }
  return value;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    badRequest(`${field} must be a boolean.`, field);
  }
  return value;
}

function assertInt(value: unknown, field: string, min: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min
  ) {
    badRequest(`${field} must be an integer >= ${min}.`, field);
  }
  return value;
}

function assertIsoDateTime(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !ISO_DATETIME_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    badRequest(`${field} must be a valid ISO-8601 date-time string.`, field);
  }
  return value;
}

function assertUniqueArray<T>(
  value: unknown,
  field: string,
  minItems: number,
  maxItems: number,
  mapItem: (item: unknown, idx: number) => T,
  uniqueKeyFn: (item: T) => string,
): T[] {
  if (!Array.isArray(value)) {
    badRequest(`${field} must be an array.`, field);
  }
  if (value.length < minItems || value.length > maxItems) {
    badRequest(
      `${field} must contain between ${minItems} and ${maxItems} items.`,
      field,
    );
  }
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const parsed = mapItem(value[i], i);
    const key = uniqueKeyFn(parsed);
    if (seen.has(key)) {
      badRequest(`${field} must contain unique items.`, field);
    }
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

export function validateIdempotencyKeyHeader(raw: string | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!UUID_V4_RE.test(trimmed)) {
    badRequest(
      'Idempotency-Key header must be a valid UUIDv4.',
      'Idempotency-Key',
    );
  }
  return trimmed.toLowerCase();
}

export function formatHandoverEtag(
  handoverId: string,
  version: number,
): string {
  return `"handover:${handoverId.toLowerCase()}:${version}"`;
}

export function formatFollowUpEtag(
  followupId: string,
  version: number,
): string {
  return `"handover-followup:${followupId.toLowerCase()}:${version}"`;
}

export function parseRequiredIfMatch(
  raw: string | undefined,
  expectedKind: 'handover' | 'handover-followup',
  expectedResourceId: string,
): number {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    throw new HttpException(
      {
        code: 'PRECONDITION_REQUIRED',
        message: 'If-Match header is required.',
        details: {},
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
  if (trimmed.length > 150) {
    badRequest('If-Match header exceeds maximum length.', 'If-Match');
  }
  const match = ETAG_RE.exec(trimmed);
  if (!match) {
    badRequest('Malformed strong ETag in If-Match header.', 'If-Match');
  }
  const [, kind, id, verStr] = match;
  const version = Number(verStr);
  if (!Number.isSafeInteger(version) || version < 1) {
    badRequest('Invalid version in If-Match header.', 'If-Match');
  }
  if (kind !== expectedKind || id !== expectedResourceId.toLowerCase()) {
    throw new ConflictException({
      code: 'VERSION_CONFLICT',
      message: 'If-Match ETag does not match target resource.',
      details: {},
    });
  }
  return version;
}

export function parseListPagination(query: Record<string, unknown>): {
  cursor: string | null;
  limit: number;
} {
  const obj = assertObject(query, ['cursor', 'limit'], 'query');
  let cursor: string | null = null;
  if (obj.cursor !== undefined) {
    cursor = assertString(obj.cursor, 'cursor', 1, 1000);
  }
  let limit = 20;
  if (obj.limit !== undefined) {
    let parsed: unknown = obj.limit;
    if (typeof obj.limit === 'string') {
      if (!/^[0-9]+$/.test(obj.limit)) {
        badRequest('limit must be an integer between 1 and 100.', 'limit');
      }
      parsed = Number(obj.limit);
    }
    if (
      typeof parsed !== 'number' ||
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > 100
    ) {
      badRequest('limit must be an integer between 1 and 100.', 'limit');
    }
    limit = parsed;
  }
  return { cursor, limit };
}

export function validateSourceRef(
  value: unknown,
  label = 'SourceRef',
): SourceRefDto {
  const obj = assertObject(value, ['kind', 'id', 'version'], label);
  if (typeof obj.kind !== 'string' || !SOURCE_KINDS.has(obj.kind)) {
    badRequest(`Invalid source kind in ${label}.`, 'kind');
  }
  const id = assertString(obj.id, `${label}.id`, 1, 200);
  const version = assertString(obj.version, `${label}.version`, 1, 200);
  return {
    kind: obj.kind as SourceRefDto['kind'],
    id,
    version,
  };
}

export function validateCitation(
  value: unknown,
  label = 'Citation',
): CitationDto {
  const obj = assertObject(value, ['source', 'locator'], label);
  const source = validateSourceRef(obj.source, `${label}.source`);
  const loc = assertObject(obj.locator, ['kind', 'value'], `${label}.locator`);
  if (typeof loc.kind !== 'string' || !LOCATOR_KINDS.has(loc.kind)) {
    badRequest(`Invalid locator kind in ${label}.`, 'locator.kind');
  }
  const locVal = assertString(loc.value, `${label}.locator.value`, 1, 500);
  return {
    source,
    locator: {
      kind: loc.kind as CitationDto['locator']['kind'],
      value: locVal,
    },
  };
}

export function validateDraftItem(value: unknown): DraftItemDto {
  const obj = assertObject(
    value,
    [
      'itemId',
      'title',
      'body',
      'isRequired',
      'evidenceRequired',
      'sources',
      'citations',
      'requirement',
    ],
    'DraftItem',
  );
  return {
    itemId: assertHexId(obj.itemId, 'itemId'),
    title: assertString(obj.title, 'title', 1, 255),
    body: assertString(obj.body, 'body', 0, 20000),
    isRequired: assertBoolean(obj.isRequired, 'isRequired'),
    evidenceRequired: assertBoolean(obj.evidenceRequired, 'evidenceRequired'),
    sources: assertUniqueArray(
      obj.sources,
      'sources',
      0,
      50,
      (entry, i) => validateSourceRef(entry, `sources[${i}]`),
      (s) => `${s.kind}:${s.id}:${s.version}`,
    ),
    citations: assertUniqueArray(
      obj.citations,
      'citations',
      0,
      100,
      (entry, i) => validateCitation(entry, `citations[${i}]`),
      (c) =>
        `${c.source.kind}:${c.source.id}:${c.source.version}:${c.locator.kind}:${c.locator.value}`,
    ),
    requirement: assertString(obj.requirement, 'requirement', 1, 2000),
  };
}

export function validateDraftItemInput(
  value: unknown,
  label = 'DraftItemInput',
): DraftItemInputDto {
  const obj = assertObject(
    value,
    [
      'itemId',
      'title',
      'body',
      'isRequired',
      'evidenceRequired',
      'sources',
      'citations',
      'requirement',
    ],
    label,
  );
  if (!('itemId' in obj)) {
    badRequest('itemId is required (may be null).', 'itemId');
  }
  return {
    itemId: assertNullableHexId(obj.itemId, 'itemId'),
    title: assertString(obj.title, 'title', 1, 255),
    body: assertString(obj.body, 'body', 0, 20000),
    isRequired: assertBoolean(obj.isRequired, 'isRequired'),
    evidenceRequired: assertBoolean(obj.evidenceRequired, 'evidenceRequired'),
    sources: assertUniqueArray(
      obj.sources,
      'sources',
      0,
      50,
      (entry, i) => validateSourceRef(entry, `${label}.sources[${i}]`),
      (s) => `${s.kind}:${s.id}:${s.version}`,
    ),
    citations: assertUniqueArray(
      obj.citations,
      'citations',
      0,
      100,
      (entry, i) => validateCitation(entry, `${label}.citations[${i}]`),
      (c) =>
        `${c.source.kind}:${c.source.id}:${c.source.version}:${c.locator.kind}:${c.locator.value}`,
    ),
    requirement: assertString(obj.requirement, 'requirement', 1, 2000),
  };
}

export function validateCreateHandover(value: unknown): CreateHandoverDto {
  const obj = assertObject(
    value,
    [
      'departingUserId',
      'assignedLeaderId',
      'successorUserId',
      'teamId',
      'targetCompletionDate',
      'title',
    ],
    'CreateHandover',
  );
  for (const reqKey of [
    'departingUserId',
    'assignedLeaderId',
    'successorUserId',
    'teamId',
    'targetCompletionDate',
    'title',
  ]) {
    if (!(reqKey in obj)) {
      badRequest(`Missing required field '${reqKey}'.`, reqKey);
    }
  }
  return {
    departingUserId: assertHexId(obj.departingUserId, 'departingUserId'),
    assignedLeaderId: assertHexId(obj.assignedLeaderId, 'assignedLeaderId'),
    successorUserId: assertNullableHexId(
      obj.successorUserId,
      'successorUserId',
    ),
    teamId: assertNullableHexId(obj.teamId, 'teamId'),
    targetCompletionDate: assertIsoDateTime(
      obj.targetCompletionDate,
      'targetCompletionDate',
    ),
    title: assertString(obj.title, 'title', 1, 255),
  };
}

export function validateUpdateMetadata(value: unknown): UpdateMetadataDto {
  const obj = assertObject(
    value,
    ['title', 'targetCompletionDate'],
    'UpdateMetadata',
  );
  if (Object.keys(obj).length < 1) {
    badRequest('UpdateMetadata requires at least one field.');
  }
  const out: UpdateMetadataDto = {};
  if ('title' in obj) {
    out.title = assertString(obj.title, 'title', 1, 255);
  }
  if ('targetCompletionDate' in obj) {
    out.targetCompletionDate = assertIsoDateTime(
      obj.targetCompletionDate,
      'targetCompletionDate',
    );
  }
  return out;
}

export function validateSetSuccessor(value: unknown): SetSuccessorDto {
  const obj = assertObject(
    value,
    ['successorUserId', 'reason'],
    'SetSuccessor',
  );
  if (!('successorUserId' in obj)) {
    badRequest('successorUserId is required.', 'successorUserId');
  }
  return {
    successorUserId: assertNullableHexId(
      obj.successorUserId,
      'successorUserId',
    ),
    reason: assertString(obj.reason, 'reason', 1, 2000),
  };
}

export function validateSetCoordinator(value: unknown): SetCoordinatorDto {
  const obj = assertObject(
    value,
    ['assignedLeaderId', 'reason'],
    'SetCoordinator',
  );
  return {
    assignedLeaderId: assertHexId(obj.assignedLeaderId, 'assignedLeaderId'),
    reason: assertString(obj.reason, 'reason', 1, 2000),
  };
}

export function validateDraftRequest(value: unknown): DraftRequestDto {
  const obj = assertObject(
    value,
    ['expectedDraftVersion', 'items', 'taskIds', 'selectedSources'],
    'DraftRequest',
  );
  const items = assertUniqueArray(
    obj.items,
    'items',
    0,
    100,
    (entry, i) => validateDraftItemInput(entry, `items[${i}]`),
    (item) =>
      item.itemId !== null
        ? `id:${item.itemId}`
        : `new:${JSON.stringify(item)}`,
  );
  const seenNonNullIds = new Set<string>();
  for (const item of items) {
    if (item.itemId !== null) {
      if (seenNonNullIds.has(item.itemId)) {
        badRequest('Duplicate itemId in DraftRequest.items.', 'items');
      }
      seenNonNullIds.add(item.itemId);
    }
  }
  return {
    expectedDraftVersion: assertInt(
      obj.expectedDraftVersion,
      'expectedDraftVersion',
      0,
    ),
    items,
    taskIds: assertUniqueArray(
      obj.taskIds,
      'taskIds',
      0,
      100,
      (entry, i) => assertHexId(entry, `taskIds[${i}]`),
      (id) => id,
    ),
    selectedSources: assertUniqueArray(
      obj.selectedSources,
      'selectedSources',
      0,
      100,
      (entry, i) => validateSourceRef(entry, `selectedSources[${i}]`),
      (s) => `${s.kind}:${s.id}:${s.version}`,
    ),
  };
}

export function validateSourceJobRequest(value: unknown): SourceJobRequestDto {
  const obj = assertObject(
    value,
    ['query', 'expectedDraftVersion'],
    'SourceJobRequest',
  );
  return {
    query: assertString(obj.query, 'query', 1, 4000),
    expectedDraftVersion: assertInt(
      obj.expectedDraftVersion,
      'expectedDraftVersion',
      0,
    ),
  };
}

export function validateGenerateRequest(value: unknown): GenerateRequestDto {
  const obj = assertObject(value, ['expectedDraftVersion'], 'GenerateRequest');
  return {
    expectedDraftVersion: assertInt(
      obj.expectedDraftVersion,
      'expectedDraftVersion',
      1,
    ),
  };
}

export function validateRetryJob(value: unknown): RetryJobDto {
  const obj = assertObject(value, ['expectedDraftVersion'], 'RetryJob');
  return {
    expectedDraftVersion: assertInt(
      obj.expectedDraftVersion,
      'expectedDraftVersion',
      1,
    ),
  };
}

function validatePublishReview(
  value: unknown,
  label = 'PublishReview',
): PublishReviewDto {
  const obj = assertObject(
    value,
    ['itemId', 'contentVersion', 'decision', 'impact', 'reason'],
    label,
  );
  if (obj.decision !== 'CONTENT_APPROVED' && obj.decision !== 'GAP_REMAINS') {
    badRequest(`Invalid decision in ${label}.`, 'decision');
  }
  if (obj.impact !== 'UNCHANGED' && obj.impact !== 'CHANGED') {
    badRequest(`Invalid impact in ${label}.`, 'impact');
  }
  return {
    itemId: assertHexId(obj.itemId, `${label}.itemId`),
    contentVersion: assertInt(obj.contentVersion, `${label}.contentVersion`, 1),
    decision: obj.decision,
    impact: obj.impact,
    reason: assertString(obj.reason, `${label}.reason`, 1, 2000),
  };
}

function validateGapAssignment(
  value: unknown,
  label = 'GapAssignment',
): GapAssignmentDto {
  const obj = assertObject(
    value,
    ['itemId', 'reason', 'ownerUserId', 'dueAt'],
    label,
  );
  return {
    itemId: assertHexId(obj.itemId, `${label}.itemId`),
    reason: assertString(obj.reason, `${label}.reason`, 1, 2000),
    ownerUserId: assertHexId(obj.ownerUserId, `${label}.ownerUserId`),
    dueAt: assertIsoDateTime(obj.dueAt, `${label}.dueAt`),
  };
}

export function validatePublishRequest(value: unknown): PublishRequestDto {
  const obj = assertObject(
    value,
    ['expectedDraftVersion', 'reviewNote', 'itemReviews', 'gapAssignments'],
    'PublishRequest',
  );
  return {
    expectedDraftVersion: assertInt(
      obj.expectedDraftVersion,
      'expectedDraftVersion',
      1,
    ),
    reviewNote: assertString(obj.reviewNote, 'reviewNote', 1, 2000),
    itemReviews: assertUniqueArray(
      obj.itemReviews,
      'itemReviews',
      1,
      100,
      (entry, i) => validatePublishReview(entry, `itemReviews[${i}]`),
      (r) => r.itemId,
    ),
    gapAssignments: assertUniqueArray(
      obj.gapAssignments,
      'gapAssignments',
      0,
      100,
      (entry, i) => validateGapAssignment(entry, `gapAssignments[${i}]`),
      (g) => g.itemId,
    ),
  };
}

export function validateAcceptRequest(value: unknown): AcceptRequestDto {
  const obj = assertObject(value, ['revisionId'], 'AcceptRequest');
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
  };
}

export function validateAcknowledgeRequest(
  value: unknown,
): AcknowledgeRequestDto {
  const obj = assertObject(
    value,
    ['revisionId', 'contentVersion', 'assignmentVersion', 'decision', 'note'],
    'AcknowledgeRequest',
  );
  if (obj.decision !== 'UNDERSTOOD' && obj.decision !== 'NEEDS_CLARIFICATION') {
    badRequest('Invalid decision in AcknowledgeRequest.', 'decision');
  }
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    contentVersion: assertInt(obj.contentVersion, 'contentVersion', 1),
    assignmentVersion: assertInt(obj.assignmentVersion, 'assignmentVersion', 1),
    decision: obj.decision,
    note: assertString(obj.note, 'note', 0, 2000),
  };
}

export function validateSubmitEvidence(value: unknown): SubmitEvidenceDto {
  const obj = assertObject(
    value,
    [
      'revisionId',
      'contentVersion',
      'assignmentVersion',
      'resultText',
      'links',
    ],
    'SubmitEvidence',
  );
  const links = assertUniqueArray(
    obj.links,
    'links',
    0,
    10,
    (entry, i) => {
      const link = assertString(entry, `links[${i}]`, 8, 2000);
      if (!HTTPS_LINK_RE.test(link)) {
        badRequest(`links[${i}] must be a valid https:// URL.`, `links[${i}]`);
      }
      try {
        const parsed = new URL(link);
        if (parsed.protocol !== 'https:' || !parsed.hostname) {
          badRequest(`links[${i}] must use https://.`, `links[${i}]`);
        }
      } catch {
        badRequest(`links[${i}] is not a valid URL.`, `links[${i}]`);
      }
      return link;
    },
    (l) => l,
  );
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    contentVersion: assertInt(obj.contentVersion, 'contentVersion', 1),
    assignmentVersion: assertInt(obj.assignmentVersion, 'assignmentVersion', 1),
    resultText: assertString(obj.resultText, 'resultText', 1, 10000),
    links,
  };
}

export function validateReviewEvidence(value: unknown): ReviewEvidenceDto {
  const obj = assertObject(
    value,
    ['revisionId', 'evidenceId', 'outcome', 'note'],
    'ReviewEvidence',
  );
  if (obj.outcome !== 'ACCEPTED' && obj.outcome !== 'CHANGES_REQUESTED') {
    badRequest('Invalid outcome in ReviewEvidence.', 'outcome');
  }
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    evidenceId: assertHexId(obj.evidenceId, 'evidenceId'),
    outcome: obj.outcome,
    note: assertString(obj.note, 'note', 1, 2000),
  };
}

export function validateOptionalException(
  value: unknown,
): OptionalExceptionDto {
  const obj = assertObject(
    value,
    ['revisionId', 'contentVersion', 'reason', 'ownerUserId', 'dueAt'],
    'OptionalException',
  );
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    contentVersion: assertInt(obj.contentVersion, 'contentVersion', 1),
    reason: assertString(obj.reason, 'reason', 1, 2000),
    ownerUserId: assertHexId(obj.ownerUserId, 'ownerUserId'),
    dueAt: assertIsoDateTime(obj.dueAt, 'dueAt'),
  };
}

function validateTransferTask(
  value: unknown,
  label = 'TransferTask',
): TransferTaskInputDto {
  const obj = assertObject(value, ['taskId', 'expectedTaskVersion'], label);
  return {
    taskId: assertHexId(obj.taskId, `${label}.taskId`),
    expectedTaskVersion: assertInt(
      obj.expectedTaskVersion,
      `${label}.expectedTaskVersion`,
      1,
    ),
  };
}

export function validateStartTransfer(value: unknown): StartTransferDto {
  const obj = assertObject(
    value,
    ['revisionId', 'assignmentVersion', 'tasks'],
    'StartTransfer',
  );
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    assignmentVersion: assertInt(obj.assignmentVersion, 'assignmentVersion', 1),
    tasks: assertUniqueArray(
      obj.tasks,
      'tasks',
      1,
      100,
      (entry, i) => validateTransferTask(entry, `tasks[${i}]`),
      (t) => t.taskId,
    ),
  };
}

export function validateReconcileTransfer(
  value: unknown,
): ReconcileTransferDto {
  const obj = assertObject(value, ['transferId'], 'ReconcileTransfer');
  return {
    transferId: assertHexId(obj.transferId, 'transferId'),
  };
}

export function validateCompleteRequest(value: unknown): CompleteRequestDto {
  const obj = assertObject(
    value,
    ['revisionId', 'assignmentVersion', 'reviewNote'],
    'CompleteRequest',
  );
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    assignmentVersion: assertInt(obj.assignmentVersion, 'assignmentVersion', 1),
    reviewNote: assertString(obj.reviewNote, 'reviewNote', 1, 2000),
  };
}

export function validateCancelRequest(value: unknown): CancelRequestDto {
  const obj = assertObject(value, ['reason'], 'CancelRequest');
  return {
    reason: assertString(obj.reason, 'reason', 1, 2000),
  };
}

export function validateResolveFollowUp(value: unknown): ResolveFollowUpDto {
  const obj = assertObject(
    value,
    ['resolutionNote', 'references'],
    'ResolveFollowUp',
  );
  return {
    resolutionNote: assertString(obj.resolutionNote, 'resolutionNote', 1, 4000),
    references: assertUniqueArray(
      obj.references,
      'references',
      0,
      20,
      (entry, i) => validateSourceRef(entry, `references[${i}]`),
      (s) => `${s.kind}:${s.id}:${s.version}`,
    ),
  };
}

export function validateQuestionRequest(value: unknown): QuestionRequestDto {
  const obj = assertObject(
    value,
    ['revisionId', 'assignmentVersion', 'question'],
    'QuestionRequest',
  );
  return {
    revisionId: assertHexId(obj.revisionId, 'revisionId'),
    assignmentVersion: assertInt(obj.assignmentVersion, 'assignmentVersion', 1),
    question: assertString(obj.question, 'question', 1, 4000),
  };
}

export function validateItemProjection(value: unknown): ItemProjectionDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    badRequest('ItemProjection must be an object.');
  }
  const raw = value as Record<string, unknown>;
  if (raw.access === 'UNAVAILABLE') {
    const obj = assertObject(value, ['itemId', 'access'], 'UnavailableItem');
    return {
      itemId: assertHexId(obj.itemId, 'itemId'),
      access: 'UNAVAILABLE',
    };
  }
  if (raw.access === 'AVAILABLE') {
    const obj = assertObject(
      value,
      [
        'itemId',
        'access',
        'contentVersion',
        'title',
        'body',
        'isRequired',
        'evidenceRequired',
        'requirement',
        'sources',
        'citations',
        'contentReview',
        'acknowledgement',
        'evidenceReview',
        'optionalExceptionAccepted',
        'sourceState',
      ],
      'AvailableItem',
    );
    if (
      obj.contentReview !== 'CONTENT_APPROVED' &&
      obj.contentReview !== 'GAP_REMAINS'
    ) {
      badRequest('Invalid contentReview.', 'contentReview');
    }
    if (
      obj.acknowledgement !== 'PENDING' &&
      obj.acknowledgement !== 'UNDERSTOOD' &&
      obj.acknowledgement !== 'NEEDS_CLARIFICATION'
    ) {
      badRequest('Invalid acknowledgement.', 'acknowledgement');
    }
    if (
      obj.evidenceReview !== 'NOT_REQUIRED' &&
      obj.evidenceReview !== 'PENDING' &&
      obj.evidenceReview !== 'ACCEPTED' &&
      obj.evidenceReview !== 'CHANGES_REQUESTED'
    ) {
      badRequest('Invalid evidenceReview.', 'evidenceReview');
    }
    if (obj.sourceState !== 'CURRENT' && obj.sourceState !== 'CHANGED') {
      badRequest('Invalid sourceState.', 'sourceState');
    }
    return {
      itemId: assertHexId(obj.itemId, 'itemId'),
      access: 'AVAILABLE',
      contentVersion: assertInt(obj.contentVersion, 'contentVersion', 1),
      title: assertString(obj.title, 'title', 1, 255),
      body: assertString(obj.body, 'body', 0, 20000),
      isRequired: assertBoolean(obj.isRequired, 'isRequired'),
      evidenceRequired: assertBoolean(obj.evidenceRequired, 'evidenceRequired'),
      requirement: assertString(obj.requirement, 'requirement', 1, 2000),
      sources: assertUniqueArray(
        obj.sources,
        'sources',
        0,
        50,
        (entry, i) => validateSourceRef(entry, `sources[${i}]`),
        (s) => `${s.kind}:${s.id}:${s.version}`,
      ),
      citations: assertUniqueArray(
        obj.citations,
        'citations',
        0,
        100,
        (entry, i) => validateCitation(entry, `citations[${i}]`),
        (c) =>
          `${c.source.kind}:${c.source.id}:${c.source.version}:${c.locator.kind}:${c.locator.value}`,
      ),
      contentReview: obj.contentReview,
      acknowledgement: obj.acknowledgement,
      evidenceReview: obj.evidenceReview,
      optionalExceptionAccepted: assertBoolean(
        obj.optionalExceptionAccepted,
        'optionalExceptionAccepted',
      ),
      sourceState: obj.sourceState,
    };
  }
  badRequest('Invalid access discriminator in ItemProjection.', 'access');
}

export function validateNamedContractSchema(
  schemaName: string,
  payload: unknown,
): unknown {
  switch (schemaName) {
    case 'CreateHandover':
      return validateCreateHandover(payload);
    case 'SubmitEvidence':
      return validateSubmitEvidence(payload);
    case 'ReviewEvidence':
      return validateReviewEvidence(payload);
    case 'OptionalException':
      return validateOptionalException(payload);
    case 'CompleteRequest':
      return validateCompleteRequest(payload);
    case 'ItemProjection':
      return validateItemProjection(payload);
    case 'ResolveFollowUp':
      return validateResolveFollowUp(payload);
    case 'AcknowledgeRequest':
      return validateAcknowledgeRequest(payload);
    case 'DraftItem':
      return validateDraftItem(payload);
    case 'DraftItemInput':
      return validateDraftItemInput(payload);
    case 'QuestionRequest':
      return validateQuestionRequest(payload);
    default:
      throw new Error(`Unsupported schema oracle '${schemaName}'`);
  }
}
