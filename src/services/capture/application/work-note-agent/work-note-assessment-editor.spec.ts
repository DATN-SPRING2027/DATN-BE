import {
  buildAssessmentEditorInput,
  prepareAssessmentEditorRequest,
  assertAssessmentEditorProposal,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
} from './work-note-assessment-editor';
import { parseRewriteCompletion } from './work-note-agent.completion';
import { prepareAgentRequest } from './work-note-agent';
import type { AssessmentView } from './work-note-assessment.types';

const draft = { revision: 2, title: 'Progress', body: 'Đã cập nhật form.' };
const assessment = {
  purpose: 'PROGRESS',
  noteAdequacy: 'ENOUGH_FOR_PURPOSE',
  answers: [
    {
      id: 'answer-1',
      target: 'network tests',
      disposition: 'answered',
      answer: 'Chưa kiểm thử mất mạng.',
    },
    { id: 'answer-2', target: 'environment', disposition: 'unknown' },
    { id: 'answer-3', target: 'other', disposition: 'skipped' },
  ],
  gaps: [
    {
      kind: 'EVIDENCE',
      target: 'environment',
      status: 'unknown',
      owner: 'NOTE_AUTHOR',
    },
  ],
} as AssessmentView;
const raw = (body: string) =>
  JSON.stringify({
    status: 'SUGGESTION_READY',
    message: 'Đề xuất',
    suggestion: {
      replacementText: body,
      suggestedTitle: null,
      changeSummary: ['Giữ dữ kiện tác giả.'],
    },
    questions: [],
    uncertainties: [],
  });

