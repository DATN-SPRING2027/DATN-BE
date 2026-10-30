import { randomUUID } from 'node:crypto';
import type {
  AgentInput,
  AgentMessage,
  AgentResult,
} from './work-note-agent.types';
import { parseRewriteCompletion } from './work-note-agent.completion';
import {
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  assertAssessmentEditorProposal,
  buildAssessmentEditorInput,
  prepareAssessmentEditorRequest,
} from './work-note-assessment-editor';
import {
  ASSESSMENT_PROMPT_VERSION,
  assessmentHash,
  buildAssessmentMessages,
  parseAssessmentCompletion,
} from './work-note-assessment.protocol';
import {
  SPLIT_ASSESSMENT_PROMPT_VERSION,
  TASK_INTERPRETER_PROMPT_VERSION,
  buildTaskAssessorMessages,
  buildTaskInterpreterMessages,
  parseTaskAssessorCompletion,
  parseTaskInterpreterOutput,
  type TaskInterpreterOutput,
} from './work-note-assessment-split';
import { assembleAssessment } from './work-note-assessment.state';
import type {
  AssessmentAnswer,
  AssessmentModelInput,
  AssessmentModelOutput,
  AssessmentPurpose,
  AssessmentSource,
  AssessmentView,
} from './work-note-assessment.types';

export type AssessmentArchitecture = 'combined' | 'split';

export type AssessmentTaskSnapshot = {
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly steps: readonly { readonly text: string; readonly done: boolean }[];
};

export type AssessmentNoteSnapshot = {
  readonly revision: number;
  readonly title: string;
  readonly contentMarkdown: string;
};

export type AssessmentPipelineErrorCode =
  | 'ASSESSMENT_CONTEXT_INVALID'
  | 'ASSESSMENT_STALE'
  | 'VALIDATION_FAILED'
  | 'ASSESSMENT_CONTEXT_LIMIT'
  | 'CONTEXT_UNAVAILABLE';

export class AssessmentPipelineError extends Error {
  constructor(
    public readonly code: AssessmentPipelineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssessmentPipelineError';
  }
}

export type RawPipelineCompletion = {
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  attempts?: number;
  elapsedMs?: number;
};

export type AssessmentMessageCompleter = (
  messages: AgentMessage[],
  role: 'analysis' | 'interpreter' | 'assessor' | 'editor',
) => Promise<RawPipelineCompletion>;

export function computeAssessmentTaskHash(params: {
  taskContext: AssessmentTaskSnapshot | null | undefined;
  taskContextVersion?: string;
  taskContextInvalid?: boolean;
}): string {
  return assessmentHash([
    params.taskContext,
    params.taskContextVersion,
    Boolean(params.taskContextInvalid),
  ]);
}

export function extractSnapshotsFromSources(
  sources: readonly AssessmentSource[],
  options?: {
    revision?: number;
    stepDoneByIndex?: readonly boolean[];
  },
): {
  taskContext: AssessmentTaskSnapshot;
  note: AssessmentNoteSnapshot;
  taskContextVersion: string;
} {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const stepSources = sources
    .filter((s) => s.id.startsWith('task.step.'))
    .map((s) => ({
      index: Number(s.id.slice('task.step.'.length)),
      source: s,
    }))
    .sort((a, b) => a.index - b.index);
  const taskVersion =
    byId.get('task.title')?.version ??
    byId.get('task.description')?.version ??
    'synthetic-task';
  const descriptionText = byId.get('task.description')?.text ?? '';
  return {
    taskContext: {
      title: byId.get('task.title')?.text ?? '',
      description: byId.has('task.description') ? descriptionText : null,
      status: byId.get('task.status')?.text ?? 'IN_PROGRESS',
      steps: stepSources.map((entry, idx) => ({
        text: entry.source.text,
        done: options?.stepDoneByIndex?.[idx] ?? false,
      })),
    },
    note: {
      revision: options?.revision ?? 1,
      title: byId.get('note.title')?.text ?? '',
      contentMarkdown: byId.get('note.body')?.text ?? '',
    },
    taskContextVersion: taskVersion,
  };
}

