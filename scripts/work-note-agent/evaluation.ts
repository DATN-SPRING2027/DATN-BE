import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentValidationError,
  applySuggestion,
  parseAgentResult,
  validateAgentInput,
  type PreparedAgentRequest,
} from '../../src/services/capture/application/work-note-agent/work-note-agent';
import { hasNegation } from '../../src/services/capture/application/work-note-agent/work-note-assessment.polarity';
import type {
  AgentInput,
  AgentResult,
} from '../../src/services/capture/application/work-note-agent/work-note-agent.types';

export type EvalSplit = 'development' | 'validation' | 'holdout';
export type RewriteCorpusName =
  'baseline' | 'v2' | 'v3' | 'workflows-v1' | 'editor-nochange-v1';

export type EvalCase = Readonly<{
  id: string;
  category: string;
  split: EvalSplit;
  synthetic: true;
  workflow?: AgentInput['workflow'];
  input: AgentInput;
  expected: Readonly<{
    status: AgentResult['status'];
    mustInclude: readonly string[];
    mustNotInclude: readonly string[];
    mustMatch?: readonly string[];
    manualRubric: string;
    acceptedBehaviors?: readonly string[];
    prohibitedBehaviors?: readonly string[];
    critical?: boolean;
  }>;
}>;
export type Corpus = Readonly<{
  version: string;
  classification: 'synthetic-only';
  splitPolicy: string;
  cases: readonly EvalCase[];
}>;
export type CaseDiagnostics = Readonly<{
  workflow: AgentInput['workflow'];
  clarificationFP: boolean;
  clarificationFN: boolean;
  polarityFailure: boolean;
  markerFailure: boolean;
  emptyChangeSummaryAccepted: boolean;
  emptyChangeSummaryRejected: boolean;
}>;
export type CaseGrade = Readonly<{
  syntaxValid: boolean;
  boundaryAccepted: boolean;
  automatedPass: boolean;
  actualStatus: AgentResult['status'] | null;
  failures: readonly string[];
  manualReview: 'required';
  result: AgentResult | null;
  diagnostics?: CaseDiagnostics;
}>;
const statuses = ['ANSWER', 'CLARIFICATION_REQUIRED', 'SUGGESTION_READY'];

export function loadCorpus(name: RewriteCorpusName = 'baseline'): Corpus {
  if (
    !['baseline', 'v2', 'v3', 'workflows-v1', 'editor-nochange-v1'].includes(
      name,
    )
  )
    throw new Error('Unknown bundled corpus.');
  const expected =
    name === 'workflows-v1'
      ? { total: 32, development: 16, validation: 8, holdout: 8 }
      : name === 'editor-nochange-v1'
        ? { total: 12, development: 4, validation: 4, holdout: 4 }
        : name === 'v3'
          ? { total: 60, development: 30, validation: 10, holdout: 20 }
          : name === 'v2'
            ? { total: 42, development: 21, validation: 7, holdout: 14 }
            : { total: 120, development: 70, validation: 25, holdout: 25 };
  const fileName =
    name === 'baseline'
      ? 'cases.json'
      : name === 'workflows-v1'
        ? 'cases-rewrite-workflows-v1.json'
        : `cases-${name}.json`;
  const rawCorpus = JSON.parse(
    readFileSync(resolve(__dirname, fileName), 'utf8'),
  ) as Corpus;
  const rawCases: readonly EvalCase[] = Array.isArray(rawCorpus?.cases)
    ? (rawCorpus.cases as readonly EvalCase[])
    : [];
  const normalizedCases: readonly EvalCase[] = rawCases.map((c: EvalCase) => {
    if (c.workflow && c.input?.workflow && c.workflow !== c.input.workflow) {
      throw new Error('Case top-level workflow disagrees with input.workflow.');
    }
    const effectiveWorkflow = c.workflow ?? c.input?.workflow ?? 'TASK_NOTE';
    return {
      ...c,
      workflow: effectiveWorkflow,
      input: { ...c.input, workflow: effectiveWorkflow },
    };
  });
  const corpus: Corpus = { ...rawCorpus, cases: normalizedCases };
  if (
    corpus.classification !== 'synthetic-only' ||
    corpus.cases.length !== expected.total ||
    new Set(corpus.cases.map((c: EvalCase) => c.id)).size !== expected.total
  )
    throw new Error('Invalid bundled synthetic corpus.');
  const counts = { development: 0, validation: 0, holdout: 0 };
  for (const c of corpus.cases) {
    if (
      c.synthetic !== true ||
      !/^[a-z0-9-]+-\d{3}$/.test(c.id) ||
      !Object.hasOwn(counts, c.split) ||
      !statuses.includes(c.expected.status) ||
      !Array.isArray(c.expected.mustInclude) ||
      !Array.isArray(c.expected.mustNotInclude) ||
      !c.expected.manualRubric
    )
      throw new Error('Invalid synthetic evaluation case.');
    if (
      (name === 'v3' ||
        name === 'workflows-v1' ||
        name === 'editor-nochange-v1') &&
      (!c.expected.acceptedBehaviors?.length ||
        !c.expected.prohibitedBehaviors?.length ||
        [
          ...c.expected.acceptedBehaviors,
          ...c.expected.prohibitedBehaviors,
        ].some((v) => typeof v !== 'string' || !v.trim()))
    )
      throw new Error('Behavior-based human review rubric is required.');
    counts[c.split]++;
    validateAgentInput(c.input);
  }
  if (
    counts.development !== expected.development ||
    counts.validation !== expected.validation ||
    counts.holdout !== expected.holdout
  )
    throw new Error(
      'Corpus split changed; review leakage and update the protocol explicitly.',
    );
  return corpus;
}

