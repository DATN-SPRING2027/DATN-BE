import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AgentValidationError,
  applySuggestion,
  parseAgentResult,
  validateAgentInput,
  type PreparedAgentRequest,
} from '../../src/services/capture/application/work-note-agent/work-note-agent';
import type {
  AgentInput,
  AgentResult,
} from '../../src/services/capture/application/work-note-agent/work-note-agent.types';

export type EvalSplit = 'development' | 'validation' | 'holdout';
export type EvalCase = Readonly<{
  id: string;
  category: string;
  split: EvalSplit;
  synthetic: true;
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
export type CaseGrade = Readonly<{
  syntaxValid: boolean;
  boundaryAccepted: boolean;
  automatedPass: boolean;
  actualStatus: AgentResult['status'] | null;
  failures: readonly string[];
  manualReview: 'required';
  result: AgentResult | null;
}>;
const statuses = ['ANSWER', 'CLARIFICATION_REQUIRED', 'SUGGESTION_READY'];

export function loadCorpus(
  name: 'baseline' | 'v2' | 'v3' = 'baseline',
): Corpus {
  if (!['baseline', 'v2', 'v3'].includes(name))
    throw new Error('Unknown bundled corpus.');
  const expected =
    name === 'v3'
      ? { total: 60, development: 30, validation: 10, holdout: 20 }
      : name === 'v2'
        ? { total: 42, development: 21, validation: 7, holdout: 14 }
        : { total: 120, development: 70, validation: 25, holdout: 25 };
  const corpus = JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        name === 'baseline' ? 'cases.json' : `cases-${name}.json`,
      ),
      'utf8',
    ),
  ) as Corpus;
  if (
    corpus.classification !== 'synthetic-only' ||
    !Array.isArray(corpus.cases) ||
    corpus.cases.length !== expected.total ||
    new Set(corpus.cases.map((c: EvalCase) => c.id)).size !== expected.total
  )
    throw new Error('Invalid bundled synthetic corpus.');
  const counts = { development: 0, validation: 0, holdout: 0 };
  for (const c of corpus.cases as readonly EvalCase[]) {
    if (
      c.synthetic !== true ||
      !/^[a-z-]+-\d{3}$/.test(c.id) ||
      !Object.hasOwn(counts, c.split) ||
      !statuses.includes(c.expected.status) ||
      !Array.isArray(c.expected.mustInclude) ||
      !Array.isArray(c.expected.mustNotInclude) ||
      !c.expected.manualRubric
    )
      throw new Error('Invalid synthetic evaluation case.');
    if (
      name === 'v3' &&
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
  let result: AgentResult;
  try {
    result = parseAgentResult(prepared, raw);
  } catch (error) {
    const code =
      error instanceof AgentValidationError
        ? error.code
        : 'UNEXPECTED_VALIDATION_ERROR';
    return {
      syntaxValid,
      boundaryAccepted: false,
      automatedPass: false,
      actualStatus: null,
      failures: [code],
      manualReview: 'required',
      result: null,
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
  return {
    syntaxValid,
    boundaryAccepted: true,
    automatedPass: failures.length === 0,
    actualStatus: result.status,
    failures,
    manualReview: 'required',
    result,
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
