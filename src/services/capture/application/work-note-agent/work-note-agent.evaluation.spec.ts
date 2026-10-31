import {
  gradeCompletion,
  loadCorpus,
  percentile,
} from '../../../../../scripts/work-note-agent/evaluation';
import { prepareAgentRequest } from './work-note-agent';

describe('Bundled WorkNote evaluation corpus and grader', () => {
  it('loads 60 new v0.3.2 cases with behavior rubrics and separate 30/10/20 splits', () => {
    const corpus = loadCorpus('v3');
    expect(corpus.cases).toHaveLength(60);
    expect(corpus.cases.filter((c) => c.split === 'development')).toHaveLength(
      30,
    );
    expect(corpus.cases.filter((c) => c.split === 'validation')).toHaveLength(
      10,
    );
    expect(corpus.cases.filter((c) => c.split === 'holdout')).toHaveLength(20);
    const previous = new Set(
      [...loadCorpus().cases, ...loadCorpus('v2').cases].map((c) =>
        JSON.stringify(c.input),
      ),
    );
    for (const c of corpus.cases) {
      expect(previous.has(JSON.stringify(c.input))).toBe(false);
      expect(c.expected.acceptedBehaviors?.length).toBeGreaterThan(0);
      expect(c.expected.prohibitedBehaviors?.length).toBeGreaterThan(0);
      prepareAgentRequest(c.input);
    }
  });
  it('keeps the v0.3 follow-up corpus separate from the already-inspected baseline holdout', () => {
    const fresh = loadCorpus('v2');
    expect(fresh.cases).toHaveLength(42);
    expect(fresh.cases.filter((c) => c.split === 'development')).toHaveLength(
      21,
    );
    expect(fresh.cases.filter((c) => c.split === 'validation')).toHaveLength(7);
    expect(fresh.cases.filter((c) => c.split === 'holdout')).toHaveLength(14);
    const baseline = new Set(
      loadCorpus().cases.map((c) => JSON.stringify(c.input)),
    );
    for (const c of fresh.cases) {
      expect(baseline.has(JSON.stringify(c.input))).toBe(false);
      prepareAgentRequest(c.input);
    }
  });
  it('contains 120 distinct synthetic requests with stratified 70/25/25 splits', () => {
    const corpus = loadCorpus();
    expect(corpus.cases).toHaveLength(120);
    expect(new Set(corpus.cases.map((c) => JSON.stringify(c.input))).size).toBe(
      120,
    );
    expect(corpus.cases.filter((c) => c.split === 'holdout')).toHaveLength(25);
    const groups = new Map<string, number>();
    for (const c of corpus.cases) {
      prepareAgentRequest(c.input);
      groups.set(c.category, (groups.get(c.category) ?? 0) + 1);
    }
    expect(Object.fromEntries(groups)).toEqual({
      grammar: 20,
      protected: 20,
      style: 15,
      'task-context': 20,
      selection: 15,
      conversation: 20,
      adversarial: 10,
    });
  });
  it('distinguishes JSON syntax, boundary validation, rule failures and unreviewed semantics', () => {
    const c = loadCorpus().cases[0];
    const prepared = prepareAgentRequest(c.input);
    expect(gradeCompletion(c, prepared, 'invalid')).toMatchObject({
      syntaxValid: false,
      boundaryAccepted: false,
      automatedPass: false,
    });
    expect(gradeCompletion(c, prepared, '{}')).toMatchObject({
      syntaxValid: true,
      boundaryAccepted: false,
    });
    const raw = JSON.stringify({
      status: 'SUGGESTION_READY',
      message: 'Đề xuất.',
      suggestion: {
        replacementText: 'Đã sửa API, chưa test staging.',
        suggestedTitle: null,
        changeSummary: ['Sửa câu.'],
      },
      questions: [],
      uncertainties: [],
    });
    expect(gradeCompletion(c, prepared, raw)).toMatchObject({
      automatedPass: true,
      manualReview: 'required',
    });
    expect(
      gradeCompletion(c, prepared, raw.replace('chưa', 'đã')),
    ).toMatchObject({ boundaryAccepted: true, automatedPass: false });
    expect(percentile([2, 10, 5], 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});
