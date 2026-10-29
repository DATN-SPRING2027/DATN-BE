import { parseAssessmentOutput } from './work-note-assessment.protocol';
import type {
  AssessmentModelInput,
  AssessmentModelOutput,
} from './work-note-assessment.types';

function fixture(
  requirement: string,
  note: string,
  quote = note,
  title = 'Implement the Task',
) {
  const source = (id: string, kind: 'TASK' | 'NOTE', text: string) => ({
    id,
    kind,
    label: id,
    text,
    version: '1',
    loadStatus: 'LOADED' as const,
    includedInRequest: true,
  });
  const input: AssessmentModelInput = {
    purpose: 'COMPLETION',
    previous: null,
    answers: [],
    sources: [
      source('task.title', 'TASK', title),
      source('task.description', 'TASK', requirement),
      source('note.body', 'NOTE', note),
    ],
  };
  const out: AssessmentModelOutput = {
    purpose: 'COMPLETION',
    taskUnderstanding: {
      objective: title,
      scope: requirement,
      requirements: [
        {
          text: requirement,
          sourceRefs: [{ sourceId: 'task.description', quote: requirement }],
        },
      ],
      unknowns: [],
    },
    claims: [
      {
        text: note,
        originKind: 'AUTHOR_REPORT',
        supportRelation: 'FULL',
        sourceRefs: [{ sourceId: 'note.body', quote: note }],
      },
    ],
    coverage: [
      {
        requirementIndex: 0,
        status: 'SUPPORTED',
        sourceRefs: [{ sourceId: 'note.body', quote }],
      },
    ],
    gaps: [],
    taskContextStatus: 'CLEAR',
    noteAdequacy: 'ENOUGH_FOR_PURPOSE',
    nextQuestion: null,
  };
  return { input, out };
}
describe('Evidence polarity is scoped, not a keyword over the whole paragraph', () => {
  it('fails closed on excessively repeated ambiguous excerpts instead of unbounded context scanning', () => {
    const quote = 'API passed.';
    const f = fixture('API passes.', `${quote} `.repeat(100), quote);
    f.out.claims[0].text = quote;
    f.out.claims[0].sourceRefs[0].quote = quote;
    expect(() => parseAssessmentOutput(f.input, JSON.stringify(f.out))).toThrow(
      'AMBIGUOUS_SOURCE_REFERENCE',
    );
  });
  it.each(
    [
      [
        'Flag mặc định false.',
        'Đã đặt default false; thử cấu hình không khai báo thì entry bị ẩn.',
        'Đã đặt default false',
      ],
      [
        'Save giữ Draft.',
        'Đã thử Save local giữ Draft, Submit chuyển Pending review; chưa kiểm thử file đính kèm.',
      ],
      [
        'Submit chuyển Pending review.',
        'Đã thử Save local giữ Draft, Submit chuyển Pending review; chưa kiểm thử file đính kèm.',
      ],
      [
        'Evaluate macro-F1 on validation.',
        'Validation macro-F1 is 0.78; production is untested.',
      ],
      ['Author can edit.', 'Author can edit; outsiders cannot edit.'],
      ['Không retry tự động.', 'Không retry tự động.'],
      ['Focus không thoát ra nền.', 'Focus không thoát ra nền.'],
      [
        'Entry is hidden when unset.',
        'If flag is not set then entry is hidden.',
        'entry is hidden.',
      ],
    ].map(([requirement, note, quote]) => ({ requirement, note, quote })),
  )(
    'does not veto an unrelated limitation for $requirement',
    ({ requirement, note, quote }) => {
      const f = fixture(requirement, note, quote);
      expect(
        parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0]
          .status,
      ).toBe('SUPPORTED');
    },
  );
  it.each([
    [
      'Runbook có thao tác rollback và tiêu chí dừng.',
      'Runbook hướng dẫn hoàn nguyên về bản build trước; dừng khi healthcheck lỗi; nhóm vận hành chịu trách nhiệm. Chưa diễn tập rollback.',
      'Viết runbook rollback',
    ],
    [
      'Bản thiết kế mô tả loading, empty và lỗi.',
      'Bản thiết kế có loading, empty và lỗi; chưa triển khai code.',
      'Thiết kế màn chọn tổ chức',
    ],
    [
      'Đặc tả nêu phản hồi khi email trùng.',
      'Đặc tả nêu email trùng bị từ chối; chưa triển khai API.',
      'Viết đặc tả mời thành viên',
    ],
  ])(
    'does not require executing the artifact described by %s',
    (requirement, note, title) => {
      const f = fixture(requirement, note, note, title);
      expect(
        parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0]
          .status,
      ).toBe('SUPPORTED');
    },
  );
  it.each(
    [
      ['API has been tested.', 'API has not been tested.'],
      ['Focus không thoát ra nền.', 'Chưa kiểm thử focus.'],
      ['Test API A and API B.', 'Test API A passed; API B is untested.'],
      [
        'API B has been tested.',
        'API A has been tested; API B has not been tested.',
      ],
      [
        'Runbook phải được diễn tập rollback.',
        'Runbook đã viết; chưa diễn tập rollback.',
        'Viết runbook rollback',
      ],
      [
        'Triển khai API từ bản thiết kế.',
        'Bản thiết kế đã có; chưa triển khai API.',
        'Thiết kế và triển khai API',
      ],
      [
        'API trả 200.',
        'Đã thiết kế API; chưa triển khai API.',
        'Thiết kế và triển khai API',
      ],
      ['API is tested.', 'No evidence that API is tested.'],
      ['API is tested.', 'API tests are pending.'],
      ['Focus không thoát ra nền.', 'Focus testing is still pending.'],
      ['API is deployed.', 'API: pending deployment.'],
      [
        'UI has been tested.',
        'If API is ready, UI has not been tested, logging is enabled.',
      ],
      ['UI has been tested.', 'If API is not ready, UI has not been tested.'],
    ].map(([requirement, note, title]) => ({ requirement, note, title })),
  )(
    'keeps explicit noncompletion blocking coverage for $requirement',
    ({ requirement, note, title }) => {
      const f = fixture(requirement, note, note, title);
      expect(
        parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0]
          .status,
      ).toBe('PARTIAL');
    },
  );
  it.each([
    ['API has not been tested successfully.', 'been tested successfully'],
    ['Author cannot edit.', 'edit'],
    ['API chưa được kiểm thử thành công.', 'kiểm thử thành công'],
    [
      'No evidence that API was tested successfully.',
      'API was tested successfully',
    ],
    [
      'API was not tested successfully; UI was tested successfully.',
      'tested successfully',
    ],
  ])(
    'cannot support a positive result by trimming negation from %s',
    (note, quote) => {
      const f = fixture('API is tested successfully.', note, quote);
      expect(
        parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0]
          .status,
      ).toBe('PARTIAL');
      f.out.claims = [
        {
          text: quote,
          sourceRefs: [{ sourceId: 'note.body', quote }],
          originKind: 'AUTHOR_REPORT',
          supportRelation: 'FULL',
        },
      ];
      expect(() =>
        parseAssessmentOutput(f.input, JSON.stringify(f.out)),
      ).toThrow('SEMANTIC_POLARITY_MISMATCH');
    },
  );
  it('does not extract a positive Task criterion by stripping its actual prohibition', () => {
    const f = fixture(
      'Do not allow outsiders to edit.',
      'Outsiders are denied.',
    );
    f.out.taskUnderstanding.requirements[0] = {
      text: 'allow outsiders to edit.',
      sourceRefs: [
        { sourceId: 'task.description', quote: 'allow outsiders to edit.' },
      ],
    };
    expect(() => parseAssessmentOutput(f.input, JSON.stringify(f.out))).toThrow(
      'REQUIREMENT_POLARITY_MISMATCH',
    );
  });
});
