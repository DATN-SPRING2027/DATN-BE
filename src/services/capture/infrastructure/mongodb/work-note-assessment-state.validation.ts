const DAY = 24 * 60 * 60 * 1000;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : Number.NaN;
const positive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Additive storage guard. Runtime validation owns the complete API/semantic contract. */
export function validPrivateAssessmentState(
  state: unknown,
  workflow: string | undefined,
  expiresAt: Date | undefined,
  createdAt: Date | undefined,
): boolean {
  if (!record(state)) return false;
  const assessment = state.assessment;
  if (assessment == null) return true;
  if (workflow && workflow !== 'TASK_NOTE') return false;
  if (!record(assessment)) return false;
  if (
    assessment.schemaVersion !== 'task-note-assessment/v1' ||
    typeof assessment.id !== 'string' ||
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(assessment.id) ||
    !(
      positive(assessment.revision) ||
      (assessment.revision === 0 && assessment.state === 'analyzing')
    ) ||
    !positive(assessment.sourceRevision) ||
    assessment.reviewerSemanticAssessment !== 'NOT_ESTABLISHED' ||
    !Array.isArray(assessment.answers) ||
    !Array.isArray(assessment.trace) ||
    assessment.trace.length > 40
  )
    return false;
  const start = timestamp(assessment.createdAt);
  const end = timestamp(assessment.expiresAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end > start + DAY)
    return false;
  if (expiresAt instanceof Date && end > expiresAt.getTime()) return false;
  if (createdAt instanceof Date && end > createdAt.getTime() + DAY)
    return false;
  const traceKeys = new Set([
    'phase',
    'reasonCode',
    'at',
    'durationMs',
    'promptTokens',
    'completionTokens',
    'httpAttempts',
  ]);
  if (assessment.feedback !== undefined) {
    const categories = [
      'UNNECESSARY_QUESTION',
      'MISSING_QUESTION',
      'WRONG_SOURCE',
      'FALSE_SUFFICIENT',
    ];
    if (
      !Array.isArray(assessment.feedback) ||
      assessment.feedback.length > 20 ||
      assessment.feedback.some(
        (event) =>
          !record(event) ||
          Object.keys(event).some((key) => !['category', 'at'].includes(key)) ||
          !categories.includes(String(event.category)) ||
          !Number.isFinite(timestamp(event.at)),
      )
    )
      return false;
  }
  for (const event of assessment.trace) {
    if (!record(event) || Object.keys(event).some((key) => !traceKeys.has(key)))
      return false;
    if (
      typeof event.phase !== 'string' ||
      typeof event.reasonCode !== 'string' ||
      event.phase.length > 100 ||
      event.reasonCode.length > 100 ||
      !Number.isFinite(timestamp(event.at))
    )
      return false;
  }
  return true;
}

export function withinAbsoluteDraftLifetime(
  expiresAt: Date,
  createdAt?: Date,
): boolean {
  return (
    !(createdAt instanceof Date) ||
    expiresAt.getTime() <= createdAt.getTime() + DAY
  );
}
