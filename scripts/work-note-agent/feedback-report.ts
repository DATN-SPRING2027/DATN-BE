import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aggregateFeedbackTelemetry,
  type AssessmentFeedbackRecord,
} from '../../src/services/capture/application/work-note-agent/work-note-feedback-telemetry';

/**
 * Offline privacy-safe feedback aggregator (D6 / F9).
 * Reads exported zero-content `work_note_assessment_feedback` JSON records
 * (never note text, task text, or user identities) and groups recurring
 * `promptVersion × purpose × category` patterns (>= threshold distinct assessments)
 * that warrant authoring a new synthetic development scenario.
 */
if (require.main === module) {
  const inputArg = process.argv[2];
  const thresholdArg = Number(process.argv[3] ?? '3');
  if (!inputArg) {
    process.stdout.write(
      `${JSON.stringify(
        aggregateFeedbackTelemetry([], thresholdArg),
        null,
        2,
      )}\n`,
    );
  } else {
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), inputArg), 'utf8'),
    ) as AssessmentFeedbackRecord[];
    process.stdout.write(
      `${JSON.stringify(
        aggregateFeedbackTelemetry(raw, thresholdArg),
        null,
        2,
      )}\n`,
    );
  }
}
