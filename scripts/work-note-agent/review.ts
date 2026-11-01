import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadCorpus } from './evaluation';
type ReviewRun = {
  classification: string;
  corpusVersion: string;
  runId: string;
  rows: readonly {
    caseId: string;
    repeat: number;
    errorCode?: string;
    skipped?: boolean;
    output?: unknown;
    syntheticResponse?: string;
  }[];
};
/** Builds a worksheet only; no LLM judge or human verdict is fabricated. */
export function createReviewWorksheet(report: ReviewRun) {
  const corpus = loadCorpus('v3');
  const rows: ReviewRun['rows'] = report.rows;
  if (
    report.classification !== 'synthetic-only' ||
    report.corpusVersion !== corpus.version ||
    !report.runId ||
    !Array.isArray(report.rows)
  )
    throw Error('Only the bundled synthetic v3 corpus is supported');
  const seen = new Set<string>();
  const items = rows.map((row) => {
    const c = corpus.cases.find((c) => c.id === row.caseId),
      slot = `${row.caseId}/${row.repeat}`;
    if (
      !c ||
      !Number.isSafeInteger(row.repeat) ||
      row.repeat < 1 ||
      row.repeat > 3 ||
      seen.has(slot)
    )
      throw Error('Unknown or duplicate synthetic trial');
    seen.add(slot);
    return {
      caseId: c.id,
      repeat: row.repeat,
      split: c.split,
      critical: c.expected.critical === true,
      availability: row.skipped
        ? 'NOT_ATTEMPTED'
        : row.errorCode
          ? 'PROVIDER_FAILURE'
          : 'COMPLETED',
      errorCode: row.errorCode ?? null,
      source: c.input,
      expectedStatus: c.expected.status,
      acceptedBehaviors: c.expected.acceptedBehaviors ?? [],
      prohibitedBehaviors: c.expected.prohibitedBehaviors ?? [],
      output: row.output ?? null,
      syntheticResponse: row.syntheticResponse ?? null,
      ratings: {
        sourceFidelity: null,
        questionNecessity: null,
        questionQuality: null,
        answerUse: null,
        scopeAndTechnicalFidelity: null,
        summaryAccuracy: null,
      },
      reviewer: null,
      reviewedAt: null,
      notes: null,
    };
  });
  return {
    classification: 'synthetic-human-review-worksheet',
    sourceRunId: report.runId,
    semanticAcceptance: 'NOT_ESTABLISHED',
    instructions:
      'A human must review each completed output against its source and behavioral rubric. Rate true/false or N/A with notes; provider failures and unattempted trials are not semantic passes. Keep this synthetic worksheet local.',
    items,
  };
}
if (require.main === module) {
  try {
    const file = process.argv[2];
    if (
      process.argv.length !== 3 ||
      !file ||
      basename(file) !== file ||
      !/^\d{4}-[\w.-]+\.json$/.test(file)
    )
      throw Error(
        'Pass one synthetic report filename from .worknote-agent-evals',
      );
    const root = resolve(__dirname, '../../.worknote-agent-evals');
    const report = JSON.parse(
      readFileSync(resolve(root, file), 'utf8'),
    ) as ReviewRun;
    const worksheet = createReviewWorksheet(report);
    const target = resolve(root, file.replace(/\.json$/, '.review.json'));
    writeFileSync(target, JSON.stringify(worksheet, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        worksheet: target,
        items: worksheet.items.length,
        semanticAcceptance: worksheet.semanticAcceptance,
      }),
    );
  } catch {
    console.error(
      'Synthetic worksheet creation failed; existing reviews are never overwritten.',
    );
    process.exitCode = 1;
  }
}