export function buildAssessmentSources(params: {
  taskContext: AssessmentTaskSnapshot | null | undefined;
  taskContextVersion?: string;
  taskContextInvalid?: boolean;
  note: AssessmentNoteSnapshot;
  answers: readonly AssessmentAnswer[];
  sourceOverrides?: readonly AssessmentSource[];
}): AssessmentSource[] {
  if (params.taskContextInvalid || !params.taskContext) {
    throw new AssessmentPipelineError(
      'ASSESSMENT_CONTEXT_INVALID',
      'Task context could not be loaded correctly. This is not missing authored requirements. Retry; your note can still be saved.',
    );
  }
  const t = params.taskContext;
  const h = computeAssessmentTaskHash(params);
  const v = params.taskContextVersion ?? h;
  const overrides = new Map(
    (params.sourceOverrides ?? []).map((s) => [s.id, s]),
  );
  const makeSource = (
    id: string,
    kind: AssessmentSource['kind'],
    label: string,
    text: string,
    version: string,
  ): AssessmentSource => {
    const override = overrides.get(id);
    return {
      id,
      kind,
      label: override?.label ?? label,
      text,
      version: override?.version ?? version,
      loadStatus: override?.loadStatus ?? 'LOADED',
      includedInRequest: override?.includedInRequest ?? true,
    };
  };
  return [
    makeSource('task.title', 'TASK', 'Task title', t.title, v),
    makeSource(
      'task.description',
      'TASK',
      'Task description',
      t.description ?? '',
      v,
    ),
    makeSource(
      'task.status',
      'TASK',
      'Task status (not execution evidence)',
      t.status,
      v,
    ),
    ...t.steps.map((s, i) =>
      makeSource(`task.step.${i}`, 'TASK', `Checklist ${i + 1}`, s.text, v),
    ),
    makeSource(
      'note.title',
      'NOTE',
      'Note title',
      params.note.title,
      String(params.note.revision),
    ),
    makeSource(
      'note.body',
      'NOTE',
      'Note content',
      params.note.contentMarkdown,
      String(params.note.revision),
    ),
    ...params.answers.map((x) =>
      makeSource(
        `answer.${x.id}`,
        'ANSWER',
        `Author clarification: ${x.target}`,
        x.disposition === 'answered' ? (x.answer ?? '') : x.disposition,
        String(params.note.revision),
      ),
    ),
  ];
}

export function validateAssessmentRequestBudget(
  input: AssessmentModelInput,
  architecture: AssessmentArchitecture = 'combined',
): void {
  try {
    if (architecture === 'split') {
      buildTaskInterpreterMessages(input);
      buildTaskAssessorMessages(input, {
        taskContextStatus: 'INSUFFICIENT',
        taskUnderstanding: {
          objective: '',
          scope: '',
          requirements: [],
          unknowns: [],
        },
      });
    } else {
      buildAssessmentMessages(input);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'CONTEXT_UNAVAILABLE') {
      throw new AssessmentPipelineError(
        'CONTEXT_UNAVAILABLE',
        'Task or note context could not be loaded completely.',
      );
    }
    throw new AssessmentPipelineError(
      'ASSESSMENT_CONTEXT_LIMIT',
      'The complete context exceeds the analysis budget. No requirements were silently omitted.',
    );
  }
}

export function prepareInitialAssessmentInput(params: {
  purpose: AssessmentPurpose;
  sourcesBuilder: (answers: AssessmentAnswer[]) => AssessmentSource[];
}): AssessmentModelInput {
  return {
    sources: params.sourcesBuilder([]),
    purpose: params.purpose,
    previous: null,
    answers: [],
  };
}

export function prepareReplyAssessmentInput(params: {
  current: AssessmentView;
  questionId: string;
  gapId: string;
  disposition: 'answered' | 'unknown' | 'skipped';
  answer?: string;
  answerId?: string;
  sourcesBuilder: (answers: AssessmentAnswer[]) => AssessmentSource[];
}): AssessmentModelInput {
  const v = params.current;
  if (
    v.state !== 'waiting_for_answer' ||
    !v.nextQuestion ||
    v.nextQuestion.id !== params.questionId ||
    v.nextQuestion.gapId !== params.gapId
  ) {
    throw new AssessmentPipelineError(
      'ASSESSMENT_STALE',
      'The note, task, purpose or assessment changed. Check information again.',
    );
  }
  const g = v.gaps.find((gap) => gap.id === params.gapId);
  if (!g || v.answers.some((x) => x.gapId === g.id)) {
    throw new AssessmentPipelineError(
      'ASSESSMENT_STALE',
      'The note, task, purpose or assessment changed. Check information again.',
    );
  }
  const nextAnswer: AssessmentAnswer = {
    id: params.answerId ?? randomUUID(),
    gapId: g.id,
    target: g.target,
    disposition: params.disposition,
    ...(params.disposition === 'answered' ? { answer: params.answer } : {}),
    purpose: v.purpose,
    taskContextHash: v.taskContextHash,
  };
  const answers = [...v.answers, nextAnswer];
  if (answers.length > 20) {
    throw new AssessmentPipelineError(
      'VALIDATION_FAILED',
      'Start a new assessment before adding more answers.',
    );
  }
  return {
    sources: params.sourcesBuilder(answers),
    purpose: v.purpose,
    previous: v,
    answers,
  };
}