describe('Runtime and evaluation share assessment Editor semantics', () => {
  it('rejects dates invented from prompt versions and accepts dates actually supplied by the author', () => {
    const input = buildAssessmentEditorInput(draft, null, {
      ...assessment,
      answers: [],
      gaps: [],
    });
    const result = parseRewriteCompletion(
      prepareAgentRequest(input),
      raw(`${draft.body} Cập nhật ngày 2026-10-29.`),
      false,
    ).result;
    expect(() => assertAssessmentEditorProposal(input, result)).toThrow(
      'EDITOR_UNSOURCED_DATE',
    );
    const sourced = {
      ...input,
      draft: { ...draft, body: `${draft.body} Cập nhật ngày 2026-10-29.` },
    };
    expect(() => assertAssessmentEditorProposal(sourced, result)).not.toThrow();
  });
  it('builds the same custom whole-note request including unknowns, answers and gaps', () => {
    const input = buildAssessmentEditorInput(draft, null, assessment);
    expect(input.operation).toBe('custom');
    expect(input.scope).toBe('whole_note');
    expect(input.clarifications[1]).toMatchObject({
      state: 'answered',
      answer: 'Chưa biết',
    });
    expect(input.clarifications[2]).toMatchObject({ state: 'skipped' });
    expect(input.history[0].content).toContain('environment');
    expect(input.instruction).toContain('SUGGESTION_READY');
    expect(input.instruction).toContain('PROGRESS');
    expect(input.draft).toEqual(draft);
    expect(ASSESSMENT_EDITOR_PROVIDER_POLICY.retries).toBe(0);
    expect(ASSESSMENT_EDITOR_PROVIDER_POLICY.maxTokens).toBe(4096);
  });
  it('unambiguously supplies the whole note to the assessed Editor without the null wholeNote field', () => {
    const prepared = prepareAssessmentEditorRequest(
      buildAssessmentEditorInput(draft, null, assessment),
    );
    const payload = JSON.parse(prepared.messages.at(-1)!.content) as {
      source: { text: string; wholeNote?: null };
    };
    expect(payload.source.text).toBe(draft.body);
    expect(payload.source).not.toHaveProperty('wholeNote');
    expect(prepared.input.draft).toEqual(draft);
  });
  it('uses the same explicit formatting recovery and still rejects extra model fields', () => {
    const prepared = prepareAgentRequest(
      buildAssessmentEditorInput(draft, null, assessment),
    );
    const value = JSON.parse(raw(draft.body)) as Record<string, unknown>;
    delete value.questions;
    expect(() =>
      parseRewriteCompletion(prepared, JSON.stringify(value), false),
    ).toThrow();
    const parsed = parseRewriteCompletion(
      prepared,
      JSON.stringify(value),
      true,
    );
    expect(parsed.formattingRecovery).toEqual(['questions']);
    value.arbitrary = 'untrusted';
    expect(() =>
      parseRewriteCompletion(prepared, JSON.stringify(value), true),
    ).toThrow();
  });
  it('requires an actual proposal and preserves uncertainty from answered clarifications', () => {
    const input = buildAssessmentEditorInput(draft, null, assessment);
    const prepared = prepareAgentRequest(input);
    const missing = parseRewriteCompletion(
      prepared,
      raw(draft.body),
      false,
    ).result;
    expect(() => assertAssessmentEditorProposal(input, missing)).toThrow();
    const truthful = parseRewriteCompletion(
      prepared,
      raw(draft.body + ' Chưa kiểm thử mất mạng.'),
      false,
    ).result;
    expect(() => assertAssessmentEditorProposal(input, truthful)).not.toThrow();
    const answer = parseRewriteCompletion(
      prepared,
      JSON.stringify({
        status: 'ANSWER',
        message: 'Cannot edit',
        suggestion: null,
        questions: [],
        uncertainties: [],
      }),
      false,
    ).result;
    expect(() => assertAssessmentEditorProposal(input, answer)).toThrow(
      'EDITOR_PROPOSAL_REQUIRED',
    );
  });
  it('keeps prose numbers protected when there is no author correction, and allows updating corrected prose numbers while keeping inline code immutable when an author correction exists', () => {
    const numericDraft = {
      revision: 3,
      title: 'Partition spec',
      body: 'Đặc tả chạy `archive_partitions()` chuyển kho lạnh sau 3 tháng. Chưa kiểm thử staging.',
    };
    const noCorrectionPrepared = prepareAssessmentEditorRequest(
      buildAssessmentEditorInput(numericDraft, null, {
        ...assessment,
        answers: [],
        gaps: [],
      }),
    );
    expect(noCorrectionPrepared.fragments).toHaveLength(2);
    expect(() =>
      parseRewriteCompletion(
        noCorrectionPrepared,
        raw(
          `Đặc tả chạy ${noCorrectionPrepared.fragments[0].marker} chuyển kho lạnh sau **3** tháng. Chưa kiểm thử staging.`,
        ),
        false,
      ),
    ).toThrow('Protected fragments must occur exactly once');

    const withCorrectionInput = buildAssessmentEditorInput(numericDraft, null, {
      ...assessment,
      answers: [
        {
          id: 'correction-1',
          gapId: 'claim-1',
          target: 'author correction',
          disposition: 'answered',
          answer:
            'Đính chính: tôi ghi nhầm 3 tháng; đặc tả thực tế giữ dữ liệu nóng tối thiểu 12 tháng.',
          purpose: 'COMPLETION',
          taskContextHash: 'hash',
        },
      ],
      gaps: [],
    });
    const withCorrectionPrepared =
      prepareAssessmentEditorRequest(withCorrectionInput);
    expect(withCorrectionPrepared.fragments).toHaveLength(1);
    expect(withCorrectionPrepared.fragments[0].text).toBe(
      '`archive_partitions()`',
    );
    const codeMarker = withCorrectionPrepared.fragments[0].marker;
    const updated = parseRewriteCompletion(
      withCorrectionPrepared,
      raw(
        `Đặc tả chạy ${codeMarker} giữ dữ liệu nóng tối thiểu 12 tháng trước khi chuyển kho lạnh. Chưa kiểm thử staging.`,
      ),
      false,
    ).result;
    expect(() =>
      assertAssessmentEditorProposal(withCorrectionInput, updated),
    ).not.toThrow();
    expect(updated.suggestion?.replacementText).toContain(
      '`archive_partitions()` giữ dữ liệu nóng tối thiểu 12 tháng',
    );
    expect(() =>
      parseRewriteCompletion(
        withCorrectionPrepared,
        raw(
          'Đặc tả chạy archive_partitions() giữ dữ liệu nóng tối thiểu 12 tháng. Chưa kiểm thử staging.',
        ),
        false,
      ),
    ).toThrow('Protected fragments must occur exactly once');
  });
});
