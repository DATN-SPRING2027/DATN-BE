import {
  assessmentDomains,
  createAssessmentCampaign,
} from './assessment-domains';
import {
  runAssessmentEvaluation,
  parseAssessmentRunOptions,
} from './assessment-run';

/** Domain tags only select synthetic cases; no domain hints are sent to the model. */
export function selectAssessmentDomain(args: string[]) {
  const positions = args.flatMap((arg, i) => (arg === '--domain' ? [i] : []));
  if (positions.length !== 1 || args.includes('--cases'))
    throw Error('ASSESSMENT_DOMAIN_ARGUMENT_INVALID');
  const i = positions[0],
    domain = assessmentDomains.find((d) => d.id === args[i + 1]);
  if (!domain) throw Error('ASSESSMENT_DOMAIN_UNKNOWN');
  const corpus = createAssessmentCampaign();
  const selected = corpus.scenarios.filter((c) =>
    domain.families.includes(c.family),
  );
  const forwarded = [
    '--batch',
    'full',
    '--split',
    'all',
    ...args.slice(0, i),
    ...args.slice(i + 2),
    '--cases',
    selected.map((c) => c.id).join(','),
  ];
  const options = parseAssessmentRunOptions(forwarded);
  if (options.batch !== 'full' || options.split !== 'all')
    throw Error('ASSESSMENT_DOMAIN_SCOPE_INVALID');
  return { domain: domain.id, corpus, args: forwarded };
}

export async function runAssessmentDomain(args: string[]) {
  const selection = selectAssessmentDomain(args);
  return runAssessmentEvaluation(selection.args, {
    readCorpus: () => selection.corpus,
  });
}

if (require.main === module)
  runAssessmentDomain(process.argv.slice(2))
    .then((report) =>
      console.log(
        JSON.stringify(
          !('budget' in report)
            ? report
            : {
                mode: report.mode,
                corpusVersion: report.corpusVersion,
                phaseId: report.phaseId,
                budget: report.budget,
                phaseBudget: report.phaseBudget,
                rows: report.rows.map((r) => ({
                  caseId: r.caseId,
                  turn: r.turn,
                  role: r.role,
                  grade: r.grade,
                  runtimeGrade: r.runtimeGrade,
                  errorCode: r.errorCode,
                })),
              },
        ),
      ),
    )
    .catch(() => {
      console.error('ASSESSMENT_DOMAIN_RUN_FAILED');
      process.exitCode = 1;
    });
