import type {
  AgentInput,
  AgentOperation,
  AgentResult,
  BoundSuggestion,
  SelectionAnchor,
} from './work-note-agent.types';
import type {
  TaskNoteAiChatSource,
  TaskNoteAiChatSourceInput,
} from '../work-notes.types';
export type RevisionOperation = {
  operationId: string;
  expectedRevision: number;
};
export type CreateDraftInput = {
  operationId: string;
  taskId: string;
  noteId?: string;
};
export type UpdateDraftInput = RevisionOperation & {
  title: string;
  contentMarkdown: string;
};
export type MessageInput = RevisionOperation & {
  operation: AgentOperation;
  scope: 'whole_note' | 'selection';
  instruction: string;
  includeWholeNoteContext: boolean;
  selection?: SelectionAnchor;
  replyToQuestionId?: string;
  questionDisposition?: 'answered' | 'skipped';
  answer?: string;
};
export type ApplyInput = RevisionOperation & {
  action:
    'replace_body' | 'replace_selection' | 'insert_after' | 'replace_title';
  applyTitle: boolean;
};
export type SaveInput = RevisionOperation & {
  discardOriginalConfirmed: boolean;
  aiChatSource?: TaskNoteAiChatSourceInput;
};
export type RestoreInput = {
  operationId: string;
  expectedVersion: number;
  versionNumber: number;
};
export type PendingQuestion = AgentResult['questions'][number] & {
  id: string;
  request: MessageInput;
};
export type AgentDraftState = {
  assessment?: import('./work-note-assessment.types').AssessmentView;
  baseNoteHash?: string;
  title: string;
  contentMarkdown: string;
  hasAppliedRewrite: boolean;
  rewriteOriginal?: { title: string; body: string };
  conversation: { role: 'user' | 'assistant'; content: string }[];
  clarifications: AgentInput['clarifications'];
  pendingQuestion: PendingQuestion | null;
  suggestion: BoundSuggestion | null;
  suggestionTaskHash?: string;
  provenance?: Record<string, unknown>;
  suggestionProvenance?: Record<string, unknown>;
  messageTurns: number;
};
export type AgentDraftView = {
  assessment?: import('./work-note-assessment.types').AssessmentView;
  id: string;
  taskId: string;
  noteId: string | null;
  workflow: AgentInput['workflow'];
  resourceId?: string | null;
  context?: Record<string, unknown>;
  baseContentHash?: string;
  baseNoteVersion: number;
  revision: number;
  title: string;
  contentMarkdown: string;
  expiresAt: string;
  hasAppliedRewrite: boolean;
  conversation: AgentDraftState['conversation'];
  pendingQuestion: Omit<PendingQuestion, 'request'> | null;
  suggestion: BoundSuggestion | null;
};
export type CanonicalTaskNote = {
  id: string;
  projectId: string;
  taskId: string;
  authorId: string;
  authorName: string;
  type: 'TASK_NOTE';
  status: 'CONFIRMED';
  title: string;
  contentMarkdown: string;
  contentSchemaVersion: 2;
  currentVersionNumber: number;
  aiChatSource?: TaskNoteAiChatSource;
  createdAt: string;
  updatedAt: string;
  permissions: {
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canSubmit: boolean;
    canReview: boolean;
    canConfigure: boolean;
  };
};
