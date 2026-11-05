import {
  CANONICAL_ASSESSMENT_INPUT,
  computeCurrentPromptFingerprints,
  loadPromptFingerprints,
} from './prompt-fingerprint.fixtures';
import {
  ASSESSMENT_PROMPT_VERSION,
  assessmentHash,
  buildAssessmentMessages,
} from './work-note-assessment.protocol';
import { ASSESSMENT_PURPOSES } from './work-note-assessment.types';

describe('Work Note Agent prompt fingerprint guard (D1 / F3)', () => {
  const recorded = loadPromptFingerprints();
  const current = computeCurrentPromptFingerprints();

  it('has schemaVersion 1 and exact key parity between recorded and computed prompt surfaces', () => {
    expect(recorded.schemaVersion).toBe(1);
    expect(Object.keys(current).sort()).toEqual(
      Object.keys(recorded.surfaces).sort(),
    );
  });

  it.each(Object.entries(current))(
    'prompt surface %s matches its recorded fingerprint',
    (surfaceKey, computedHash) => {
      expect(recorded.surfaces[surfaceKey]).toBe(computedHash);
    },
  );

  it('detects even a 1-character prompt template change when prompt version is not bumped', () => {
    const mutatedMessagesPerPurpose = ASSESSMENT_PURPOSES.map(
      (purpose, idx) => {
        const msgs = buildAssessmentMessages({
          ...CANONICAL_ASSESSMENT_INPUT,
          purpose,
        }).slice(0, -1);
        if (idx === 0) {
          return [
            { ...msgs[0], content: `${msgs[0].content}.` },
            ...msgs.slice(1),
          ];
        }
        return msgs;
      },
    );
    const driftedHash = assessmentHash(mutatedMessagesPerPurpose);
    expect(driftedHash).not.toBe(recorded.surfaces[ASSESSMENT_PROMPT_VERSION]);
  });
});
