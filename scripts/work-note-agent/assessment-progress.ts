import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DevelopmentResponseCache } from './assessment-response-cache';
import { evaluationArtifactHash } from './assessment-artifact';
import type { AssessmentEvaluationRow } from './assessment-evaluation';

export function assessmentProgressStatus(row: AssessmentEvaluationRow): string {
  if (row.skipped) return 'UNMEASURED';
  if (row.errorCode?.includes('CACHE_MISS')) return 'CACHE_MISS_NO_HTTP';
  if (row.errorCode?.endsWith('_429')) return 'BLOCKED_QUOTA';
  if (/^XKIRO_HTTP_ERROR_50/u.test(row.errorCode ?? ''))
    return 'BLOCKED_PROVIDER';
  if (/UNCERTAIN_POST|HTTP_JOURNAL_/u.test(row.errorCode ?? ''))
    return 'BLOCKED_UNCERTAIN_POST';
  if (row.errorCode) return 'FAILED_OUTPUT_OR_WORKFLOW';
  if (row.role === 'editor')
    return row.editorValidation?.runtimeProposalAccepted ? 'PASS' : 'FAIL';
  return row.runtimeGrade?.automatedPass
    ? 'PASS'
    : row.output
      ? 'FAIL'
      : 'UNMEASURED';
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const option = (name: string) => {
      const index = args.indexOf(name);
      return index < 0 ? undefined : args[index + 1];
    };
    const root = resolve(process.cwd(), '.worknote-agent-evals');
    mkdirSync(root, { recursive: true });
    const journalFile = option('--import-journal');
    if (journalFile) {
      const artifactHash = option('--origin-artifact') ?? '',
        phaseId = option('--origin-phase') ?? '';
      if (
        !args.includes('--development') ||
        !/^[a-f0-9]{64}$/u.test(artifactHash) ||
        !/^[a-zA-Z0-9_-]*dev[a-zA-Z0-9_-]*$/u.test(phaseId)
      )
        throw Error('EXPLICIT_DEVELOPMENT_IMPORT_PROVENANCE_REQUIRED');
      const bytes = readFileSync(resolve(journalFile));
      const data = JSON.parse(bytes.toString('utf8')) as {
        identity: string;
        entries: Record<
          string,
          { state: string; status?: number; hash: string; body?: string }
        >;
      };
      if (!/^[a-f0-9]{64}$/u.test(data.identity) || !data.entries)
        throw Error('INVALID_DEVELOPMENT_JOURNAL');
      const cache = new DevelopmentResponseCache(
        resolve(root, 'development-response-cache'),
        { artifactHash, phaseId },
      );
      let imported = 0,
        existing = 0,
        excluded = 0;
      for (const [slot, entry] of Object.entries(data.entries)) {
        if (entry.state !== 'complete' || entry.status !== 200 || !entry.body) {
          excluded++;
          continue;
        }
        const policy = {
          timeoutMs: slot.includes(':editor:') ? 60000 : 85000,
          retries: 0,
        };
        if (
          cache.importCompleted(entry.hash, policy, entry.body, {
            artifactHash,
            phaseId,
          })
        )
          imported++;
        else existing++;
      }
      const result = {
        classification:
          'OFFLINE_DEVELOPMENT_CACHE_IMPORT_NOT_NEW_MODEL_EVIDENCE',
        createdAt: new Date().toISOString(),
        journal: journalFile,
        journalSha256: createHash('sha256').update(bytes).digest('hex'),
        originArtifactHash: artifactHash,
        originPhase: phaseId,
        imported,
        existing,
        excluded,
        httpAttempts: 0,
      };
      writeFileSync(
        resolve(root, `cache-import-${randomUUID()}.json`),
        JSON.stringify(result, null, 2),
      );
      console.log(JSON.stringify(result));
    } else {
      const currentArtifactHash = evaluationArtifactHash();
      const latest = new Map<string, Record<string, unknown>>();
      const files = readdirSync(root)
        .filter(
          (file) =>
            /^assessment-v4-.*\.json$/u.test(file) &&
            !file.endsWith('.review.json'),
        )
        .sort();
      for (const file of files) {
        const report = JSON.parse(
          readFileSync(resolve(root, file), 'utf8'),
        ) as {
          createdAt?: string;
          model?: string;
          promptVersion?: string;
          artifactHash?: string;
          corpusHash?: string;
          rows?: AssessmentEvaluationRow[];
          executionEvidence?: string;
        };
        for (const row of report.rows ?? []) {
          const key = [report.model, row.caseId, row.turn, row.role].join('|');
          latest.set(key, {
            model: report.model,
            caseId: row.caseId,
            turn: row.turn,
            role: row.role,
            status: assessmentProgressStatus(row),
            promptVersion: report.promptVersion,
            requestTemplateHash: row.requestTemplateHash,
            gradedArtifactHash: report.artifactHash,
            currentLocalGrade: report.artifactHash === currentArtifactHash,
            nextAction:
              report.artifactHash !== currentArtifactHash &&
              row.rawSyntheticResponse
                ? 'OFFLINE_REPLAY_FIRST'
                : 'KEEP_RECORDED_RESULT',
            responseOrigins: row.responseOrigins,
            evidence: report.executionEvidence ?? 'HISTORICAL_RECORDED_RESULT',
            report: file,
            createdAt: report.createdAt,
          });
        }
      }
      const rows = [...latest.values()],
        counts: Record<string, number> = {};
      for (const row of rows) {
        const status = String(row.status);
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const result = {
        classification: 'PROGRESS_INDEX_NOT_A_POOLED_QUALITY_GATE',
        createdAt: new Date().toISOString(),
        currentArtifactHash,
        reportsScanned: files.length,
        rows: rows.length,
        counts,
        cases: rows,
      };
      writeFileSync(
        resolve(root, 'assessment-progress.json'),
        JSON.stringify(result, null, 2),
      );
      const table = rows
        .map(
          (row) =>
            `| ${String(row.model)} | ${String(row.caseId)}:${String(row.turn)} | ${String(row.status)} | ${row.currentLocalGrade ? 'current' : 'older artifact'} | ${String(row.nextAction)} |`,
        )
        .join('\n');
      writeFileSync(
        resolve(root, 'assessment-progress.md'),
        `# Assessment progress\n\nHistorical results stay immutable. This index does not pool prompt versions or certify release.\n\n| Model | Case:turn | Recorded status | Local grade | Next action |\n|---|---|---|---|---|\n${table}\n`,
      );
      console.log(JSON.stringify({ ...result, cases: undefined }));
    }
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'ASSESSMENT_PROGRESS_FAILED',
    );
    process.exitCode = 1;
  }
}
