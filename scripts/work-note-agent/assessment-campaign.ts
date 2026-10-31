import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assessmentDomains,
  createAssessmentCampaign,
} from './assessment-domains';
import {
  runAssessmentEvaluation,
  parseAssessmentRunOptions,
  type AssessmentRunOptions,
} from './assessment-run';
import type {
  AssessmentEvaluationRow,
  AssessmentScenario,
} from './assessment-evaluation';

export type CaseObservation = {
  caseId: string;
  split: string;
  family: string;
  expectedTurns: number;
  attemptedTurns: number;
  analysisPass: boolean;
  editor: 'ACCEPTED' | 'FAILED' | 'NOT_REQUESTED';
  failures: string[];
  actualCalls: number;
  reportedTokens: number;
  remainingCalls: number;
  providerFailure: boolean;
  critical: boolean;
};

export function summarizeCampaignCase(
  c: AssessmentScenario,
  rows: AssessmentEvaluationRow[],
  actualCalls: number,
  tokens: number,
  remainingCalls: number,
): CaseObservation {
  const analyses = rows.filter((r) => r.role !== 'editor' && !r.skipped);
  const editor = rows.find((r) => r.role === 'editor');
  return {
    caseId: c.id,
    split: c.split,
    family: c.family,
    expectedTurns: c.turns.length,
    attemptedTurns: analyses.length,
    analysisPass:
      analyses.length === c.turns.length &&
      analyses.every(
        (r) =>
          r.boundaryDenied ||
          (!r.errorCode &&
            r.grade?.automatedPass === true &&
            r.runtimeGrade?.automatedPass === true),
      ),
    editor: editor
      ? editor.editorValidation?.runtimeProposalAccepted === true
        ? 'ACCEPTED'
        : 'FAILED'
      : 'NOT_REQUESTED',
    failures: [
      ...new Set(
        rows.flatMap((r) => [
          ...(r.grade?.failures ?? []),
          ...(r.runtimeGrade?.failures ?? []),
          ...(r.errorCode ? [r.errorCode] : []),
        ]),
      ),
    ],
    actualCalls,
    reportedTokens: tokens,
    remainingCalls,
    critical: c.critical,
    providerFailure: rows.some(
      (r) =>
        !!r.errorCode &&
        /^XKIRO_(?:NETWORK|TIMEOUT|HTTP_ERROR_[45])/u.test(r.errorCode),
    ),
  };
}

/** A failed synthetic scenario is closed by the original runner. The next fixture
 * starts a NEW independent session; no failed proposal/action is applied.
 */
export async function collectIndependentCases(
  scenarios: AssessmentScenario[],
  execute: (c: AssessmentScenario) => Promise<CaseObservation>,
  progress?: (o: CaseObservation) => void,
) {
  const observations: CaseObservation[] = [];
  let providerFailures = 0,
    stopReason: string | null = null;
  for (const c of scenarios) {
    if (stopReason) break;
    const observation = await execute(c);
    if (observation.caseId !== c.id) throw Error('CAMPAIGN_CASE_MISMATCH');
    observations.push(observation);
    progress?.(observation);
    providerFailures = observation.providerFailure ? providerFailures + 1 : 0;
    if (observation.remainingCalls <= 0)
      stopReason = 'CAMPAIGN_BUDGET_EXHAUSTED';
    else if (
      observation.failures.some((f) => /TOKEN_RESERVATION_BUDGET/u.test(f))
    )
      stopReason = 'CAMPAIGN_TOKEN_BUDGET';
    else if (providerFailures >= 3)
      stopReason = 'CAMPAIGN_PROVIDER_FAILURE_LIMIT';
  }
  return {
    observations,
    stopReason,
    unattemptedCaseIds: scenarios.slice(observations.length).map((c) => c.id),
  };
}

const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function assertCampaignCeiling(
  options: Pick<AssessmentRunOptions, 'live' | 'maxAttempts'>,
) {
  // The shared full-run ledger has a fixed 176-call ceiling. Do not allow a
  // lower per-case limit to be mistaken for a lower campaign-wide authorization.
  if (options.live && options.maxAttempts !== 176)
    throw Error('CAMPAIGN_REQUIRES_EXPLICIT_176_CALL_CEILING');
}
function frozenFiles() {
  const directory = 'src/services/capture/application/work-note-agent/';
  const files = [
    'work-note-assessment.prompt.ts',
    'work-note-assessment.protocol.ts',
    'work-note-assessment.state.ts',
    'work-note-assessment.context.ts',
    'work-note-assessment-editor.ts',
    'work-note-agent.ts',
    'work-note-agent.completion.ts',
    'work-note-agent.protection.ts',
  ].map((f) => directory + f);
  files.push(
    'src/services/capture/infrastructure/ai/work-note-xkiro.client.ts',
    ...[
      'cases-assessment-v4.json',
      'cases-assessment-v4-errata.json',
      'assessment-domains.ts',
      'assessment-evaluation.ts',
      'assessment-run.ts',
      'assessment-campaign.ts',
    ].map((f) => 'scripts/work-note-agent/' + f),
  );
  return Object.fromEntries(
    files.map((f) => [
      f,
      createHash('sha256')
        .update(readFileSync(resolve(process.cwd(), f)))
        .digest('hex'),
    ]),
  );
}

