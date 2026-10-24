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

export interface CaptureRequestHeaders {
  authorization?: string;
  cookie?: string;
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
  taskId?: string;
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
  canSubmit: boolean;
  canReview: boolean;
  canConfigure: boolean;
}

export interface TaskNoteRecord extends TaskNoteInput {
  id: string;
  projectId: string;
  taskId: string;
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
  taskId?: string;
  content: string;
  status: DocumentStatus;
  editedBy: string;
  createdAt: string;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewComment?: string;
  reviewHistory: Array<{
    action: 'APPROVED' | 'CHANGES_REQUESTED' | 'REJECTED';
    reviewerId: string;
    comment?: string;
    at: string;
  }>;
}

export interface ProjectDocumentSummaryRecord {
  id: string;
  projectId: string;
  taskId?: string;
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
  versions: Array<
    Pick<DocumentVersionRecord, 'version' | 'status' | 'createdAt' | 'editedBy'>
  >;
  reviewHistory: DocumentVersionRecord['reviewHistory'];
}

export interface WorkReportRecord extends WorkReportInput {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string;
  frequency: WorkReportFrequency;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  status: WorkReportStatus;
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
  frequency: WorkReportFrequency;
  effectiveAt: string;
  nextEffectiveAt?: string;
  updatedBy: string;
  history: Array<{
    frequency: WorkReportFrequency;
    effectiveAt: string;
    updatedBy: string;
  }>;
  permissions: Pick<WorkNotesPermissions, 'canConfigure'>;
}
