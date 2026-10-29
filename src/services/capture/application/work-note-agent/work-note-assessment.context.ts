import type {
  AssessmentAnswer,
  AssessmentModelInput,
} from './work-note-assessment.types';
import {
  literalAssessmentPassages,
  hasExplicitUncertainty,
} from './work-note-assessment.polarity';

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
  let remaining = 10000;
  let complete = input.sources.every((s) => s.text.length <= 2000);
  const budget = (passages: { sourceId: string; quote: string }[]) =>
    passages.filter((p) => {
      const size = JSON.stringify(p).length;
      if (size > remaining) {
        complete = false;
        return false;
      }
      remaining -= size;
      return true;
    });
  const authorPassages = input.sources
    .filter((s) => s.kind === 'NOTE' || s.kind === 'ANSWER')
    .flatMap((s) =>
      literalAssessmentPassages(s.text).map((quote) => ({
        sourceId: s.id,
        quote,
      })),
    );
  const requirementPassages = budget(
    input.sources
      .filter(
        (s) =>
          s.kind === 'TASK' && s.id !== 'task.status' && s.id !== 'task.title',
      )
      .flatMap((s) =>
        literalAssessmentPassages(s.text).map((quote) => ({
          sourceId: s.id,
          quote,
        })),
      ),
  );
  const selectedAuthorPassages = budget(authorPassages);
  const authorLimitPassages = budget(
    authorPassages.filter((p) => hasExplicitUncertainty(p.quote)),
  );
  return {
    // These are extraction aids, not generated or approved acceptance criteria.
    // Full authorized Task sources remain present; candidates are never a summary.
    requirementPassages,
    authorPassages: selectedAuthorPassages,
    authorLimitPassages,
    passageAidsComplete: complete,
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
