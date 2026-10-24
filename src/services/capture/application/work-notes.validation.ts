import { UnprocessableEntityException } from '@nestjs/common';
import { WORK_REPORT_FREQUENCIES } from './work-notes.domain';
import type {
  DocumentType,
  ProjectDocumentInput,
  ReviewInput,
  TaskNoteInput,
  WorkReportInput,
} from './work-notes.types';

const objectRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
};

const invalid = (): never => {
  throw new UnprocessableEntityException({
    code: 'VALIDATION_FAILED',
    message: 'Request validation failed.',
  });
};

function assertKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) invalid();
}

function requiredText(value: unknown, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength
  )
    return invalid();
  return value.trim();
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) return invalid();
  return value.trim();
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value))
    return invalid();
  return value.toLowerCase();
}

export function validateTaskNoteInput(value: unknown): TaskNoteInput {
  const record = objectRecord(value);
  assertKeys(record, ['title', 'accomplishments', 'approach', 'reason']);
  return {
    title: requiredText(record.title, 160),
    accomplishments: requiredText(record.accomplishments, 10_000),
    approach: requiredText(record.approach, 10_000),
    reason: requiredText(record.reason, 5_000),
  };
}

const documentTypes: readonly DocumentType[] = [
  'MVP',
  'DATABASE_DESIGN',
  'RSR',
  'ARCHITECTURE',
  'API_SPECIFICATION',
  'RESEARCH',
  'REQUIREMENT',
  'DESIGN',
  'TECHNICAL_SPECIFICATION',
  'OTHER',
];

export function validateProjectDocumentInput(
  value: unknown,
): ProjectDocumentInput {
  const record = objectRecord(value);
  assertKeys(record, ['title', 'description', 'type', 'content', 'taskId']);
  if (!documentTypes.includes(record.type as DocumentType)) return invalid();
  return {
    title: requiredText(record.title, 240),
    ...(record.description === undefined
      ? {}
      : { description: optionalText(record.description, 2_000) ?? '' }),
    type: record.type as DocumentType,
    content: requiredText(record.content, 200_000),
    ...(record.taskId === undefined
      ? {}
      : { taskId: optionalId(record.taskId) }),
  };
}

export function validateWorkReportInput(value: unknown): WorkReportInput {
  const record = objectRecord(value);
  assertKeys(record, [
    'accomplishments',
    'approach',
    'reason',
    'blockers',
    'nextSteps',
  ]);
  return {
    accomplishments: requiredText(record.accomplishments, 10_000),
    approach: requiredText(record.approach, 10_000),
    reason: requiredText(record.reason, 5_000),
    ...(record.blockers === undefined
      ? {}
      : { blockers: optionalText(record.blockers, 5_000) ?? '' }),
    ...(record.nextSteps === undefined
      ? {}
      : { nextSteps: optionalText(record.nextSteps, 5_000) ?? '' }),
  };
}

export function validateReviewInput(
  value: unknown,
  requireComment: boolean,
): ReviewInput {
  const record = objectRecord(value);
  assertKeys(record, ['comment']);
  const comment = optionalText(record.comment, 5_000);
  if (requireComment && !comment) return invalid();
  return comment ? { comment } : {};
}

export function validateReportFrequency(value: unknown) {
  if (
    typeof value !== 'string' ||
    !WORK_REPORT_FREQUENCIES.includes(
      value as (typeof WORK_REPORT_FREQUENCIES)[number],
    )
  )
    return invalid();
  return value as (typeof WORK_REPORT_FREQUENCIES)[number];
}

export function positiveInteger(
  value: unknown,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) return invalid();
  return parsed;
}
