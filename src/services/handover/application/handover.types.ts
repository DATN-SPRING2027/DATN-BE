import type { Types } from 'mongoose';

export type HandoverStatus = 'OPEN' | 'COMPLETED' | 'CANCELLED';

export type HandoverCapability =
  'READ' | 'MANAGE' | 'RECEIVE' | 'REVIEW' | 'TRANSFER' | 'FOLLOW_UP';

export type SourceRefKind =
  'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT' | 'KNOWLEDGE_OBJECT';

export type CitationLocatorKind = 'CHUNK' | 'PAGE' | 'LINE' | 'SECTION';

export interface SourceRefDto {
  kind: SourceRefKind;
  id: string;
  version: string;
}

export interface CitationDto {
  source: SourceRefDto;
  locator: {
    kind: CitationLocatorKind;
    value: string;
  };
}

export interface DraftItemDto {
  itemId: string;
  contentVersion: number;
  title: string;
  body: string;
  isRequired: boolean;
  evidenceRequired: boolean;
  sources: SourceRefDto[];
  citations: CitationDto[];
  requirement: string;
}

export interface DraftItemInputDto {
  itemId: string | null;
  title: string;
  body: string;
  isRequired: boolean;
  evidenceRequired: boolean;
  sources: SourceRefDto[];
  citations: CitationDto[];
  requirement: string;
}

export interface CreateHandoverDto {
  departingUserId: string;
  assignedLeaderId: string;
  successorUserId: string | null;
  teamId: string | null;
  targetCompletionDate: string;
  title: string;
}

export interface UpdateMetadataDto {
  title?: string;
  targetCompletionDate?: string;
}

export interface SetSuccessorDto {
  successorUserId: string | null;
  reason: string;
}

export interface SetCoordinatorDto {
  assignedLeaderId: string;
  reason: string;
}

export interface DraftRequestDto {
  expectedDraftVersion: number;
  items: DraftItemInputDto[];
  taskIds: string[];
  selectedSources: SourceRefDto[];
}

export interface SourceJobRequestDto {
  query: string;
  expectedDraftVersion: number;
}

export interface GenerateRequestDto {
  expectedDraftVersion: number;
}

export interface RetryJobDto {
  expectedDraftVersion: number;
}

export interface PublishReviewDto {
  itemId: string;
  contentVersion: number;
  decision: 'CONTENT_APPROVED' | 'GAP_REMAINS';
  impact: 'UNCHANGED' | 'CHANGED';
  reason: string;
}

export interface GapAssignmentDto {
  itemId: string;
  reason: string;
  ownerUserId: string;
  dueAt: string;
}

export interface PublishRequestDto {
  expectedDraftVersion: number;
  reviewNote: string;
  itemReviews: PublishReviewDto[];
  gapAssignments: GapAssignmentDto[];
}

export interface AcceptRequestDto {
  revisionId: string;
}

export interface AcknowledgeRequestDto {
  revisionId: string;
  contentVersion: number;
  assignmentVersion: number;
  decision: 'UNDERSTOOD' | 'NEEDS_CLARIFICATION';
  note: string;
}

export interface SubmitEvidenceDto {
  revisionId: string;
  contentVersion: number;
  assignmentVersion: number;
  resultText: string;
  links: string[];
}

export interface ReviewEvidenceDto {
  revisionId: string;
  evidenceId: string;
  outcome: 'ACCEPTED' | 'CHANGES_REQUESTED';
  note: string;
}

export interface OptionalExceptionDto {
  revisionId: string;
  contentVersion: number;
  reason: string;
  ownerUserId: string;
  dueAt: string;
}

export interface TransferTaskInputDto {
  taskId: string;
  expectedTaskVersion: number;
}

export interface StartTransferDto {
  revisionId: string;
  assignmentVersion: number;
  tasks: TransferTaskInputDto[];
}

export interface ReconcileTransferDto {
  transferId: string;
}

export interface CompleteRequestDto {
  revisionId: string;
  assignmentVersion: number;
  reviewNote: string;
}

export interface CancelRequestDto {
  reason: string;
}

export interface ResolveFollowUpDto {
  resolutionNote: string;
  references: SourceRefDto[];
}

export interface QuestionRequestDto {
  revisionId: string;
  assignmentVersion: number;
  question: string;
}

export interface ReceiptDto {
  operationId: string;
  handoverId: string;
  version: number;
  status: HandoverStatus;
  revisionId: string | null;
  replayed: boolean;
}

