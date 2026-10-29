import {
  ASSESSMENT_SYSTEM_PROMPT,
  ASSESSMENT_OUTPUT_CONTRACT,
  selectAssessmentExamples,
  assessmentPurposePolicy,
} from './work-note-assessment.prompt';
import { createHash } from 'node:crypto';
import { assessmentRequestContext } from './work-note-assessment.context';
import {
  hasNegation as negative,
  dropsSourceNegation,
  coveragePolarityConflict,
} from './work-note-assessment.polarity';
import type { AgentMessage } from './work-note-agent.types';
import {
  ASSESSMENT_PURPOSES,
  type AssessmentModelInput,
  type AssessmentModelOutput,
  type SourceRef,
} from './work-note-assessment.types';

export const ASSESSMENT_PROMPT_VERSION = 'task-note-assessment/2026-10-29.v13';
export const assessmentHash = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const invalid = (message = 'Assessment output is invalid.') => {
  throw new Error(message);
};
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s.!?]+/g, ' ')
    .trim();
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid();
  const o = v as Record<string, unknown>;
  if (
    Object.keys(o).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(o, k))
  )
    return invalid(`SCHEMA_KEYS_${keys[0].toUpperCase()}`);
  return o;
}
function str(v: unknown, max = 2000, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()))
    return invalid('INVALID_STRING');
  return v;
}
function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) return invalid('INVALID_LIST');
  return v;
}
function en<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T))
    return invalid('INVALID_ENUM');
  return v as T;
}
export function assertAssessmentFidelity(source: string, result: string) {
  // Deliberately conservative guard for changes to explicit uncertainty. It is
  // not a general NLI model or independent verification of authors' claims.
  const limits = [
    /(?:chưa|không)\s+(?:được\s+)?(?:kiểm\s*thử|test|deploy|triển khai|xác minh|xác định)/giu,
    /\b(?:not|never)\s+(?:been\s+|yet\s+)?(?:tested|deployed|verified|confirmed)\b/giu,
    /\b(?:untested|unverified|unknown)\b/giu,
  ];
  for (const p of limits)
    for (const m of source.matchAll(p))
      if (!normalize(result).includes(normalize(m[0])))
        invalid('Rewrite removed explicit uncertainty; revise manually.');
}
export function buildAssessmentMessages(
  input: AssessmentModelInput,
): AgentMessage[] {
  if (
    input.sources.some((s) => s.loadStatus !== 'LOADED' || !s.includedInRequest)
  )
    invalid('CONTEXT_UNAVAILABLE');
  const correctionTarget =
    input.correction &&
    input.previous &&
    [...input.previous.claims, ...input.previous.gaps].find(
      (x) => x.id === input.correction!.targetId,
    );
  const targetContext = !correctionTarget
    ? null
    : 'text' in correctionTarget
      ? {
          targetType: 'CLAIM',
          text: correctionTarget.text,
          sourceRefs: correctionTarget.sourceRefs,
          originKind: correctionTarget.originKind,
          supportRelation: correctionTarget.supportRelation,
        }
      : {
          targetType: 'GAP',
          kind: correctionTarget.kind,
          target: correctionTarget.target,
          owner: correctionTarget.owner,
          impact: correctionTarget.impact,
          sourceRefs: correctionTarget.sourceRefs,
        };
  const previous = input.previous
    ? {
        purpose: input.previous.purpose,
        gaps: input.previous.gaps,
        counters: input.previous.counters,
        ...(input.correction
          ? {
              correctionTarget: targetContext,
            }
          : {}),
      }
    : null;
  const payload = {
    sources: input.sources,
    purpose: input.purpose,
    answers: input.answers,
    previous,
    correction: input.correction ?? null,
    assessmentPolicy: assessmentPurposePolicy(input.purpose),
    outputContract: ASSESSMENT_OUTPUT_CONTRACT,
    ...assessmentRequestContext(input),
  };
  if (JSON.stringify(payload).length > 65000) {
    payload.requirementPassages = [];
    payload.authorPassages = [];
    payload.authorLimitPassages = [];
    payload.passageAidsComplete = false;
  }
  if (JSON.stringify(payload).length > 65000) invalid('CONTEXT_LIMIT');
  return [
    {
      role: 'system',
      content: ASSESSMENT_SYSTEM_PROMPT,
    },
    ...selectAssessmentExamples(input).flatMap((example) => [
      {
        role: 'user' as const,
        content: JSON.stringify({
          ...example.input,
          correction: null,
          assessmentPolicy: assessmentPurposePolicy(example.input.purpose),
          ...assessmentRequestContext(example.input),
        }),
      },
      { role: 'assistant' as const, content: JSON.stringify(example.output) },
    ]),
    { role: 'user', content: JSON.stringify(payload) },
  ];
}
export function parseAssessmentOutput(
  input: AssessmentModelInput,
  raw: string,
): AssessmentModelOutput {
  if (typeof raw !== 'string' || raw.length > 100000) return invalid();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return invalid('INVALID_JSON');
  }
  const o = object(json, [
    'purpose',
    'taskUnderstanding',
    'claims',
    'coverage',
    'gaps',
    'taskContextStatus',
    'noteAdequacy',
    'nextQuestion',
  ]);
  const refs = (v: unknown, required = true): SourceRef[] => {
    const r = list(v, 8).map((x) => {
      const q = object(x, ['sourceId', 'quote']);
      const sourceId = str(q.sourceId, 160),
        quote = str(q.quote, 2000);
      const source = input.sources.find(
        (s) =>
          s.id === sourceId && s.loadStatus === 'LOADED' && s.includedInRequest,
      );
      if (!source) return invalid('INVALID_SOURCE_REFERENCE');
      if (source.text.includes(quote)) return { sourceId, quote };
      // Resolve capitalization-only variations to the actual source passage.
      // Never repair missing words, punctuation, negation or ambiguous matches.
      const folded = source.text.toLocaleLowerCase();
      const candidate = quote.toLocaleLowerCase();
      const start = folded.indexOf(candidate);
      const exact = source.text.slice(start, start + quote.length);
      if (
        start < 0 ||
        folded.indexOf(candidate, start + 1) >= 0 ||
        exact.toLocaleLowerCase() !== candidate
      )
        return invalid('INVALID_SOURCE_REFERENCE');
      return { sourceId, quote: exact };
    });
    if (required && !r.length) return invalid('MISSING_SOURCE_REFERENCE');
    return r;
  };
  const u = object(o.taskUnderstanding, [
    'objective',
    'scope',
    'requirements',
    'unknowns',
  ]);
  const sourceText = (sourceId: string) =>
    input.sources.find((s) => s.id === sourceId)!.text;
  const taskTitle =
    input.sources.find((s) => s.id === 'task.title')?.text ?? '';
  const requirements = list(u.requirements, 50).map((v) => {
    const x = object(v, ['text', 'sourceRefs']);
    const sourceRefs = refs(x.sourceRefs);
    if (
      sourceRefs.some(
        (r) => !r.sourceId.startsWith('task.') || r.sourceId === 'task.status',
      )
    )
      return invalid('INVALID_REQUIREMENT_SOURCE');
    const text = str(x.text, 2000);
    if (
      sourceRefs.some((r) =>
        dropsSourceNegation(sourceText(r.sourceId), r.quote),
      )
    )
      return invalid('REQUIREMENT_POLARITY_MISMATCH');
    if (!sourceRefs.some((r) => normalize(r.quote) === normalize(text)))
      return invalid('UNSUPPORTED_REQUIREMENT');
    return { text, sourceRefs };
  });
  const claims = list(o.claims, 40).map((v) => {
    const x = object(v, [
      'text',
      'sourceRefs',
      'originKind',
      'supportRelation',
    ]);
    const text = str(x.text),
      sourceRefs = refs(x.sourceRefs);
    const originKind = en(x.originKind, [
      'TASK_REQUIREMENT',
      'AUTHOR_REPORT',
    ] as const);
    if (
      sourceRefs.some((r) =>
        originKind === 'AUTHOR_REPORT'
          ? !r.sourceId.startsWith('note.') && !r.sourceId.startsWith('answer.')
          : !r.sourceId.startsWith('task.') || r.sourceId === 'task.status',
      )
    )
      return invalid('CLAIM_ORIGIN_MISMATCH');
    let supportRelation = en(x.supportRelation, [
      'FULL',
      'PARTIAL',
      'CONTRADICTED',
      'RELATED_ONLY',
      'INSUFFICIENT',
    ] as const);
    if (
      sourceRefs.some((r) =>
        coveragePolarityConflict(
          text,
          sourceText(r.sourceId),
          r.quote,
          taskTitle,
        ),
      ) &&
      !negative(text) &&
      /tested|test|deployed|deploy|verified|kiểm thử|triển khai|xác minh/iu.test(
        text,
      )
    )
      return invalid('SEMANTIC_POLARITY_MISMATCH');
    if (
      supportRelation === 'FULL' &&
      !negative(text) &&
      sourceRefs.some((r) =>
        dropsSourceNegation(sourceText(r.sourceId), r.quote),
      )
    )
      return invalid('SEMANTIC_POLARITY_MISMATCH');
    if (
      supportRelation === 'FULL' &&
      !sourceRefs.some((r) => normalize(r.quote) === normalize(text))
    )
      supportRelation = 'PARTIAL';
    return { text, sourceRefs, originKind, supportRelation };
  });
  const coverage = list(o.coverage, 50).map((v) => {
    const x = object(v, ['requirementIndex', 'status', 'sourceRefs']);
    const i = x.requirementIndex;
    if (
      !Number.isSafeInteger(i) ||
      Number(i) < 0 ||
      Number(i) >= requirements.length
    )
      return invalid('INVALID_COVERAGE_INDEX');
    const sourceRefs = refs(x.sourceRefs, false);
    let status = en(x.status, [
      'SUPPORTED',
      'PARTIAL',
      'NOT_REPORTED',
      'CONTRADICTORY',
      'UNKNOWN',
    ] as const);
    if (
      status === 'SUPPORTED' &&
      (!sourceRefs.length ||
        sourceRefs.some(
          (r) =>
            !r.sourceId.startsWith('note.') &&
            !r.sourceId.startsWith('answer.'),
        ))
    )
      return invalid('REQUIREMENT_IS_NOT_RESULT');
    // Supporting evidence must itself be a fully grounded author claim. The
    // requirement/result relationship remains explicit for semantic review.
    if (
      status === 'SUPPORTED' &&
      (sourceRefs.some((r) =>
        coveragePolarityConflict(
          requirements[Number(i)].text,
          sourceText(r.sourceId),
          r.quote,
          taskTitle,
        ),
      ) ||
        !sourceRefs.every((s) =>
          claims.some(
            (c) =>
              c.originKind === 'AUTHOR_REPORT' &&
              c.supportRelation === 'FULL' &&
              c.sourceRefs.some(
                (r) => r.sourceId === s.sourceId && r.quote.includes(s.quote),
              ),
          ),
        ))
    )
      status = 'PARTIAL';
    return { requirementIndex: Number(i), status, sourceRefs };
  });
  if (new Set(coverage.map((c) => c.requirementIndex)).size !== coverage.length)
    return invalid('DUPLICATE_COVERAGE');
  const gaps = list(o.gaps, 8).map((v) => {
    const x = object(v, ['kind', 'target', 'impact', 'owner', 'sourceRefs']);
    return {
      kind: en(x.kind, [
        'SCOPE',
        'IMPLEMENTATION',
        'RESULT',
        'EVIDENCE',
        'CONTRADICTION',
        'PURPOSE',
      ] as const),
      target: str(x.target, 160),
      impact: en(x.impact, ['BLOCKING', 'OPTIONAL'] as const),
      owner: en(x.owner, ['NOTE_AUTHOR', 'TASK_REQUIREMENT_OWNER'] as const),
      sourceRefs: refs(x.sourceRefs),
    };
  });
  let nextQuestion: AssessmentModelOutput['nextQuestion'] = null;
  if (o.nextQuestion !== null) {
    const q = object(o.nextQuestion, ['gapIndex', 'text', 'reason', 'options']);
    if (
      !Number.isSafeInteger(q.gapIndex) ||
      Number(q.gapIndex) < 0 ||
      Number(q.gapIndex) >= gaps.length
    )
      return invalid('QUESTION_WITHOUT_GAP');
    nextQuestion = {
      gapIndex: Number(q.gapIndex),
      text: str(q.text, 1000),
      reason: str(q.reason, 1000),
      options: list(q.options, 4).map((s) => str(s, 300)),
    };
  }
  const purpose = en(o.purpose, ASSESSMENT_PURPOSES);
  if (purpose === 'AUTO') return invalid('UNRESOLVED_PURPOSE');
  if (input.purpose !== 'AUTO' && purpose !== input.purpose)
    return invalid('PURPOSE_CHANGED');
  return {
    purpose,
    taskUnderstanding: {
      objective: str(u.objective, 2000, true),
      scope: str(u.scope, 2000, true),
      requirements,
      unknowns: list(u.unknowns, 12).map((v) => str(v, 1000)),
    },
    claims,
    coverage,
    gaps,
    taskContextStatus: en(o.taskContextStatus, [
      'CLEAR',
      'PARTIAL',
      'INSUFFICIENT',
    ] as const),
    noteAdequacy: en(o.noteAdequacy, [
      'ENOUGH_FOR_PURPOSE',
      'NEEDS_AUTHOR_INPUT',
      'UNDETERMINED',
      'CONTRADICTORY',
    ] as const),
    nextQuestion,
  };
}

/** Explicit structural recovery only: a missing options list means free-text input.
 * No source, question text, status, requirement or adequacy is created or repaired.
 */
export function parseAssessmentCompletion(
  input: AssessmentModelInput,
  raw: string,
  recoveryEnabled: boolean,
): { result: AssessmentModelOutput; formattingRecovery: readonly string[] } {
  try {
    return {
      result: parseAssessmentOutput(input, raw),
      formattingRecovery: [],
    };
  } catch (error) {
    if (!recoveryEnabled || typeof raw !== 'string' || raw.length > 100000)
      throw error;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw error;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw error;
    const q = value.nextQuestion;
    if (
      !q ||
      typeof q !== 'object' ||
      Array.isArray(q) ||
      Object.hasOwn(q, 'options') ||
      Object.keys(q).length !== 3 ||
      !['gapIndex', 'text', 'reason'].every((k) => Object.hasOwn(q, k))
    )
      throw error;
    return {
      result: parseAssessmentOutput(
        input,
        JSON.stringify({ ...value, nextQuestion: { ...q, options: [] } }),
      ),
      formattingRecovery: ['nextQuestion.options'],
    };
  }
}
