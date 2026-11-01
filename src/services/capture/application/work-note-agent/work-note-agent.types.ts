export const AGENT_OPERATIONS = [
  'grammar',
  'clarify',
  'shorten',
  'restructure',
  'tone',
  'handover',
  'title',
  'custom',
] as const;
export type AgentOperation = (typeof AGENT_OPERATIONS)[number];
export type AgentScope = 'whole_note' | 'selection';
export type DraftSnapshot = Readonly<{
  revision: number;
  title: string;
  body: string;
}>;
export type SelectionAnchor = Readonly<{
  start: number;
  end: number;
  quote: string;
}>;
export type AgentInput = Readonly<{
  operation: AgentOperation;
  scope: AgentScope;
  instruction: string;
  workflow: 'TASK_NOTE' | 'PROJECT_DOCUMENT' | 'WORK_REPORT';
  draft: DraftSnapshot;
  task: null | Readonly<{
    title: string;
    description: string | null;
    status: string;
    steps: readonly Readonly<{ text: string; done: boolean }>[];
  }>;
  selection?: SelectionAnchor;
  includeWholeNoteContext?: boolean;
  protectedRanges?: readonly Readonly<{ start: number; end: number }>[];
  clarifications: readonly Readonly<{
    id: string;
    question: string;
    state: 'answered' | 'skipped';
    answer?: string;
  }>[];
  history: readonly Readonly<{ role: 'user' | 'assistant'; content: string }>[];
}>;
export type AgentMessage = Readonly<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}>;
export type AgentQuestion = Readonly<{
  text: string;
  reason: string;
  options: readonly string[];
}>;
export type BoundSuggestion = Readonly<{
  id: string;
  scope: AgentScope;
  operation: AgentOperation;
  baseRevision: number;
  snapshotHash: string;
  selection?: SelectionAnchor;
  replacementText: string | null;
  suggestedTitle: string | null;
  changeSummary: readonly string[];
  promptVersion: string;
}>;
export type AgentResult = Readonly<{
  status: 'ANSWER' | 'CLARIFICATION_REQUIRED' | 'SUGGESTION_READY';
  message: string;
  suggestion: BoundSuggestion | null;
  questions: readonly AgentQuestion[];
  uncertainties: readonly string[];
}>;
export class AgentValidationError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'INVALID_JSON'
      | 'INVALID_OUTPUT'
      | 'PROTECTED_CONTENT_CHANGED'
      | 'STALE_SUGGESTION',
    message: string,
  ) {
    super(message);
    this.name = 'AgentValidationError';
  }
}
