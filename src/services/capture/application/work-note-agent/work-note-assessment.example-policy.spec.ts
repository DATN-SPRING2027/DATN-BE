import {
  assessmentSystemPrompt,
  selectAssessmentExamples,
} from './work-note-assessment.prompt';
import { PURPOSE_RUBRIC_TABLE } from './work-note-assessment.rubric';
import { ASSESSMENT_PURPOSES } from './work-note-assessment.types';

describe('Purpose-scoped teaching examples', () => {
  it.each(ASSESSMENT_PURPOSES.filter((p) => p !== 'AUTO'))(
    'teaches only %s rules and allowed blocking needs when that purpose is explicit',
    (purpose) => {
      const examples = selectAssessmentExamples({
        purpose,
        sources: [],
        answers: [],
        previous: null,
      });
      expect(examples.length).toBeGreaterThan(0);
      expect(examples.length).toBeLessThanOrEqual(4);
      for (const example of examples) {
        expect(example.input.purpose).toBe(purpose);
        for (const gap of example.output.gaps.filter(
          (g) => g.impact === 'BLOCKING',
        )) {
          expect(PURPOSE_RUBRIC_TABLE[purpose].allowedBlockingNeeds).toContain(
            gap.needCode,
          );
        }
      }
      const prompt = assessmentSystemPrompt(purpose);
      expect(prompt).toContain(`ALLOWED BLOCKING NEEDS (${purpose}):`);
      for (const other of ASSESSMENT_PURPOSES.filter(
        (p) => p !== 'AUTO' && p !== purpose,
      )) {
        expect(prompt).not.toContain(`ALLOWED BLOCKING NEEDS (${other}):`);
      }
    },
  );

  it('provides every rubric when AUTO must resolve the purpose', () => {
    const prompt = assessmentSystemPrompt('AUTO');
    for (const purpose of ASSESSMENT_PURPOSES.filter((p) => p !== 'AUTO')) {
      expect(prompt).toContain(`ALLOWED BLOCKING NEEDS (${purpose}):`);
    }
  });
});
