import { UnprocessableEntityException } from '@nestjs/common';
import { positive, uuidInput } from './work-note-agent-drafts.validation';
import {
  ASSESSMENT_PURPOSES,
  type AssessmentPurpose,
} from './work-note-assessment.types';
const bad = () => {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Invalid assessment request.',
  });
};
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) return bad();
  return v;
}
function purpose(v: unknown): AssessmentPurpose {
  if (
    typeof v !== 'string' ||
    !(ASSESSMENT_PURPOSES as readonly string[]).includes(v)
  )
    return bad();
  return v as AssessmentPurpose;
}
type Kind =
  | 'assess'
  | 'reply'
  | 'rewrite'
  | 'correct'
  | 'reset'
  | 'validate'
  | 'feedback';
export function parseAssessmentRequest(kind: Kind, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  const v = raw as Record<string, unknown>;
  const fields = [
    'operationId',
    'expectedRevision',
    ...(kind === 'assess' ? ['purpose'] : ['expectedAssessmentRevision']),
    ...(kind === 'reply'
      ? ['gapId', 'questionId', 'disposition', 'answer']
      : kind === 'correct'
        ? ['targetClaimOrGapId', 'correctionText']
        : kind === 'reset'
          ? ['newPurpose', 'carryAnswerIds']
          : kind === 'feedback'
            ? ['category']
            : []),
  ];
  if (Object.keys(v).some((k) => !fields.includes(k))) return bad();
  const base = {
    operationId: uuidInput(v.operationId),
    expectedRevision: positive(v.expectedRevision),
  };
  if (kind === 'assess')
    return { ...base, purpose: purpose(v.purpose ?? 'AUTO') };
  const mutation = {
    ...base,
    expectedAssessmentRevision: positive(v.expectedAssessmentRevision),
  };
  if (kind === 'reply') {
    if (
      typeof v.disposition !== 'string' ||
      !['answered', 'unknown', 'skipped'].includes(v.disposition)
    )
      return bad();
    if (v.disposition !== 'answered' && v.answer !== undefined) return bad();
    return {
      ...mutation,
      gapId: text(v.gapId, 160),
      questionId: uuidInput(v.questionId),
      disposition: v.disposition as 'answered' | 'unknown' | 'skipped',
      ...(v.disposition === 'answered' ? { answer: text(v.answer, 2000) } : {}),
    };
  }
  if (kind === 'correct')
    return {
      ...mutation,
      targetClaimOrGapId: text(v.targetClaimOrGapId, 160),
      correctionText: text(v.correctionText, 2000),
    };
  if (kind === 'reset') {
    if (
      !Array.isArray(v.carryAnswerIds) ||
      v.carryAnswerIds.length > 20 ||
      new Set(v.carryAnswerIds).size !== v.carryAnswerIds.length
    )
      return bad();
    return {
      ...mutation,
      newPurpose: purpose(v.newPurpose),
      carryAnswerIds: v.carryAnswerIds.map(uuidInput),
    };
  }
  if (kind === 'feedback') {
    if (
      typeof v.category !== 'string' ||
      ![
        'UNNECESSARY_QUESTION',
        'MISSING_QUESTION',
        'WRONG_SOURCE',
        'FALSE_SUFFICIENT',
      ].includes(v.category)
    )
      return bad();
    return {
      ...mutation,
      category: v.category as
        | 'UNNECESSARY_QUESTION'
        | 'MISSING_QUESTION'
        | 'WRONG_SOURCE'
        | 'FALSE_SUFFICIENT',
    };
  }
  return mutation;
}