export function gradeCompletion(
  c: EvalCase,
  prepared: PreparedAgentRequest,
  raw: string,
): CaseGrade {
  let syntaxValid = false;
  try {
    JSON.parse(raw);
    syntaxValid = true;
  } catch {
    /* Separate syntax from semantic checks. */
  }
  const workflow = c.workflow ?? c.input.workflow;
  let result: AgentResult;
  try {
    result = parseAgentResult(prepared, raw);
  } catch (error) {
    const code =
      error instanceof AgentValidationError
        ? error.code
        : 'UNEXPECTED_VALIDATION_ERROR';
    const emptyChangeSummaryRejected =
      error instanceof AgentValidationError &&
      error.message.startsWith('REWRITE_EMPTY_CHANGE_SUMMARY');
    return {
      syntaxValid,
      boundaryAccepted: false,
      automatedPass: false,
      actualStatus: null,
      failures: emptyChangeSummaryRejected
        ? [code, 'REWRITE_EMPTY_CHANGE_SUMMARY']
        : [code],
      manualReview: 'required',
      result: null,
      diagnostics: {
        workflow,
        clarificationFP: false,
        clarificationFN: c.expected.status === 'CLARIFICATION_REQUIRED',
        polarityFailure: false,
        markerFailure: code === 'PROTECTED_CONTENT_CHANGED',
        emptyChangeSummaryAccepted: false,
        emptyChangeSummaryRejected,
      },
    };
  }
  const failures: string[] = [];
  if (result.status !== c.expected.status)
    failures.push(`STATUS_EXPECTED_${c.expected.status}`);
  const candidate = result.suggestion
    ? c.input.operation === 'title'
      ? (result.suggestion.suggestedTitle ?? '')
      : (result.suggestion.replacementText ?? '')
    : [
        result.message,
        ...result.questions.map((q) => `${q.text} ${q.reason}`),
      ].join('\n');
  const normalized = candidate.normalize('NFKC').toLowerCase();
  for (const [index, text] of c.expected.mustInclude.entries())
    if (!normalized.includes(text.normalize('NFKC').toLowerCase()))
      failures.push(`MISSING_REQUIRED_TEXT_${index}`);
  for (const [index, text] of c.expected.mustNotInclude.entries())
    if (normalized.includes(text.normalize('NFKC').toLowerCase()))
      failures.push(`FORBIDDEN_CLAIM_${index}`);
  for (const [index, pattern] of (c.expected.mustMatch ?? []).entries())
    if (!new RegExp(pattern, 'iu').test(candidate))
      failures.push(`MISSING_REQUIRED_PATTERN_${index}`);
  if (result.suggestion && c.input.scope === 'selection') {
    const applied = applySuggestion(c.input.draft, result.suggestion);
    const anchor = c.input.selection!;
    const expectedBody =
      c.input.draft.body.slice(0, anchor.start) +
      result.suggestion.replacementText +
      c.input.draft.body.slice(anchor.end);
    if (applied.body !== expectedBody || applied.title !== c.input.draft.title)
      failures.push('SELECTION_SCOPE_CHANGED');
  }
  const sourceTarget =
    c.input.scope === 'selection' && c.input.selection
      ? c.input.selection.quote
      : c.input.draft.body;
  const droppedNegation =
    Boolean(result.suggestion?.replacementText) &&
    hasNegation(sourceTarget) &&
    !hasNegation(result.suggestion!.replacementText!);
  return {
    syntaxValid,
    boundaryAccepted: true,
    automatedPass: failures.length === 0,
    actualStatus: result.status,
    failures,
    manualReview: 'required',
    result,
    diagnostics: {
      workflow,
      clarificationFP:
        result.status === 'CLARIFICATION_REQUIRED' &&
        c.expected.status !== 'CLARIFICATION_REQUIRED',
      clarificationFN:
        c.expected.status === 'CLARIFICATION_REQUIRED' &&
        result.status !== 'CLARIFICATION_REQUIRED',
      polarityFailure:
        droppedNegation ||
        failures.some((f) => f.startsWith('FORBIDDEN_CLAIM_')),
      markerFailure: false,
      emptyChangeSummaryAccepted: Boolean(
        result.suggestion && result.suggestion.changeSummary.length === 0,
      ),
      emptyChangeSummaryRejected: false,
    },
  };
}

export function percentile(
  values: readonly number[],
  p: number,
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
