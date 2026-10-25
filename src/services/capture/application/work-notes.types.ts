import type { WorkReportFrequency } from './work-notes.domain';

export type DocumentType =
  | 'MVP'
  | 'DATABASE_DESIGN'
  | 'RSR'
  | 'ARCHITECTURE'
  | 'API_SPECIFICATION'
  | 'RESEARCH'
  | 'REQUIREMENT'
  | 'DESIGN'
  | 'TECHNICAL_SPECIFICATION'
  | 'OTHER';

export type DocumentStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'ARCHIVED';

export type WorkReportStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'REJECTED'
  | 'OVERDUE';

export type WorkReportScope = 'MEMBER' | 'LEADER';

export interface CaptureRequestHeaders {
  authorization?: string;
  cookie?: string;
  csrfToken?: string;
  organizationId?: string;
  requestId?: string;
}

export interface WorkNotesActor {
  userId: string;
  userName: string;
  organizationId: string;
  projectId: string;
  canReview: boolean;
  canConfigure: boolean;
  isManager?: boolean;
  isLeader?: boolean;
  joinedAt?: string;
  taskKey?: string;
  taskTitle?: string;
}

export type TaskNoteSortOrder = 'recent' | 'oldest';

export interface ProjectTaskNotesQueryOptions {
  taskId?: string;
  authorId?: string;
  search?: string;
  sort?: TaskNoteSortOrder;
}

export interface TaskNoteInput {
  title: string;
  accomplishments: string;
  approach: string;
  reason: string;
}

export interface ProjectDocumentInput {
  title: string;
  description?: string;
  type: DocumentType;
  content: string;
}

export interface ProjectDocumentFileRecord {
  name: string;
  contentType: string;
  size: number;
}

export interface ReviewInput {
  comment?: string;
}

export interface WorkReportInput {
  accomplishments: string;
  approach: string;
  reason: string;
  blockers?: string;
  nextSteps?: string;
  documentIds?: string[];
}

export interface WorkNotesPagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface WorkNotesPage<T> {
  data: T[];
  pagination: WorkNotesPagination;
}

export interface WorkNotesPermissions {
  canCreate: boolean;
  canEdit: boolean;
  canDelete?: boolean;
  canSubmit: boolean;
  canReview: boolean;
  canConfigure: boolean;
}

export interface TaskNoteRecord extends TaskNoteInput {
  id: string;
  projectId: string;
  taskId: string;
  taskKey?: string;
  taskTitle?: string;
  authorId: string;
  authorName: string;
  type: 'TASK_NOTE';
  status: 'CONFIRMED';
  createdAt: string;
  updatedAt: string;
  permissions: WorkNotesPermissions;
}

export interface DocumentVersionRecord {
  version: number;
  title: string;
  description?: string;
  type: DocumentType;
  content: string;
  file?: ProjectDocumentFileRecord;
  status: DocumentStatus;
  editedBy: string;
  createdAt: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  reviewHistory: Array<{
    action: 'PENDING_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';
    reviewerId: string;
    comment?: string;
    at: string;
  }>;
}

export interface ProjectDocumentSummaryRecord {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  type: DocumentType;
  version: number;
  status: DocumentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  permissions: WorkNotesPermissions;
}

export interface ProjectDocumentRecord extends ProjectDocumentSummaryRecord {
  content: string;
  file?: ProjectDocumentFileRecord;
  versions: Array<
    Pick<
      DocumentVersionRecord,
      'version' | 'status' | 'createdAt' | 'editedBy' | 'file'
    >
  >;
  reviewHistory: DocumentVersionRecord['reviewHistory'];
}

export interface WorkReportRecord extends WorkReportInput {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string;
  reportScope?: WorkReportScope;
  frequency: WorkReportFrequency;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  status: WorkReportStatus;
  file?: ProjectDocumentFileRecord;
  documentIds?: string[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  reviewHistory: DocumentVersionRecord['reviewHistory'];
  permissions: WorkNotesPermissions;
}

export interface WorkReportSettingsRecord {
  projectId: string;
  scope?: WorkReportScope;
  actorRole?: 'MANAGER' | 'LEADER' | 'MEMBER';
  frequency: WorkReportFrequency;
  effectiveAt: string;
  nextFrequency?: WorkReportFrequency;
  nextEffectiveAt?: string;
  updatedBy: string;
  history: Array<{
    frequency: WorkReportFrequency;
    effectiveAt: string;
    updatedBy: string;
  }>;
  permissions: Pick<WorkNotesPermissions, 'canConfigure'>;
  leaderSettings?: {
    frequency: WorkReportFrequency;
    effectiveAt: string;
    updatedBy: string;
    history: Array<{
      frequency: WorkReportFrequency;
      effectiveAt: string;
      updatedBy: string;
    }>;
    permissions: Pick<WorkNotesPermissions, 'canConfigure'>;
  };
}