export function prepareCorrectionAssessmentInput(params: {
  current: AssessmentView;
  targetClaimOrGapId: string;
  correctionText: string;
  answerId?: string;
  sourcesBuilder: (answers: AssessmentAnswer[]) => AssessmentSource[];
}): AssessmentModelInput {
  const v = params.current;
  if (
    ![...v.claims, ...v.gaps].some((c) => c.id === params.targetClaimOrGapId)
  ) {
    throw new AssessmentPipelineError(
      'VALIDATION_FAILED',
      'Correction target is not part of this assessment.',
    );
  }
  const nextAnswer: AssessmentAnswer = {
    id: params.answerId ?? randomUUID(),
    gapId: params.targetClaimOrGapId,
    target: 'author correction',
    disposition: 'answered',
    answer: params.correctionText,
    purpose: v.purpose,
    taskContextHash: v.taskContextHash,
  };
  const answers = [...v.answers, nextAnswer];
  if (answers.length > 20) {
    throw new AssessmentPipelineError(
      'VALIDATION_FAILED',
      'Start a new assessment before adding more corrections.',
    );
  }
  return {
    sources: params.sourcesBuilder(answers),
    purpose: v.purpose,
    previous: v,
    answers,
    correction: {
      targetId: params.targetClaimOrGapId,
      text: params.correctionText,
    },
  };
}

export function prepareResetAssessmentInput(params: {
  current: AssessmentView;
  currentTaskContextHash: string;
  newPurpose: AssessmentPurpose;
  carryAnswerIds: readonly string[];
  sourcesBuilder: (answers: AssessmentAnswer[]) => AssessmentSource[];
}): AssessmentModelInput {
  const v = params.current;
  const answers = params.carryAnswerIds.map((id) => {
    const answer = v.answers.find((item) => item.id === id);
    if (
      !answer ||
      answer.disposition !== 'answered' ||
      answer.taskContextHash !== params.currentTaskContextHash
    ) {
      throw new AssessmentPipelineError(
        'VALIDATION_FAILED',
        'Answer cannot be carried into the new context.',
      );
    }
    if (
      params.newPurpose !== v.purpose &&
      (params.newPurpose === 'QA' ||
        v.purpose === 'QA' ||
        params.newPurpose === 'OTHER' ||
        v.purpose === 'OTHER')
    ) {
      throw new AssessmentPipelineError(
        'VALIDATION_FAILED',
        'Answer relevance is not established for the new purpose.',
      );
    }
    // Carried answers belong to the new session's purpose so novelty/ledger
    // checks do not discard them as cross-purpose leftovers.
    return {
      ...answer,
      purpose: params.newPurpose,
    };
  });
  return {
    sources: params.sourcesBuilder(answers),
    purpose: params.newPurpose,
    previous: null,
    answers,
  };
}

const sumNullable = (
  a: number | null | undefined,
  b: number | null | undefined,
): number | null => {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'number') return a;
  if (typeof b === 'number') return b;
  return null;
};