export interface HandoverSummaryDto {
  id: string;
  projectId: string;
  teamId: string | null;
  departingUserId: string;
  assignedLeaderId: string;
  successorUserId: string | null;
  assignmentVersion: number;
  title: string;
  version: number;
  status: HandoverStatus;
  publishedRevisionId: string | null;
  draftVersion: number;
  targetCompletionDate: string;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AvailableItemDto {
  itemId: string;
  access: 'AVAILABLE';
  contentVersion: number;
  title: string;
  body: string;
  isRequired: boolean;
  evidenceRequired: boolean;
  requirement: string;
  sources: SourceRefDto[];
  citations: CitationDto[];
  contentReview: 'CONTENT_APPROVED' | 'GAP_REMAINS';
  acknowledgement: 'PENDING' | 'UNDERSTOOD' | 'NEEDS_CLARIFICATION';
  evidenceReview: 'NOT_REQUIRED' | 'PENDING' | 'ACCEPTED' | 'CHANGES_REQUESTED';
  optionalExceptionAccepted: boolean;
  sourceState: 'CURRENT' | 'CHANGED';
}

export interface UnavailableItemDto {
  itemId: string;
  access: 'UNAVAILABLE';
}

export type ItemProjectionDto = AvailableItemDto | UnavailableItemDto;

export interface RevisionProjectionDto {
  id: string;
  handoverId: string;
  number: number;
  publishedAt: string;
  publishedBy: string;
  items: ItemProjectionDto[];
  isCurrent: boolean;
}

export interface HandoverDetailDto {
  handover: HandoverSummaryDto;
  publishedRevision: RevisionProjectionDto | null;
  capabilities: HandoverCapability[];
  requiredPendingCount: number;
  canComplete: boolean;
}

export interface HandoverListDto {
  data: HandoverSummaryDto[];
  nextCursor: string | null;
}

export interface DraftProjectionDto {
  handoverId: string;
  draftVersion: number;
  items: DraftItemDto[];
  taskIds: string[];
  selectedSources: SourceRefDto[];
}

export type HandoverJobKind = 'SOURCE_PROPOSAL' | 'GENERATION';
export type HandoverJobState =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SUPERSEDED' | 'CANCELLED';

export interface JobDto {
  id: string;
  handoverId: string;
  kind: HandoverJobKind;
  state: HandoverJobState;
  inputDraftVersion: number;
  safeErrorCode: string | null;
  createdAt: string;
}

export interface SourceCandidateDto {
  source: SourceRefDto;
  title: string;
  reason: string;
}

export interface SourceCandidatesDto {
  jobId: string;
  data: SourceCandidateDto[];
  state: HandoverJobState;
}

export interface EvidenceReceiptDto {
  id: string;
  handoverId: string;
  itemId: string;
  revisionId: string;
  submittedBy: string;
  assignmentVersion: number;
  review: 'PENDING' | 'ACCEPTED' | 'CHANGES_REQUESTED';
  createdAt: string;
}

export interface ItemEvidenceDetailDto extends EvidenceReceiptDto {
  contentVersion: number;
  resultText: string;
  links: string[];
  reviewNote: string | null;
}

export interface FollowUpDto {
  id: string;
  handoverId: string;
  revisionId: string;
  itemId: string;
  ownerUserId: string;
  dueAt: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED';
  version: number;
  resolvedAt: string | null;
}

export interface FollowUpListDto {
  data: FollowUpDto[];
  nextCursor: string | null;
}

export type TaskTransferChildResultState =
  'PENDING' | 'CONFIRMED' | 'UNKNOWN' | 'CONFLICT' | 'FAILED';

export type TaskTransferAggregateState =
  'PENDING' | 'CONFIRMED' | 'PARTIAL' | 'UNKNOWN' | 'CONFLICT' | 'FAILED';

export interface TaskTransferResultDto {
  taskId: string;
  intentId: string;
  state: TaskTransferChildResultState;
  expectedTaskVersion: number;
  committedTaskVersion: number | null;
  safeErrorCode: string | null;
}

export interface TransferDto {
  id: string;
  handoverId: string;
  revisionId: string;
  successorUserId: string;
  assignmentVersion: number;
  tasks: TaskTransferResultDto[];
  state: TaskTransferAggregateState;
}

export interface AnswerSectionDto {
  text: string;
  citations: CitationDto[];
}

export interface HandoverAnswerDto {
  revisionId: string;
  answerStatus: 'ANSWERED' | 'INSUFFICIENT_EVIDENCE';
  message: string;
  sections: AnswerSectionDto[];
}

export interface HandoverRequestHeaders {
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  idempotencyKey?: string;
  ifMatch?: string;
  organizationId?: string;
  requestId?: string;
}

export interface StoredHandoverTaskRef {
  taskId: Types.ObjectId;
  expectedVersion: number;
  expectedAssigneeId: string | null;
}

export interface StoredHandoverItemSnapshot {
  itemId: Types.ObjectId;
  contentVersion: number;
  dependencyFingerprint: string;
  title: string;
  body: string;
  requirement: string;
  isRequired: boolean;
  evidenceRequired: boolean;
  sources: SourceRefDto[];
  citations: CitationDto[];
}

export interface StoredHandoverDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  departingUserId: string;
  assignedLeaderId: string;
  successorUserId: string | null;
  title: string;
  targetCompletionDate: Date;
  status: HandoverStatus;
  version: number;
  draftVersion: number;
  assignmentVersion: number;
  publishedRevisionId: Types.ObjectId | null;
  selectedSources: SourceRefDto[];
  selectedTasks: StoredHandoverTaskRef[];
  createdBy: string;
  completedAt?: Date;
  completedBy?: string;
  completionReviewNote?: string;
  cancelledAt?: Date;
  cancelledBy?: string;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredDraftItemDoc extends StoredHandoverItemSnapshot {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredRevisionDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  number: number;
  draftVersion: number;
  assignmentVersion: number;
  successorUserId: string | null;
  items: StoredHandoverItemSnapshot[];
  selectedSources: SourceRefDto[];
  selectedTasks: StoredHandoverTaskRef[];
  reviews: Array<{
    itemId: Types.ObjectId;
    contentVersion: number;
    decision: 'CONTENT_APPROVED' | 'GAP_REMAINS';
    impact: 'UNCHANGED' | 'CHANGED';
    reason: string;
  }>;
  gaps: Array<{
    itemId: Types.ObjectId;
    ownerUserId: string;
    dueAt: Date;
    reason: string;
  }>;
  publishedBy: string;
  publishedAt: Date;
  sourceFingerprint: string;
  reviewNote: string;
  createdAt: Date;
}

export interface StoredAcceptanceDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  revisionId: Types.ObjectId;
  successorUserId: string;
  assignmentVersion: number;
  kind: 'PACKAGE' | 'ITEM';
  itemId?: Types.ObjectId;
  contentVersion?: number;
  dependencyFingerprint?: string;
  decision: 'ACCEPTED' | 'UNDERSTOOD' | 'NEEDS_CLARIFICATION';
  note: string;
  commandId: Types.ObjectId;
  sequence: number;
  occurredAt: Date;
  carriedFromAcceptanceId?: Types.ObjectId;
  createdAt: Date;
}

