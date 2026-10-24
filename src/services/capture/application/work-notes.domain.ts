import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';

export const WORK_REPORT_FREQUENCIES = [
  'DAILY',
  'EVERY_3_DAYS',
  'WEEKLY',
] as const;

export type WorkReportFrequency = (typeof WORK_REPORT_FREQUENCIES)[number];

export interface ReportPeriod {
  periodStart: Date;
  periodEnd: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getFrequencyDays(frequency: WorkReportFrequency): number {
  switch (frequency) {
    case 'DAILY':
      return 1;
    case 'EVERY_3_DAYS':
      return 3;
    case 'WEEKLY':
      return 7;
    default:
      throw new UnprocessableEntityException({
        code: 'VALIDATION_FAILED',
        message: 'Unsupported work report frequency.',
      });
  }
}

export function calculateReportPeriod(
  effectiveAt: Date,
  frequency: WorkReportFrequency,
  at: Date,
): ReportPeriod {
  const periodLengthMs = getFrequencyDays(frequency) * DAY_MS;
  const elapsedMs = Math.max(0, at.getTime() - effectiveAt.getTime());
  const offset = Math.floor(elapsedMs / periodLengthMs) * periodLengthMs;
  const periodStart = new Date(effectiveAt.getTime() + offset);
  return {
    periodStart,
    periodEnd: new Date(periodStart.getTime() + periodLengthMs),
  };
}

export function nextFrequencyEffectiveAt(
  effectiveAt: Date,
  frequency: WorkReportFrequency,
  at: Date,
): Date {
  return calculateReportPeriod(effectiveAt, frequency, at).periodEnd;
}

export function assertReviewerCanReview(
  authorId: string,
  reviewerId: string,
  canReview: boolean,
): void {
  if (!canReview) {
    throw new ForbiddenException({
      code: 'PROJECT_REVIEW_PERMISSION_REQUIRED',
      message: 'Project review permission is required.',
    });
  }
  if (authorId === reviewerId) {
    throw new ForbiddenException({
      code: 'SELF_REVIEW_NOT_ALLOWED',
      message: 'Authors cannot review their own work.',
    });
  }
}
