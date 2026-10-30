export const ASSESSMENT_PURPOSES = [
  'AUTO',
  'PROGRESS',
  'INCIDENT',
  'DECISION',
  'HANDOVER',
  'COMPLETION',
  'QA',
  'OTHER',
] as const;
export type AssessmentPurpose = (typeof ASSESSMENT_PURPOSES)[number];
export type AssessmentState =
  | 'analyzing'
  | 'waiting_for_answer'
  | 'missing_context'
  | 'contradiction'
  | 'ready_to_edit'
  | 'stale'
  | 'paused'
  | 'error';
export type SourceRef = { sourceId: string; quote: string };
export type AssessmentSource = {
  id: string;
  kind: 'TASK' | 'NOTE' | 'ANSWER';
  label: string;
  text: string;
  version: string;
  loadStatus: 'LOADED' | 'INVALID' | 'UNAVAILABLE';
  includedInRequest: boolean;
};
export type AssessmentClaim = {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
  originKind: 'TASK_REQUIREMENT' | 'AUTHOR_REPORT';
  supportRelation:
    'FULL' | 'PARTIAL' | 'CONTRADICTED' | 'RELATED_ONLY' | 'INSUFFICIENT';
  verificationStatus: 'AUTHOR_REPORTED' | 'NOT_INDEPENDENTLY_VERIFIED';
};
export type AssessmentRequirement = {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
};
export type AssessmentGap = {
  id: string;
  kind:
    | 'SCOPE'
    | 'IMPLEMENTATION'
    | 'RESULT'
    | 'EVIDENCE'
    | 'CONTRADICTION'
    | 'PURPOSE';
  target: string;
  impact: 'BLOCKING' | 'OPTIONAL';
  owner: 'NOTE_AUTHOR' | 'TASK_REQUIREMENT_OWNER';
  status: 'open' | 'answered' | 'unknown' | 'skipped';
  sourceRefs: SourceRef[];
};
export type AssessmentQuestion = {
  id: string;
  gapId: string;
  text: string;
  reason: string;
  options: string[];
};
export type AssessmentAnswer = {
  id: string;
  gapId: string;
  target: string;
  disposition: 'answered' | 'unknown' | 'skipped';
  answer?: string;
  purpose: AssessmentPurpose;
  taskContextHash: string;
};
export type AssessmentView = {
  schemaVersion: 'task-note-assessment/v1';
  id: string;
  revision: number;
  sourceRevision: number;
  taskContextHash: string;
  answerLedgerHash: string;
  purpose: AssessmentPurpose;
  state: AssessmentState;
  contextManifest: {
    acquisitionStatus: 'LOADED' | 'INVALID' | 'UNAVAILABLE' | 'PARTIAL';
    sources: AssessmentSource[];
    sourceCatalogVersion: '1';
  };
  taskUnderstanding: {
    objective: string;
    scope: string;
    requirements: AssessmentRequirement[];
    unknowns: string[];
  };
  claims: AssessmentClaim[];
  coverage: {
    requirementId: string;
    status:
      'SUPPORTED' | 'PARTIAL' | 'NOT_REPORTED' | 'CONTRADICTORY' | 'UNKNOWN';
    sourceRefs: SourceRef[];
  }[];
  gaps: AssessmentGap[];
  nextQuestion: AssessmentQuestion | null;
  taskContextStatus: 'CLEAR' | 'PARTIAL' | 'INSUFFICIENT';
  noteAdequacy:
    | 'ENOUGH_FOR_PURPOSE'
    | 'NEEDS_AUTHOR_INPUT'
    | 'UNDETERMINED'
    | 'CONTRADICTORY';
  counters: { questionCount: number; noProgress: number };
  allowedActions: string[];
  answers: AssessmentAnswer[];
  authorValidated: boolean;
  reviewerSemanticAssessment: 'NOT_ESTABLISHED';
  feedback?: {
    category:
      | 'UNNECESSARY_QUESTION'
      | 'MISSING_QUESTION'
      | 'WRONG_SOURCE'
      | 'FALSE_SUFFICIENT';
    at: string;
  }[];
  signals: {
    proposalApplied: boolean;
    authorValidated: boolean;
    saved: boolean;
    reviewerSemanticAssessment: 'NOT_ESTABLISHED';
  };
  createdAt: string;
  expiresAt: string;
  trace: {
    phase: string;
    reasonCode: string;
    at: string;
    durationMs?: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    httpAttempts?: number;
  }[];
  promptVersion: string;
  model: string;
};
export type AssessmentInput = {
  operationId: string;
  expectedRevision: number;
  purpose: AssessmentPurpose;
};
export type AssessmentMutation = {
  operationId: string;
  expectedRevision: number;
  expectedAssessmentRevision: number;
};
export type AssessmentReply = AssessmentMutation & {
  gapId: string;
  questionId: string;
  disposition: 'answered' | 'unknown' | 'skipped';
  answer?: string;
};
export type AssessmentCorrection = AssessmentMutation & {
  targetClaimOrGapId: string;
  correctionText: string;
};
export type AssessmentReset = AssessmentMutation & {
  newPurpose: AssessmentPurpose;
  carryAnswerIds: string[];
};
export type AssessmentModelInput = {
  sources: AssessmentSource[];
  purpose: AssessmentPurpose;
  previous: AssessmentView | null;
  answers: AssessmentAnswer[];
  correction?: { targetId: string; text: string };
};
export type AssessmentModelOutput = {
  purpose: AssessmentPurpose;
  taskUnderstanding: {
    objective: string;
    scope: string;
    requirements: { text: string; sourceRefs: SourceRef[] }[];
    unknowns: string[];
  };
  claims: Omit<AssessmentClaim, 'id' | 'verificationStatus'>[];
  coverage: {
    requirementIndex: number;
    status:
      'SUPPORTED' | 'PARTIAL' | 'NOT_REPORTED' | 'CONTRADICTORY' | 'UNKNOWN';
    sourceRefs: SourceRef[];
  }[];
  gaps: (Omit<AssessmentGap, 'id' | 'status'> & {
    needCode?: string;
  })[];
  taskContextStatus: AssessmentView['taskContextStatus'];
  noteAdequacy: AssessmentView['noteAdequacy'];
  nextQuestion: {
    gapIndex: number;
    text: string;
    reason: string;
    options: string[];
  } | null;
};