export interface StoredEvidenceDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  revisionId: Types.ObjectId;
  successorUserId: string;
  assignmentVersion: number;
  itemId: Types.ObjectId;
  contentVersion: number;
  dependencyFingerprint: string;
  resultText: string;
  links: string[];
  commandId: Types.ObjectId;
  sequence: number;
  submittedAt: Date;
  createdAt: Date;
}

export interface StoredEvidenceReviewDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  revisionId: Types.ObjectId;
  successorUserId: string;
  assignmentVersion: number;
  itemId: Types.ObjectId;
  contentVersion: number;
  dependencyFingerprint: string;
  evidenceId: Types.ObjectId;
  reviewerUserId: string;
  decision: 'APPROVED' | 'REJECTED';
  note: string;
  commandId: Types.ObjectId;
  sequence: number;
  reviewedAt: Date;
  createdAt: Date;
}

export interface StoredFollowUpDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  revisionId: Types.ObjectId;
  itemId: Types.ObjectId;
  kind: 'KNOWLEDGE_GAP';
  isRequired: boolean;
  ownerUserId: string;
  reason: string;
  dueAt: Date;
  status: 'OPEN' | 'RESOLVED';
  version: number;
  createdBy: string;
  resolvedAt: Date | null;
  resolvedBy?: string;
  resolutionNote?: string;
  resolutionEvidenceId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredOperationDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId?: Types.ObjectId;
  actorUserId: string;
  namespace: string;
  key: string;
  fingerprint: string;
  kind: 'COMMAND' | 'TASK_TRANSFER' | 'TASK_TRANSFER_CHILD';
  state:
    | 'PENDING'
    | 'DISPATCHED'
    | 'COMMITTED'
    | 'REJECTED'
    | 'UNKNOWN'
    | 'PARTIAL'
    | 'CONFLICT'
    | 'SUPERSEDED'
    | 'FAILED';
  expectedVersion?: number;
  assignmentVersion?: number;
  revisionId?: Types.ObjectId;
  successorUserId?: string;
  parentOperationId?: Types.ObjectId;
  taskIntent?: {
    taskId: Types.ObjectId;
    expectedVersion: number;
    expectedAssigneeId: string | null;
    targetUserId: string;
  };
  taskOutcome?: {
    state: 'COMMITTED' | 'REJECTED' | 'UNKNOWN' | 'CONFLICT';
    taskVersion?: number;
    assigneeId?: string | null;
    owningOperationId?: string;
    safeErrorCode?: string;
  };
  receipt?: {
    resourceId?: Types.ObjectId;
    resourceVersion?: number;
    revisionId?: Types.ObjectId;
    jobId?: Types.ObjectId;
    transferId?: Types.ObjectId;
    followUpId?: Types.ObjectId;
    outcome?: string;
  };
  safeErrorCode?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  fence?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredJobDoc {
  _id: Types.ObjectId;
  schemaVersion: 2;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  handoverId: Types.ObjectId;
  initiatedBy: string;
  commandId: Types.ObjectId;
  kind: HandoverJobKind;
  state: HandoverJobState;
  inputDraftVersion: number;
  query?: string;
  sourceFingerprint: string;
  selectedSources: SourceRefDto[];
  candidates?: SourceRefDto[];
  resultItems?: StoredHandoverItemSnapshot[];
  appliedDraftVersion?: number;
  attempt: number;
  safeErrorCode?: string;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
