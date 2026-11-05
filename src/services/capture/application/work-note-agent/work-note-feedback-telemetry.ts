import { extractGapNeedCode } from './work-note-assessment.rubric';
import type { AssessmentArchitecture } from './work-note-assessment.pipeline';
import type {
  AssessmentPurpose,
  AssessmentView,
} from './work-note-assessment.types';

export const ASSESSMENT_FEEDBACK_COLLECTION = 'work_note_assessment_feedback';

export type AssessmentFeedbackCategory =
  | 'UNNECESSARY_QUESTION'
  | 'MISSING_QUESTION'
  | 'WRONG_SOURCE'
  | 'FALSE_SUFFICIENT';

/**
 * Privacy-safe zero-content feedback record (D6 / F9).
 * Survives the 24-hour TTL of `work_note_agent_drafts` while NEVER storing
 * note text, task text, author answers, titles, or user identifiers.
 */
export type AssessmentFeedbackRecord = Readonly<{
  assessmentId: string;
  promptVersion: string;
  model: string;
  architecture: AssessmentArchitecture;
  purpose: AssessmentPurpose;
  noteAdequacy: AssessmentView['noteAdequacy'];
  category: AssessmentFeedbackCategory;
  openNeedCodes: readonly string[];
  recordedAt: Date;
}>;

export type FeedbackPatternBucket = Readonly<{
  promptVersion: string;
  purpose: AssessmentPurpose;
  category: AssessmentFeedbackCategory;
  count: number;
  distinctAssessments: number;
  topNeedCodes: readonly { needCode: string; count: number }[];
  candidateForSyntheticCase: boolean;
}>;

export type FeedbackTelemetrySummary = Readonly<{
  totalEvents: number;
  recurringThreshold: number;
  buckets: readonly FeedbackPatternBucket[];
  recurringCandidates: readonly FeedbackPatternBucket[];
}>;

export function buildPrivacySafeFeedbackRecord(params: {
  view: AssessmentView;
  category: AssessmentFeedbackCategory;
  architecture: AssessmentArchitecture;
  recordedAt?: Date;
}): AssessmentFeedbackRecord {
  const openNeedCodes = [
    ...new Set(
      params.view.gaps
        .filter((g) => g.status === 'open')
        .map((g) => extractGapNeedCode(g.id))
        .filter((code): code is NonNullable<typeof code> => Boolean(code)),
    ),
  ].slice(0, 14);

  return {
    assessmentId: params.view.id,
    promptVersion: params.view.promptVersion,
    model: params.view.model,
    architecture: params.architecture,
    purpose: params.view.purpose,
    noteAdequacy: params.view.noteAdequacy,
    category: params.category,
    openNeedCodes,
    recordedAt: params.recordedAt ?? new Date(),
  };
}

/**
 * Aggregates zero-content feedback records by `promptVersion × purpose × category`.
 * Per D6, single isolated events do NOT trigger prompt changes; only recurring
 * patterns across >= `recurringThreshold` distinct assessments (default 3) are
 * flagged as candidates for authoring an equivalent synthetic development case.
 */
export function aggregateFeedbackTelemetry(
  records: readonly AssessmentFeedbackRecord[],
  recurringThreshold = 3,
): FeedbackTelemetrySummary {
  const grouped = new Map<
    string,
    {
      promptVersion: string;
      purpose: AssessmentPurpose;
      category: AssessmentFeedbackCategory;
      count: number;
      assessments: Set<string>;
      needCounts: Map<string, number>;
    }
  >();

  for (const rec of records) {
    const key = `${rec.promptVersion}||${rec.purpose}||${rec.category}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        promptVersion: rec.promptVersion,
        purpose: rec.purpose,
        category: rec.category,
        count: 0,
        assessments: new Set<string>(),
        needCounts: new Map<string, number>(),
      };
      grouped.set(key, entry);
    }
    entry.count++;
    entry.assessments.add(rec.assessmentId);
    for (const code of rec.openNeedCodes) {
      entry.needCounts.set(code, (entry.needCounts.get(code) ?? 0) + 1);
    }
  }

  const buckets: FeedbackPatternBucket[] = [...grouped.values()]
    .map((entry) => {
      const distinctAssessments = entry.assessments.size;
      const topNeedCodes = [...entry.needCounts.entries()]
        .map(([needCode, count]) => ({ needCode, count }))
        .sort(
          (a, b) => b.count - a.count || a.needCode.localeCompare(b.needCode),
        );
      return {
        promptVersion: entry.promptVersion,
        purpose: entry.purpose,
        category: entry.category,
        count: entry.count,
        distinctAssessments,
        topNeedCodes,
        candidateForSyntheticCase: distinctAssessments >= recurringThreshold,
      };
    })
    .sort(
      (a, b) =>
        b.distinctAssessments - a.distinctAssessments ||
        b.count - a.count ||
        a.promptVersion.localeCompare(b.promptVersion),
    );

  return {
    totalEvents: records.length,
    recurringThreshold,
    buckets,
    recurringCandidates: buckets.filter((b) => b.candidateForSyntheticCase),
  };
}
