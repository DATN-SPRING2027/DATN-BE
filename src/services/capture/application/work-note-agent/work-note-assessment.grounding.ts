import type {
  AssessmentModelOutput,
  SourceRef,
} from './work-note-assessment.types';

/** Checks literal evidence provenance, not entailment of a Task requirement. */
export function isCoverageQuoteGrounded(
  evidence: SourceRef,
  claims: ReadonlyArray<AssessmentModelOutput['claims'][number]>,
): boolean {
  const fragments = claims
    .filter(
      (claim) =>
        claim.originKind === 'AUTHOR_REPORT' &&
        claim.supportRelation === 'FULL',
    )
    .flatMap((claim) => claim.sourceRefs)
    .filter((ref) => ref.sourceId === evidence.sourceId)
    .map((ref) => ref.quote);
  if (!evidence.quote.trim()) return false;
  if (fragments.some((quote) => quote.includes(evidence.quote))) return true;

  // A compound quote may join several already grounded author claims. Every
  // non-whitespace character must still be covered, from this same source.
  const intervals: { start: number; end: number }[] = [];
  for (const fragment of fragments) {
    if (!fragment) continue;
    let count = 0;
    for (
      let at = evidence.quote.indexOf(fragment);
      at >= 0;
      at = evidence.quote.indexOf(fragment, at + 1)
    ) {
      if (++count > 64) return false;
      intervals.push({ start: at, end: at + fragment.length });
    }
  }
  intervals.sort((a, b) => a.start - b.start || b.end - a.end);
  let covered = 0;
  for (const interval of intervals) {
    if (
      interval.start > covered &&
      /\S/u.test(evidence.quote.slice(covered, interval.start))
    )
      return false;
    covered = Math.max(covered, interval.end);
    if (covered >= evidence.quote.length) return true;
  }
  return covered > 0 && !/\S/u.test(evidence.quote.slice(covered));
}
