import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeCurrentPromptFingerprints } from '../../src/services/capture/application/work-note-agent/prompt-fingerprint.fixtures';

const targetPath = resolve(
  process.cwd(),
  'src/services/capture/application/work-note-agent/prompt-fingerprints.json',
);

const payload = {
  schemaVersion: 1,
  surfaces: computeCurrentPromptFingerprints(),
};

writeFileSync(targetPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(
  `Updated ${Object.keys(payload.surfaces).length} prompt surface fingerprints -> ${targetPath}\n`,
);