export async function executeAssessmentModelCall(params: {
  input: AssessmentModelInput;
  architecture?: AssessmentArchitecture;
  formattingRecovery: boolean;
  modelName: string;
  complete: AssessmentMessageCompleter;
  interpreterCache?: Map<string, TaskInterpreterOutput>;
  onStageProgress?: (stage: {
    role: 'analysis' | 'interpreter' | 'assessor';
    requestTemplateHash: string;
    rawResponse?: string;
  }) => void;
}): Promise<{
  result: AssessmentModelOutput;
  rawResponses: string[];
  requestTemplateHashes: string[];
  interpreterCacheHit: boolean;
  provenance: {
    model: string;
    promptVersion: string;
    formattingRecovery: readonly string[];
    promptTokens: number | null;
    completionTokens: number | null;
    httpAttempts: number;
    durationMs: number;
  };
}> {
  const architecture = params.architecture ?? 'combined';
  if (architecture === 'combined') {
    const messages = buildAssessmentMessages(params.input);
    const templateHash = assessmentHash(messages.slice(0, -1));
    params.onStageProgress?.({
      role: 'analysis',
      requestTemplateHash: templateHash,
    });
    const completion = await params.complete(messages, 'analysis');
    params.onStageProgress?.({
      role: 'analysis',
      requestTemplateHash: templateHash,
      rawResponse: completion.content,
    });
    const parsed = parseAssessmentCompletion(
      params.input,
      completion.content,
      params.formattingRecovery,
    );
    return {
      result: parsed.result,
      rawResponses: [completion.content],
      requestTemplateHashes: [templateHash],
      interpreterCacheHit: false,
      provenance: {
        model: params.modelName,
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        formattingRecovery: parsed.formattingRecovery,
        promptTokens: completion.promptTokens ?? null,
        completionTokens: completion.completionTokens ?? null,
        httpAttempts: completion.attempts ?? 1,
        durationMs: completion.elapsedMs ?? 0,
      },
    };
  }

  // Split architecture B: Role 1 Task Interpreter -> Role 2 Assessor / Questioner
  const taskOnlySources = params.input.sources.filter((s) => s.kind === 'TASK');
  const cacheKey = assessmentHash([
    TASK_INTERPRETER_PROMPT_VERSION,
    taskOnlySources,
  ]);
  const rawResponses: string[] = [];
  const requestTemplateHashes: string[] = [];
  let interpretedTask = params.interpreterCache?.get(cacheKey);
  let interpreterCacheHit = Boolean(interpretedTask);
  let interpreterPromptTokens: number | null | undefined = 0;
  let interpreterCompletionTokens: number | null | undefined = 0;
  let interpreterAttempts = 0;
  let interpreterElapsedMs = 0;

  if (!interpretedTask) {
    interpreterCacheHit = false;
    const interpreterMessages = buildTaskInterpreterMessages(params.input);
    const interpreterTemplateHash = assessmentHash(
      interpreterMessages.slice(0, -1),
    );
    requestTemplateHashes.push(interpreterTemplateHash);
    params.onStageProgress?.({
      role: 'interpreter',
      requestTemplateHash: interpreterTemplateHash,
    });
    const interpreterCompletion = await params.complete(
      interpreterMessages,
      'interpreter',
    );
    rawResponses.push(interpreterCompletion.content);
    params.onStageProgress?.({
      role: 'interpreter',
      requestTemplateHash: interpreterTemplateHash,
      rawResponse: interpreterCompletion.content,
    });
    interpretedTask = parseTaskInterpreterOutput(
      params.input,
      interpreterCompletion.content,
    );
    params.interpreterCache?.set(cacheKey, interpretedTask);
    interpreterPromptTokens = interpreterCompletion.promptTokens;
    interpreterCompletionTokens = interpreterCompletion.completionTokens;
    interpreterAttempts = interpreterCompletion.attempts ?? 1;
    interpreterElapsedMs = interpreterCompletion.elapsedMs ?? 0;
  }

  const assessorMessages = buildTaskAssessorMessages(
    params.input,
    interpretedTask,
  );
  const assessorTemplateHash = assessmentHash(assessorMessages.slice(0, -1));
  requestTemplateHashes.push(assessorTemplateHash);
  params.onStageProgress?.({
    role: 'assessor',
    requestTemplateHash: assessorTemplateHash,
  });
  const assessorCompletion = await params.complete(
    assessorMessages,
    'assessor',
  );
  rawResponses.push(assessorCompletion.content);
  params.onStageProgress?.({
    role: 'assessor',
    requestTemplateHash: assessorTemplateHash,
    rawResponse: assessorCompletion.content,
  });
  const parsedAssessor = parseTaskAssessorCompletion(
    params.input,
    interpretedTask,
    assessorCompletion.content,
    params.formattingRecovery,
  );

  return {
    result: parsedAssessor.result,
    rawResponses,
    requestTemplateHashes,
    interpreterCacheHit,
    provenance: {
      model: params.modelName,
      promptVersion: SPLIT_ASSESSMENT_PROMPT_VERSION,
      formattingRecovery: parsedAssessor.formattingRecovery,
      promptTokens: interpreterCacheHit
        ? (assessorCompletion.promptTokens ?? null)
        : sumNullable(interpreterPromptTokens, assessorCompletion.promptTokens),
      completionTokens: interpreterCacheHit
        ? (assessorCompletion.completionTokens ?? null)
        : sumNullable(
            interpreterCompletionTokens,
            assessorCompletion.completionTokens,
          ),
      httpAttempts: interpreterAttempts + (assessorCompletion.attempts ?? 1),
      durationMs: interpreterElapsedMs + (assessorCompletion.elapsedMs ?? 0),
    },
  };
}

