import type {
  AssessmentAnswer,
  AssessmentModelInput,
} from './work-note-assessment.types';

/** Narrow whole-reply recognition, not a general intent or entailment classifier.
 * A mixed reply containing a new fact must not be discarded as "no information".
 */
export function hasNoNewInformation(answer: AssessmentAnswer): boolean {
  if (answer.disposition !== 'answered') return true;
  const text = (answer.answer ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gu, 'd')
    .toLowerCase()
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim();
  return (
    /^(?:(?:toi|minh|em) )?(?:chua|khong) (?:co|biet)(?: them)? (?:thong tin|chi tiet|du lieu|ket qua)(?: moi| bo sung)?(?: ve [^.;!?\n,]+)?$/u.test(
      text,
    ) ||
    /^(?:(?:toi|minh|em) )?(?:chua biet|khong biet|khong ro)$/u.test(text) ||
    /^(?:i (?:do not|don't) have (?:any )?new (?:information|details)(?: about [^.;!?\n,]+)?|i (?:do not|don't) know|unknown)$/u.test(
      text,
    )
  );
}

export function assessmentRequestContext(input: AssessmentModelInput) {
  return {
    // These are extraction aids, not generated or approved acceptance criteria.
    // Full authorized Task sources remain present; candidates are never a summary.
    requirementPassages: input.sources
      .filter(
        (s) =>
          s.kind === 'TASK' && s.id !== 'task.status' && s.id !== 'task.title',
      )
      .flatMap((s) =>
        s.text
          .split(/\r?\n/u)
          .map((quote) => quote.trim())
          .filter((quote) => quote.length > 0 && quote.length <= 2000)
          .map((quote) => ({ sourceId: s.id, quote })),
      ),
    clarificationLedger: input.answers.map((a) => ({
      gapId: a.gapId,
      target: a.target,
      disposition: a.disposition,
      information: hasNoNewInformation(a)
        ? 'NO_NEW_INFORMATION'
        : 'AUTHOR_INPUT',
      mayAskAgain: false,
      sourceRefs:
        input.previous?.gaps.find((g) => g.id === a.gapId)?.sourceRefs ?? [],
    })),
  };
}