export async function runAssessmentCampaign(args: string[]) {
  const options = parseAssessmentRunOptions(args),
    corpus = createAssessmentCampaign();
  assertCampaignCeiling(options);
  if (options.batch !== 'full' || options.split !== 'all' || options.caseIds)
    throw Error('CAMPAIGN_REQUIRES_FULL_ALL');
  const freeze = frozenFiles();
  const manifest = {
    classification: 'synthetic-only',
    corpusVersion: corpus.version,
    corpusHash: hash(corpus),
    frozenFiles: freeze,
    scenarios: corpus.scenarios.length,
    scriptedAnalysisTurns: corpus.scenarios.reduce(
      (n, c) => n + c.turns.length,
      0,
    ),
    maxHttpAttempts: options.maxAttempts,
    maxAccountedTokens: options.maxTotalTokens,
    independentSemanticAssessment: 'NOT_ESTABLISHED',
    domainMatrix: assessmentDomains.map((d) => ({
      ...d,
      caseIds: corpus.scenarios
        .filter((c) => d.families.includes(c.family))
        .map((c) => c.id),
    })),
  };
  if (!options.live) return { ...manifest, mode: 'dry-run' };
  if (!options.phaseId) throw Error('ASSESSMENT_PHASE_ID_REQUIRED');
  const dir = resolve(process.cwd(), '.worknote-agent-evals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, options.phaseId + '.campaign-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );
  const result = await collectIndependentCases(
    corpus.scenarios,
    async (c) => {
      if (hash(frozenFiles()) !== hash(freeze))
        throw Error('CAMPAIGN_FROZEN_FILES_CHANGED');
      const report = await runAssessmentEvaluation([...args, '--cases', c.id], {
        readCorpus: () => corpus,
      });
      if (!('budget' in report) || !report.phaseBudget)
        throw Error('CAMPAIGN_REPORT_INVALID');
      return summarizeCampaignCase(
        c,
        report.rows,
        report.budget.actualHttpAttempts,
        report.budget.reportedTokens,
        report.phaseBudget.maxHttpAttempts -
          report.phaseBudget.actualHttpAttempts,
      );
    },
    (o) => {
      // Only case IDs/counts/error codes; no raw responses, source text or credentials.
      console.log(
        JSON.stringify({
          completed: o.caseId,
          analysisPass: o.analysisPass,
          editor: o.editor,
          errors: o.failures,
          calls: o.actualCalls,
          remaining: o.remainingCalls,
        }),
      );
    },
  );
  if (hash(frozenFiles()) !== hash(freeze))
    throw Error('CAMPAIGN_FROZEN_FILES_CHANGED');
  const summary = {
    ...manifest,
    mode: 'live',
    phaseId: options.phaseId,
    ...result,
    automaticScenarioPasses: result.observations.filter(
      (o) => o.analysisPass && o.editor !== 'FAILED',
    ).length,
    domainResults: assessmentDomains.map((d) => {
      const rows = result.observations.filter((o) =>
        d.families.includes(o.family),
      );
      return {
        id: d.id,
        label: d.label,
        planned: manifest.domainMatrix.find((x) => x.id === d.id)!.caseIds
          .length,
        attempted: rows.length,
        analysisPasses: rows.filter((o) => o.analysisPass).length,
        failures: rows
          .filter((o) => !o.analysisPass || o.editor === 'FAILED')
          .map((o) => o.caseId),
      };
    }),
    releaseGate: 'NOT_PASSED',
    note: 'Domains overlap. Automated regression/semantic rubric results require independent human review; no Apply/Save or external action occurred. No prompt tuning during this run.',
  };
  writeFileSync(
    resolve(dir, options.phaseId + '.campaign-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    { flag: 'wx' },
  );
  return summary;
}

if (require.main === module)
  runAssessmentCampaign(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error('ASSESSMENT_CAMPAIGN_FAILED');
      process.exitCode = 1;
    });