export function finalizeAssessmentTurn(params: {
  input: AssessmentModelInput;
  modelResult: AssessmentModelOutput;
  sourceRevision: number;
  taskContextHash: string;
  modelName: string;
  expiresAt: string;
  provisionalId?: string;
  provenance?: {
    promptVersion?: string;
    durationMs?: number;
    promptTokens?: number | null;
    completionTokens?: number | null;
    httpAttempts?: number;
  };
}): AssessmentView {
  const v = assembleAssessment(params.input, params.modelResult, {
    sourceRevision: params.sourceRevision,
    taskContextHash: params.taskContextHash,
    model: params.modelName,
    expiresAt: params.expiresAt,
    ...(params.provenance?.promptVersion
      ? { promptVersion: params.provenance.promptVersion }
      : {}),
  });
  if (!params.input.previous && params.provisionalId) {
    v.id = params.provisionalId;
  }
  if (params.provenance) {
    v.trace = [
      ...v.trace,
      {
        phase: 'analysis',
        reasonCode: 'MODEL_COMPLETED',
        at: new Date().toISOString(),
        ...(params.provenance.durationMs !== undefined
          ? { durationMs: params.provenance.durationMs }
          : {}),
        ...(params.provenance.promptTokens !== undefined
          ? { promptTokens: params.provenance.promptTokens }
          : {}),
        ...(params.provenance.completionTokens !== undefined
          ? { completionTokens: params.provenance.completionTokens }
          : {}),
        ...(params.provenance.httpAttempts !== undefined
          ? { httpAttempts: params.provenance.httpAttempts }
          : {}),
      },
    ].slice(-40);
  }
  return v;
}

export function canRequestAssessmentRewrite(
  view: AssessmentView | null | undefined,
): view is AssessmentView {
  return Boolean(view && view.allowedActions.includes('rewrite'));
}

export function isEligibleForAutomatedEditorEvaluation(
  view: AssessmentView | null | undefined,
): view is AssessmentView {
  return Boolean(
    view &&
    view.noteAdequacy === 'ENOUGH_FOR_PURPOSE' &&
    canRequestAssessmentRewrite(view) &&
    !view.nextQuestion,
  );
}

export async function executeAssessmentEditorCall(params: {
  note: AssessmentNoteSnapshot;
  taskContext: AssessmentTaskSnapshot | null;
  assessment: AssessmentView;
  formattingRecovery: boolean;
  modelName: string;
  complete: AssessmentMessageCompleter;
  onRawResponse?: (rawResponse: string) => void;
}): Promise<{
  editorInput: AgentInput;
  result: AgentResult;
  rawResponse: string;
  formattingRecovery: readonly string[];
  provenance: {
    provider: 'xkiro';
    model: string;
    promptVersion: string;
    formattingRecovery: readonly string[];
    promptTokens: number | null;
    completionTokens: number | null;
    httpAttempts: number;
    durationMs: number;
  };
}> {
  if (!canRequestAssessmentRewrite(params.assessment)) {
    throw new AssessmentPipelineError(
      'ASSESSMENT_STALE',
      'Rewrite proposal is not permitted in the current assessment state.',
    );
  }
  const editorInput = buildAssessmentEditorInput(
    {
      revision: params.note.revision,
      title: params.note.title,
      body: params.note.contentMarkdown,
    },
    params.taskContext,
    params.assessment,
  );
  const prepared = prepareAssessmentEditorRequest(editorInput);
  const completion = await params.complete([...prepared.messages], 'editor');
  params.onRawResponse?.(completion.content);
  const parsed = parseRewriteCompletion(
    prepared,
    completion.content,
    params.formattingRecovery,
  );
  assertAssessmentEditorProposal(editorInput, parsed.result);
  return {
    editorInput,
    result: parsed.result,
    rawResponse: completion.content,
    formattingRecovery: parsed.formattingRecovery,
    provenance: {
      provider: 'xkiro',
      model: params.modelName,
      promptVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
      formattingRecovery: parsed.formattingRecovery,
      promptTokens: completion.promptTokens ?? null,
      completionTokens: completion.completionTokens ?? null,
      httpAttempts: completion.attempts ?? 1,
      durationMs: completion.elapsedMs ?? 0,
    },
  };
}
