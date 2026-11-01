import {
  selectAssessmentDomain,
  runAssessmentDomain,
} from '../../../../../scripts/work-note-agent/assessment-domain-run';

describe('Select isolated domain evaluation suites', () => {
  it.each(
    [
      'frontend',
      'ux-design',
      'backend',
      'database',
      'qa',
      'security',
      'devops',
      'data',
      'ai-ml',
      'product-ba',
      'documentation',
      'integration',
      'performance',
    ].map((args) => [args]),
  )(
    'selects only %s cases and does not call an API in dry-run',
    async (domain) => {
      const selection = selectAssessmentDomain([
        '--domain',
        domain,
        '--dry-run',
      ]);
      expect(selection.args).toContain('--cases');
      const report = await runAssessmentDomain([
        '--domain',
        domain,
        '--dry-run',
      ]);
      expect(report.mode).toBe('dry-run');
      expect(report.ceiling.scenarios).toBeGreaterThan(0);
      expect(report.rows).toEqual([]);
    },
  );
  it.each([
    { args: ['--domain', 'unknown'] },
    { args: ['--domain', 'qa', '--domain', 'data'] },
    {
      args: [
        '--domain',
        'security',
        '--cases',
        'domain-ai-model-evaluation-complete',
      ],
    },
    { args: ['--domain', 'qa', '--batch', 'pilot'] },
  ])(
    'rejects ambiguous/unknown scope before credentials are read: $args',
    ({ args }) => {
      expect(() => selectAssessmentDomain(args)).toThrow();
    },
  );
});
