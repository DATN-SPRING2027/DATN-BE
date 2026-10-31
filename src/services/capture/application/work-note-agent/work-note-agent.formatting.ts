/** Optional, explicitly reported compatibility recovery. The strict parser is unchanged.
 * Only absent empty containers are added; no text/status is inferred or rewritten.
 * The recovered JSON must still pass all ordinary branch/protection checks.
 */
export function recoverEmptyContainers(
  raw: string,
): Readonly<{ json: string; addedFields: readonly string[] }> | null {
  if (typeof raw !== 'string' || raw.length > 100_000) return null;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    value = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const allowed = [
    'status',
    'message',
    'suggestion',
    'questions',
    'uncertainties',
  ];
  if (
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    typeof value.message !== 'string' ||
    !Object.hasOwn(value, 'suggestion') ||
    !['ANSWER', 'CLARIFICATION_REQUIRED', 'SUGGESTION_READY'].includes(
      String(value.status),
    )
  )
    return null;
  const addedFields: string[] = [];
  if (!Object.hasOwn(value, 'questions')) {
    if (value.status === 'CLARIFICATION_REQUIRED') return null;
    value.questions = [];
    addedFields.push('questions');
  }
  if (!Object.hasOwn(value, 'uncertainties')) {
    value.uncertainties = [];
    addedFields.push('uncertainties');
  }
  if (!Array.isArray(value.questions) || !Array.isArray(value.uncertainties))
    return null;
  if (
    value.status === 'CLARIFICATION_REQUIRED' &&
    value.questions.length === 1
  ) {
    const question: unknown = value.questions[0];
    if (question && typeof question === 'object' && !Array.isArray(question)) {
      const q = question as Record<string, unknown>;
      if (
        Object.keys(q).length === 2 &&
        typeof q.text === 'string' &&
        typeof q.reason === 'string'
      ) {
        q.options = [];
        addedFields.push('questions[0].options');
      }
    }
  }
  return addedFields.length
    ? { json: JSON.stringify(value), addedFields }
    : null;
}
