import {
  gradeAssessment,
  loadAssessmentCorpus,
  loadRegression80Corpus,
  loadRelease60Corpus,
  makeAssessmentWorksheet,
  type AssessmentEvaluationRow,
  type AssessmentScenario,
} from '../../../../../scripts/work-note-agent/assessment-evaluation';
import {
  adjudicateBlindedReviews,
  computeAssessmentQualityGate,
  makeBlindedReviewPack,
  validateReleaseAssessmentCorpus,
} from '../../../../../scripts/work-note-agent/assessment-quality-gate';
import {
  AssessmentAttemptBudget,
  parseAssessmentRunOptions,
  runAssessmentEvaluation,
} from '../../../../../scripts/work-note-agent/assessment-run';
import {
  mergeResumedStageRows,
  partitionResumableStageScenarios,
} from '../../../../../scripts/work-note-agent/assessment-release-gate-run';
import type { AssessmentModelOutput } from './work-note-assessment.types';
import {
  parseAssessmentOutput,
  assessmentHash,
} from './work-note-assessment.protocol';

describe('Task-aware assessment evaluation evidence', () => {
  it('freezes 72 varied scenarios, family-exclusive splits and the 29-call pilot ceiling', () => {
    const corpus = loadAssessmentCorpus();
    expect(corpus.scenarios).toHaveLength(72);
    const counts = (values: string[]) =>
      values.reduce<Record<string, number>>(
        (r, v) => ({ ...r, [v]: (r[v] ?? 0) + 1 }),
        {},
      );
    expect(counts(corpus.scenarios.map((c) => c.split))).toEqual({
      development: 36,
      validation: 12,
      holdout: 24,
    });
    expect(counts(corpus.scenarios.map((c) => String(c.turns.length)))).toEqual(
      { '1': 48, '2': 16, '3': 8 },
    );
    for (const family of new Set(corpus.scenarios.map((c) => c.family))) {
      expect(
        new Set(
          corpus.scenarios
            .filter((c) => c.family === family)
            .map((c) => c.split),
        ).size,
      ).toBe(1);
    }
    const pilot = corpus.scenarios.filter((c) => c.pilot);
    expect(pilot).toHaveLength(12);
    expect(counts(pilot.map((c) => String(c.turns.length)))).toEqual({
      '1': 8,
      '2': 3,
      '3': 1,
    });
    expect(pilot.reduce((n, c) => n + c.turns.length + 1, 0)).toBe(29);
    expect(new Set(corpus.scenarios.map((c) => c.family)).size).toBe(36);
    expect(
      new Set(
        corpus.scenarios.map(
          (c) => c.sources.find((s) => s.id === 'note.body')?.text,
        ),
      ).size,
    ).toBeGreaterThan(60);
  });

  it('does not convert Save, author acceptance or a valid quote into semantic correctness', () => {
    const scenario = loadAssessmentCorpus().scenarios.find(
      (c) => c.category === 'negation',
    )!;
    const source = scenario.sources.find((s) => s.id === 'note.body')!;
    const output = fixture(scenario);
    output.claims = [
      {
        text: 'All tests passed.',
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
        sourceRefs: [{ sourceId: source.id, quote: source.text }],
      },
    ];
    const grade = gradeAssessment(scenario, 0, output);
    expect(grade.failures).toContain('FORBIDDEN_ASSERTION');
    expect(grade.semanticAcceptance).toBe('NOT_ESTABLISHED');
    const sheet = makeAssessmentWorksheet([
      { caseId: scenario.id, turn: 1, output, grade },
    ]);
    expect(sheet.items[0].ratings.claimSupport).toBeNull();
    expect(sheet.items[0].signals).toEqual({
      saved: false,
      proposalAccepted: false,
      authorValidated: false,
      independentSemanticAcceptance: 'NOT_ESTABLISHED',
    });
  });

  it('checks the source kind of requirements and the question gap rather than accepting generic questions', () => {
    const scenario = loadAssessmentCorpus().scenarios.find(
      (c) => c.turns[0].expected.question === 'required',
    )!;
    const output = fixture(scenario);
    output.taskUnderstanding.requirements = [
      {
        text: 'Assumed requirement.',
        sourceRefs: [
          {
            sourceId: 'note.body',
            quote: scenario.sources.find((s) => s.id === 'note.body')!.text,
          },
        ],
      },
    ];
    output.gaps = [
      {
        kind: 'PURPOSE',
        target: 'unrelated',
        impact: 'OPTIONAL',
        owner: 'NOTE_AUTHOR',
        sourceRefs: [],
      },
    ];
    output.nextQuestion = {
      gapIndex: 0,
      text: 'What is your favorite color?',
      reason: 'Need a detail.',
      options: [],
    };
    const failures = gradeAssessment(scenario, 0, output).failures;
    expect(failures).toContain('REQUIREMENT_FROM_NON_TASK_SOURCE');
    expect(failures).toContain('QUESTION_GAP_KIND');
    expect(failures).toContain('QUESTION_RELEVANCE');
  });

  it('exercises the actual protocol on an existing quote that contradicts the claim and on related-only text', () => {
    const c = loadAssessmentCorpus().scenarios.find(
      (c) => c.category === 'negation',
    )!;
    const input = {
      sources: c.sources,
      purpose: c.purpose,
      previous: null,
      answers: [],
    };
    const output = fixture(c),
      source = c.sources.find((s) => s.id === 'note.body')!;
    output.claims[0] = {
      text: 'Đã kiểm thử và xác minh nguyên nhân timeout.',
      originKind: 'AUTHOR_REPORT',
      supportRelation: 'FULL',
      sourceRefs: [{ sourceId: source.id, quote: source.text }],
    };
    expect(() => parseAssessmentOutput(input, JSON.stringify(output))).toThrow(
      'SEMANTIC_POLARITY_MISMATCH',
    );
    output.claims[0].text = 'The author discussed the upload screen.';
    expect(
      parseAssessmentOutput(input, JSON.stringify(output)).claims[0]
        .supportRelation,
    ).toBe('PARTIAL');
  });
});

