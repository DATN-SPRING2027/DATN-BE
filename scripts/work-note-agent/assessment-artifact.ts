import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function evaluationArtifactFiles(root = process.cwd()): string[] {
  const dirs = [
    'scripts/work-note-agent',
    'src/services/capture/application/work-note-agent',
    'src/services/capture/infrastructure/ai',
  ];
  const walk = (rel: string): string[] =>
    readdirSync(resolve(root, rel), { withFileTypes: true }).flatMap(
      (entry) => {
        const path = `${rel}/${entry.name}`;
        return entry.isDirectory()
          ? walk(path)
          : path.endsWith('.ts') && !path.endsWith('.spec.ts')
            ? [path]
            : [];
      },
    );
  return [
    ...dirs.flatMap(walk),
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'nest-cli.json',
    'src/services/capture/application/work-note-agent/prompt-fingerprints.json',
  ].sort();
}

export function evaluationArtifactHash(root = process.cwd()): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        evaluationArtifactFiles(root).map((p) => [
          p,
          createHash('sha256')
            .update(
              readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n'),
            )
            .digest('hex'),
        ]),
      ),
    )
    .digest('hex');
}