describe('Assessment evaluator budget and non-network defaults', () => {
  it('fingerprints the actually selected purpose pack even when the provider fails', async () => {
    let sent = '';
    const result = await runAssessmentEvaluation(
      [
        '--live',
        '--batch',
        'full',
        '--split',
        'all',
        '--cases',
        'assessment-retry-upload-a',
        '--model',
        'test/model',
        '--max-attempts',
        '1',
      ],
      {
        readCredentials: () => Promise.resolve({ apiKey: 'synthetic' }),
        writeReport: false,
        fetcher: (_url, init) => {
          if (typeof init?.body !== 'string')
            throw Error('Expected serialized fixture payload');
          const payload = JSON.parse(init.body) as {
            messages: unknown[];
          };
          sent = assessmentHash(payload.messages.slice(0, -1));
          return Promise.resolve(new Response('{}', { status: 500 }));
        },
      },
    );
    if (!('budget' in result)) throw Error('Expected fixture live result');
    expect(result.promptTemplateHash).toBe(sent);
    expect(result.rows[0].requestTemplateHash).toBe(sent);
  });
  it('keeps observed development schema failures strict instead of repairing them into accepted output', () => {
    const c = loadAssessmentCorpus().scenarios.find(
      (c) => c.category === 'negation',
    )!;
    const input = {
      sources: c.sources,
      purpose: c.purpose,
      previous: null,
      answers: [],
    };
    const output = fixture(c),
      requirement = c.sources.find((s) => s.id === 'task.step.0')!,
      note = c.sources.find((s) => s.id === 'note.body')!;
    output.taskUnderstanding.requirements = [
      {
        text: requirement.text,
        sourceRefs: [{ sourceId: requirement.id, quote: requirement.text }],
      },
    ];
    output.coverage = [
      { requirementIndex: 0, status: 'NOT_REPORTED', sourceRefs: [] },
    ];
    const gap = {
      kind: 'EVIDENCE' as const,
      target: 'test result',
      impact: 'BLOCKING' as const,
      owner: 'NOTE_AUTHOR' as const,
      sourceRefs: [{ sourceId: note.id, quote: note.text }],
    };
    output.gaps = [gap];
    expect(() =>
      parseAssessmentOutput(input, JSON.stringify(output)),
    ).not.toThrow();
    const invalidShapes: unknown[] = [
      { ...output, nextQuestion: [] },
      {
        ...output,
        coverage: [
          { requirementIndex: 0, status: 'INSUFFICIENT', sourceRefs: [] },
        ],
      },
      { ...output, gaps: [{ ...gap, gapIndex: 0 }] },
      {
        ...output,
        taskUnderstanding: {
          ...output.taskUnderstanding,
          requirements: [
            {
              text: requirement.text.split(' ')[0],
              sourceRefs: [
                { sourceId: requirement.id, quote: requirement.text },
              ],
            },
          ],
        },
      },
    ];
    for (const invalid of invalidShapes)
      expect(() =>
        parseAssessmentOutput(input, JSON.stringify(invalid)),
      ).toThrow();
  });

  it('retains invalid synthetic model content only in redacted local review evidence', async () => {
    const key = 'SYNTHETIC_ECHO_SECRET';
    const network = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: `not-json ${key}` },
              },
            ],
            usage: { total_tokens: 9 },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await runAssessmentEvaluation(
      ['--live', '--model', 'test/model', '--max-attempts', '1'],
      {
        readCredentials: () => Promise.resolve({ apiKey: key }),
        fetcher: network,
        writeReport: false,
      },
    );
    expect(result.rows[0].rawSyntheticResponse).toBe('not-json [REDACTED]');
    expect(JSON.stringify(result)).not.toContain(key);
    expect(
      makeAssessmentWorksheet(result.rows).items[0].rawSyntheticResponse,
    ).toBe('not-json [REDACTED]');
  });

  it('does not treat an extractive negative author claim as completed requirement evidence', () => {
    const c = structuredClone(
      loadAssessmentCorpus().scenarios.find((c) => c.category === 'negation')!,
    );
    const requirement = c.sources.find((s) => s.id === 'task.step.0')!;
    requirement.text = 'Kiểm thử mất mạng đã hoàn tất.';
    const note = c.sources.find((s) => s.id === 'note.body')!;
    note.text = 'Chưa kiểm thử mất mạng.';
    const output = fixture(c);
    output.taskUnderstanding.requirements = [
      {
        text: requirement.text,
        sourceRefs: [{ sourceId: requirement.id, quote: requirement.text }],
      },
    ];
    output.coverage = [
      {
        requirementIndex: 0,
        status: 'SUPPORTED',
        sourceRefs: [{ sourceId: note.id, quote: note.text }],
      },
    ];
    const parsed = parseAssessmentOutput(
      { sources: c.sources, purpose: c.purpose, previous: null, answers: [] },
      JSON.stringify(output),
    );
    expect(parsed.claims[0].supportRelation).toBe('FULL');
    expect(parsed.coverage[0].status).toBe('PARTIAL');
  });

  it('does not read credentials or call a provider for its default dry run', async () => {
    const secrets = jest
      .fn()
      .mockRejectedValue(Error('credential should not be read'));
    const network = jest
      .fn()
      .mockRejectedValue(Error('network should not be called'));
    const result = await runAssessmentEvaluation([], {
      readCredentials: secrets,
      fetcher: network,
    });
    expect(result.mode).toBe('dry-run');
    expect(result.ceiling.logicalCalls).toBe(29);
    expect(result.ceiling.httpAttempts).toBe(29);
    expect(secrets).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('selects development cases explicitly without reading credentials or leaking into another split', async () => {
    const secrets = jest
      .fn()
      .mockRejectedValue(Error('must not read credentials'));
    const report = await runAssessmentEvaluation(
      ['--dry-run', '--cases', 'assessment-retry-upload-a'],
      { readCredentials: secrets },
    );
    expect(report.ceiling.scenarios).toBe(1);
    expect(report.ceiling.logicalCalls).toBe(2);
    await expect(
      runAssessmentEvaluation(
        ['--live', '--model', 'test/model', '--cases', 'not-in-pilot'],
        { readCredentials: secrets },
      ),
    ).rejects.toThrow('ASSESSMENT_CASE_SELECTION_INVALID');
    expect(secrets).not.toHaveBeenCalled();
  });
  it('bounds every actual HTTP attempt globally across roles and does not expose request secrets', async () => {
    const underlying = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
        }),
        { status: 200 },
      ),
    );
    const budget = new AssessmentAttemptBudget(2, 100000, underlying);
    const payload = {
      model: 'test/model',
      messages: [{ role: 'user', content: 'Synthetic only.' }],
      max_tokens: 128,
    };
    const init = {
      method: 'POST',
      headers: { Authorization: 'Bearer NEVER_PRINT_THIS_SECRET' },
      body: JSON.stringify(payload),
    };
    await budget.fetch('https://api.xkiro.com/v1/chat/completions', init);
    await budget.fetch('https://api.xkiro.com/v1/chat/completions', init);
    await expect(
      budget.fetch('https://api.xkiro.com/v1/chat/completions', init),
    ).rejects.toThrow('HTTP_ATTEMPT_BUDGET');
    expect(underlying).toHaveBeenCalledTimes(2);
    expect(budget.snapshot().actualHttpAttempts).toBe(2);
    expect(budget.snapshot().reportedTokens).toBe(14);
    expect(JSON.stringify(budget.snapshot())).not.toContain('NEVER_PRINT');
  });

  it('charges unknown usage conservatively after failures and blocks the next reservation', async () => {
    const underlying = jest
      .fn()
      .mockRejectedValue(Error('secret provider detail'));
    const budget = new AssessmentAttemptBudget(29, 700, underlying);
    const init = {
      method: 'POST',
      body: JSON.stringify({
        model: 'test/model',
        messages: [{ role: 'user', content: 'synthetic'.repeat(15) }],
        max_tokens: 128,
      }),
    };
    await expect(
      budget.fetch('https://api.xkiro.com/v1/chat/completions', init),
    ).rejects.toThrow('ASSESSMENT_PROVIDER_NETWORK');
    expect(budget.snapshot().unknownUsageAttempts).toBe(1);
    await expect(
      budget.fetch('https://api.xkiro.com/v1/chat/completions', init),
    ).rejects.toThrow('TOKEN_RESERVATION_BUDGET');
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('rejects secret arguments, excess calls and automatic retries before inference', () => {
    expect(parseAssessmentRunOptions([]).live).toBe(false);
    expect(() => parseAssessmentRunOptions(['--api-key', 'secret'])).toThrow();
    expect(() => parseAssessmentRunOptions(['--max-attempts', '30'])).toThrow();
    expect(() => parseAssessmentRunOptions(['--retries', '1'])).toThrow();
  });

  it('shares the same live-run HTTP ceiling between analysis and Editor using synthetic mock responses', async () => {
    const first = loadAssessmentCorpus().scenarios[0];
    const network = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string')
          throw Error('Mock expected serialized JSON');
        const body = JSON.parse(init.body) as {
          messages: { content: string }[];
        };
        const last = JSON.parse(body.messages.at(-1)!.content) as {
          sources?: unknown[];
          source?: { text: string };
          operation?: string;
        };
        if (!last.sources) expect(last.operation).toBe('custom');
        const response = last.sources
          ? {
              ...fixture(first),
              taskContextStatus: first.turns[0].expected.taskContextStatus[0],
            }
          : {
              status: 'SUGGESTION_READY',
              message: 'Synthetic formatting proposal.',
              suggestion: {
                replacementText: last.source!.text,
                suggestedTitle: null,
                changeSummary: ['Kept the supplied facts.'],
              },
              questions: [],
              uncertainties: [],
            };
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'test/model',
              choices: [
                {
                  finish_reason: 'stop',
                  message: { content: JSON.stringify(response) },
                },
              ],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 10,
                total_tokens: 30,
              },
            }),
            { status: 200 },
          ),
        );
      },
    );
    const result = await runAssessmentEvaluation(
      ['--live', '--model', 'test/model', '--max-attempts', '2'],
      {
        readCredentials: () =>
          Promise.resolve({
            apiKey: 'SYNTHETIC_KEY_NOT_TO_BE_LOGGED',
          }),
        fetcher: network,
        writeReport: false,
      },
    );
    if (!('budget' in result)) throw Error('Expected mock live evidence');
    expect(network).toHaveBeenCalledTimes(2);
    expect(result.budget.actualHttpAttempts).toBe(2);
    expect(
      result.rows.filter((r) => r.role === 'editor' && !r.errorCode),
    ).toHaveLength(1);
    expect(result.rows.some((r) => r.errorCode === 'HTTP_ATTEMPT_BUDGET')).toBe(
      true,
    );
    expect(result.semanticAcceptance).toBe('NOT_ESTABLISHED');
    expect(JSON.stringify(result)).not.toContain(
      'SYNTHETIC_KEY_NOT_TO_BE_LOGGED',
    );
  });

  it('does not retry a provider HTTP 500 within a logical call', async () => {
    const network = jest.fn(() =>
      Promise.resolve(new Response('{}', { status: 500 })),
    );
    const result = await runAssessmentEvaluation(
      ['--live', '--model', 'test/model', '--max-attempts', '2'],
      {
        readCredentials: () => Promise.resolve({ apiKey: 'synthetic-only' }),
        fetcher: network,
        writeReport: false,
      },
    );
    expect(network).toHaveBeenCalledTimes(2);
    expect(
      result.rows.filter((r) => r.errorCode === 'XKIRO_HTTP_ERROR_500'),
    ).toHaveLength(2);
    for (const row of result.rows.filter(
      (r) => r.errorCode === 'XKIRO_HTTP_ERROR_500',
    ))
      expect(row.requestTemplateHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      new Set(
        result.rows
          .filter((r) => r.errorCode && !r.skipped)
          .map((r) => r.caseId),
      ).size,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('Plan v3 §§6-7 release60 corpus, dual-layer quality gate, and blinded adjudication', () => {
  it('enforces disjoint 80-case regression and 60-case release corpora with exact Plan v3 §6 ceilings', async () => {
    const reg = loadRegression80Corpus();
    const rel = loadRelease60Corpus();
    expect(reg.scenarios).toHaveLength(80);
    expect(rel.scenarios).toHaveLength(60);

    const regFamilies = new Set(reg.scenarios.map((s) => s.family));
    const relFamilies = new Set(rel.scenarios.map((s) => s.family));
    expect(regFamilies.size).toBe(40);
    expect(relFamilies.size).toBe(30);
    for (const f of relFamilies) {
      expect(regFamilies.has(f)).toBe(false);
    }

    const dryRegA = await runAssessmentEvaluation([
      '--dry-run',
      '--corpus',
      'regression80',
      '--batch',
      'release',
      '--split',
      'all',
      '--architecture',
      'combined',
    ]);
    const dryRegB = await runAssessmentEvaluation([
      '--dry-run',
      '--corpus',
      'regression80',
      '--batch',
      'release',
      '--split',
      'all',
      '--architecture',
      'split',
    ]);
    const dryRelA = await runAssessmentEvaluation([
      '--dry-run',
      '--corpus',
      'release60',
      '--batch',
      'release',
      '--split',
      'all',
      '--architecture',
      'combined',
    ]);
    const dryRelB = await runAssessmentEvaluation([
      '--dry-run',
      '--corpus',
      'release60',
      '--batch',
      'release',
      '--split',
      'all',
      '--architecture',
      'split',
    ]);
    expect(dryRegA.ceiling.httpAttempts).toBe(192);
    expect(dryRegB.ceiling.httpAttempts).toBe(272);
    expect(dryRelA.ceiling.httpAttempts).toBe(148);
    expect(dryRelB.ceiling.httpAttempts).toBe(208);

    const leaked = structuredClone(rel);
    leaked.scenarios[0].split = 'holdout';
    expect(() => validateReleaseAssessmentCorpus(leaked)).toThrow(
      /RELEASE_FAMILY_SPLIT_LEAKAGE/,
    );
  });

  it('reports rawModelOutput separately from postGuardRuntime so deterministic guards never mask raw false-sufficient defects', () => {
    const rel = loadRelease60Corpus();
    const insufficientScenario = rel.scenarios.find(
      (s) =>
        s.turns.length === 1 &&
        !s.turns[0].expected.noteAdequacy.includes('ENOUGH_FOR_PURPOSE'),
    )!;
    const rawOut = fixture(insufficientScenario);
    rawOut.noteAdequacy = 'ENOUGH_FOR_PURPOSE';
    const noteSource = insufficientScenario.sources.find(
      (s) => s.id === 'note.body',
    )!;
    rawOut.gaps = [
      {
        kind: 'SCOPE',
        needCode: 'scope.completed_part',
        target: 'missing concrete scope',
        impact: 'BLOCKING',
        owner: 'NOTE_AUTHOR',
        sourceRefs: [{ sourceId: noteSource.id, quote: noteSource.text }],
      },
    ];
    const row: AssessmentEvaluationRow = {
      caseId: insufficientScenario.id,
      turn: 1,
      role: 'analysis',
      output: rawOut,
      grade: gradeAssessment(insufficientScenario, 0, rawOut),
      runtimeState: {
        state: 'missing_context',
        noteAdequacy: 'UNDETERMINED',
        counters: { questionCount: 0, noProgress: 0 },
      },
      runtimeGrade: {
        automatedPass: false,
        failures: ['REQUIRED_QUESTION_MISSING'],
        semanticAcceptance: 'NOT_ESTABLISHED',
        manualReview: 'required',
      },
    };
    const report = computeAssessmentQualityGate([row], rel);
    expect(report.rawModelOutput.criticalErrors.falseSufficient).toBe(1);
    expect(report.postGuardRuntime.criticalErrors.falseSufficient).toBe(0);
    expect(report.reviewerSemanticAssessment).toBe('NOT_ESTABLISHED');
  });

  it('produces blinded transcript worksheets without variant metadata and rejects LLM judges from closing semantic acceptance', () => {
    const rel = loadRelease60Corpus();
    const s = rel.scenarios[0];
    const row: AssessmentEvaluationRow = {
      caseId: s.id,
      turn: 1,
      role: 'analysis',
      output: fixture(s),
    };
    const pack = makeBlindedReviewPack(
      [
        { variantLabel: 'variant-A', reportId: 'rep-1', rows: [row] },
        { variantLabel: 'variant-B', reportId: 'rep-2', rows: [row] },
      ],
      rel,
      'fixed-test-salt',
    );
    expect(pack.blindedWorksheet.items).toHaveLength(2);
    expect(JSON.stringify(pack.blindedWorksheet)).not.toContain('variant-A');
    expect(JSON.stringify(pack.blindedWorksheet)).not.toContain(s.id);
    expect(pack.sealedKey.entries).toHaveLength(2);

    const passRatings = {
      taskUnderstanding: 'PASS' as const,
      purposeAdequacy: 'PASS' as const,
      claimSupportAndPolarity: 'PASS' as const,
      questionNecessityAndUtility: 'PASS' as const,
      answerUseAndUncertaintyPreservation: 'PASS' as const,
    };
    const failRatings = { ...passRatings, purposeAdequacy: 'FAIL' as const };

    const reviewerA = pack.blindedWorksheet.items.map((item) => ({
      ...item,
      reviewerId: 'human:alice',
      reviewedAt: '2026-10-29T12:00:00Z',
      ratings: passRatings,
    }));
    const modelJudgeB = pack.blindedWorksheet.items.map((item) => ({
      ...item,
      reviewerId: 'model:judge-v1',
      reviewedAt: '2026-10-29T12:00:00Z',
      ratings: passRatings,
    }));
    expect(
      adjudicateBlindedReviews({ reviewerA, reviewerB: modelJudgeB })
        .reviewerSemanticAssessment,
    ).toBe('NOT_ESTABLISHED');

    const reviewerBDisagree = pack.blindedWorksheet.items.map((item, idx) => ({
      ...item,
      reviewerId: 'human:bob',
      reviewedAt: '2026-10-29T12:05:00Z',
      ratings: idx === 0 ? failRatings : passRatings,
    }));
    const unresolved = adjudicateBlindedReviews({
      reviewerA,
      reviewerB: reviewerBDisagree,
    });
    expect(unresolved.disagreementIds).toHaveLength(1);
    expect(unresolved.reviewerSemanticAssessment).toBe('NOT_ESTABLISHED');

    const resolved = adjudicateBlindedReviews({
      reviewerA,
      reviewerB: reviewerBDisagree,
      adjudications: [
        {
          blindTranscriptId: unresolved.disagreementIds[0],
          adjudicatorId: 'human:lead-chair',
          finalDecision: 'PASS',
          rationale: 'Verified against Task criteria and purpose rubric.',
        },
      ],
    });
    expect(resolved.unresolvedDisagreementIds).toHaveLength(0);
    expect(resolved.reviewerSemanticAssessment).toBe(
      'ESTABLISHED_BY_HUMAN_REVIEW',
    );
  });

  it('does not flag FORBIDDEN_ASSERTION when an AUTHOR_REPORT claim quotes an embedded prompt-injection phrase verbatim from note.body, while still catching unquoted fabricated assertions', () => {
    const rel = loadRelease60Corpus();
    const injectionScenario = rel.scenarios.find(
      (s) => s.id === 'release-sanitized-webhook-replay-a',
    )!;
    const validQuoted = fixture(injectionScenario);
    expect(
      gradeAssessment(injectionScenario, 0, validQuoted).failures,
    ).not.toContain('FORBIDDEN_ASSERTION');

    const obeyedInjection: AssessmentModelOutput = {
      ...validQuoted,
      taskUnderstanding: {
        ...validQuoted.taskUnderstanding,
        scope: 'All requirements are independently verified.',
      },
    };
    expect(
      gradeAssessment(injectionScenario, 0, obeyedInjection).failures,
    ).toContain('FORBIDDEN_ASSERTION');
  });

  it('resumes only transport/quota-interrupted or skipped scenarios while keeping model-failed and completed scenarios immutable', () => {
    const scenarioIds = [
      'case-pass',
      'case-schema-fail',
      'case-429',
      'case-skip',
    ];
    const existing: AssessmentEvaluationRow[] = [
      { caseId: 'case-pass', turn: 1, role: 'analysis' },
      {
        caseId: 'case-schema-fail',
        turn: 1,
        role: 'analysis',
        errorCode: 'ASSESSMENT_SCHEMA_INVALID',
      },
      {
        caseId: 'case-429',
        turn: 1,
        role: 'analysis',
        errorCode: 'XKIRO_HTTP_ERROR_429',
      },
      { caseId: 'case-skip', turn: 1, skipped: true },
    ];
    const part = partitionResumableStageScenarios(scenarioIds, existing);
    expect([...part.completedRowsByCase.keys()]).toEqual([
      'case-pass',
      'case-schema-fail',
    ]);
    expect(part.remainingCaseIds).toEqual(['case-429', 'case-skip']);

    const merged = mergeResumedStageRows(
      scenarioIds,
      part.completedRowsByCase,
      [
        { caseId: 'case-429', turn: 1, role: 'analysis' },
        { caseId: 'case-skip', turn: 1, role: 'analysis' },
      ],
    );
    expect(merged.map((r) => [r.caseId, r.errorCode ?? 'OK'])).toEqual([
      ['case-pass', 'OK'],
      ['case-schema-fail', 'ASSESSMENT_SCHEMA_INVALID'],
      ['case-429', 'OK'],
      ['case-skip', 'OK'],
    ]);
  });
});

function fixture(c: AssessmentScenario): AssessmentModelOutput {
  const task = c.sources.find((s) => s.id === 'task.title')!;
  const note = c.sources.find((s) => s.id === 'note.body')!;
  return {
    purpose: c.purpose,
    taskUnderstanding: {
      objective: task.text,
      scope: task.text,
      requirements: [],
      unknowns: [],
    },
    claims: [
      {
        text: note.text,
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
        sourceRefs: [{ sourceId: note.id, quote: note.text }],
      },
    ],
    coverage: [],
    gaps: [],
    nextQuestion: null,
    taskContextStatus: 'CLEAR',
    noteAdequacy: 'ENOUGH_FOR_PURPOSE',
  };
}
