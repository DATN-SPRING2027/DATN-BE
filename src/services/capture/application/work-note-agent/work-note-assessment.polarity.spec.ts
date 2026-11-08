import { parseAssessmentOutput } from './work-note-assessment.protocol';
import { assembleAssessment } from './work-note-assessment.state';
import {
  coveragePolarityConflict,
  hasNegation,
} from './work-note-assessment.polarity';
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
  it('preserves coverage when adjacent fully grounded author claims jointly cover the evidence quote', () => {
    const first = 'Added normalization to the label parser;';
    const second = 'verified invalid labels return HTTP 400.';
    const f = fixture(
      'Normalize labels and reject invalid labels.',
      `${first} ${second}`,
    );
    f.out.claims = [first, second].map((text) => ({
      text,
      originKind: 'AUTHOR_REPORT',
      supportRelation: 'FULL',
      sourceRefs: [{ sourceId: 'note.body', quote: text }],
    }));
    expect(
      parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0].status,
    ).toBe('SUPPORTED');
  });

  it.each(['unclaimed text', 'partially grounded claim', 'different source'])(
    'does not bridge a compound coverage quote over %s',
    (variant) => {
      const first = 'Added normalization to the label parser;';
      const second = 'verified invalid labels return HTTP 400.';
      const middle =
        variant === 'unclaimed text' ? ' recorded the deployment event;' : '';
      const f = fixture(
        'Normalize labels and reject invalid labels.',
        `${first}${middle} ${second}`,
      );
      if (variant === 'different source')
        f.input.sources.push({
          ...f.input.sources[2],
          id: 'note.title',
          text: second,
        });
      f.out.claims = [
        {
          text: first,
          originKind: 'AUTHOR_REPORT',
          supportRelation: 'FULL',
          sourceRefs: [{ sourceId: 'note.body', quote: first }],
        },
        {
          text: second,
          originKind: 'AUTHOR_REPORT',
          supportRelation:
            variant === 'partially grounded claim' ? 'PARTIAL' : 'FULL',
          sourceRefs: [
            {
              sourceId:
                variant === 'different source' ? 'note.title' : 'note.body',
              quote: second,
            },
          ],
        },
      ];
      expect(
        parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0]
          .status,
      ).toBe('PARTIAL');
    },
  );

  it('keeps negation for unperformed registration ("Chưa đăng ký webhook thanh toán.") while allowing control for blocking unregistered queries ("Đã chặn query chưa đăng ký.")', () => {
    const unperformedReq = 'Đăng ký webhook thanh toán.';
    const unperformedNote = 'Chưa đăng ký webhook thanh toán.';
    expect(hasNegation(unperformedNote)).toBe(true);
    expect(
      coveragePolarityConflict(
        unperformedReq,
        unperformedNote,
        unperformedNote,
        'Tích hợp thanh toán',
      ),
    ).toBe(true);

    const fUnperformed = fixture(unperformedReq, unperformedNote);
    const parsedUnperformed = parseAssessmentOutput(
      fUnperformed.input,
      JSON.stringify(fUnperformed.out),
    );
    expect(parsedUnperformed.coverage[0].status).toBe('PARTIAL');
    const assembledUnperformed = assembleAssessment(
      fUnperformed.input,
      parsedUnperformed,
      {
        sourceRevision: 1,
        taskContextHash: 'h1',
        model: 'synthetic/test',
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    );
    expect(assembledUnperformed.noteAdequacy).toBe('UNDETERMINED');
    expect(assembledUnperformed.state).toBe('missing_context');

    const unperformedQueryReq = 'Đăng ký truy vấn tùy ý vào persisted query.';
    const unperformedQueryNote = 'Truy vấn tùy ý chưa đăng ký';
    expect(hasNegation(unperformedQueryNote)).toBe(true);
    expect(
      coveragePolarityConflict(
        unperformedQueryReq,
        unperformedQueryNote,
        unperformedQueryNote,
        'Bảo mật GraphQL',
      ),
    ).toBe(true);
    const fUnperformedQuery = fixture(
      unperformedQueryReq,
      unperformedQueryNote,
    );
    const parsedUnperformedQuery = parseAssessmentOutput(
      fUnperformedQuery.input,
      JSON.stringify(fUnperformedQuery.out),
    );
    expect(parsedUnperformedQuery.coverage[0].status).toBe('PARTIAL');
    const assembledUnperformedQuery = assembleAssessment(
      fUnperformedQuery.input,
      parsedUnperformedQuery,
      {
        sourceRevision: 1,
        taskContextHash: 'h1',
        model: 'synthetic/test',
        expiresAt: '2026-12-31T00:00:00.000Z',
      },
    );
    expect(assembledUnperformedQuery.noteAdequacy).toBe('UNDETERMINED');
    expect(assembledUnperformedQuery.state).toBe('missing_context');

    const controlReq =
      'Chỉ cho phép persisted query đã đăng ký; từ chối query ngoài whitelist.';
    const controlNote = 'Đã chặn query chưa đăng ký.';
    expect(hasNegation(controlNote)).toBe(false);
    expect(
      coveragePolarityConflict(
        controlReq,
        controlNote,
        controlNote,
        'Bảo mật GraphQL',
      ),
    ).toBe(false);
    const fControl = fixture(controlReq, controlNote);
    const parsedControl = parseAssessmentOutput(
      fControl.input,
      JSON.stringify(fControl.out),
    );
    expect(parsedControl.coverage[0].status).toBe('SUPPORTED');
    const assembledControl = assembleAssessment(fControl.input, parsedControl, {
      sourceRevision: 1,
      taskContextHash: 'h1',
      model: 'synthetic/test',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(assembledControl.noteAdequacy).toBe('ENOUGH_FOR_PURPOSE');
    expect(assembledControl.state).toBe('ready_to_edit');
  });

  it.each([
    {
      context: 'a comma-separated registration claim',
      requirement: 'Đăng ký truy vấn tùy ý.',
      note: 'Đã chặn request lỗi, truy vấn tùy ý chưa đăng ký.',
      quote: 'truy vấn tùy ý chưa đăng ký.',
      expectedCoverage: 'PARTIAL',
      expectedState: 'missing_context',
    },
    {
      context: 'a comma-separated registration claim citing the full sentence',
      requirement: 'Đăng ký truy vấn tùy ý.',
      note: 'Đã chặn request lỗi, truy vấn tùy ý chưa đăng ký.',
      expectedCoverage: 'PARTIAL',
      expectedState: 'missing_context',
    },
    {
      context: 'a registration claim joined by a conjunction',
      requirement: 'Đăng ký truy vấn tùy ý.',
      note: 'Đã chặn request lỗi và truy vấn tùy ý chưa đăng ký.',
      quote: 'truy vấn tùy ý chưa đăng ký.',
      expectedCoverage: 'PARTIAL',
      expectedState: 'missing_context',
    },
    {
      context: 'a long blocking action with an explicit object link',
      requirement: 'Chặn mọi truy vấn tùy ý chưa đăng ký.',
      note: 'Đã chặn toàn bộ yêu cầu thực thi tại production đối với mọi truy vấn tùy ý chưa đăng ký.',
      expectedCoverage: 'SUPPORTED',
      expectedState: 'ready_to_edit',
    },
  ])('scopes negation to $context', (scenario) => {
    const quote = scenario.quote ?? scenario.note;
    const { input, out } = fixture(scenario.requirement, scenario.note, quote);
    out.claims[0].text = quote;
    out.claims[0].sourceRefs[0].quote = quote;

    const parsed = parseAssessmentOutput(input, JSON.stringify(out));
    expect(parsed.coverage[0].status).toBe(scenario.expectedCoverage);
    const assembled = assembleAssessment(input, parsed, {
      sourceRevision: 1,
      taskContextHash: 'h1',
      model: 'synthetic/test',
      expiresAt: '2026-12-31T00:00:00.000Z',
    });
    expect(assembled.state).toBe(scenario.expectedState);
  });

  it('recognizes a prohibition requirement as negative when the author reports compliance', () => {
    const f = fixture(
      'Nghiêm cấm ghi mã truy cập ra tệp bền vững.',
      'Đã kiểm tra bộ lưu trữ, không ghi mã truy cập ra tệp bền vững.',
    );
    expect(
      parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0].status,
    ).toBe('SUPPORTED');
  });
  it('still rejects negative evidence for a positive persistence requirement', () => {
    const f = fixture(
      'Phải ghi nhật ký tác vụ ra tệp bền vững.',
      'Đã kiểm tra bộ lưu trữ, không ghi nhật ký tác vụ ra tệp bền vững.',
    );
    expect(
      parseAssessmentOutput(f.input, JSON.stringify(f.out)).coverage[0].status,
    ).toBe('PARTIAL');
  });
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
      [
        'Thiếu mã định danh bị từ chối.',
        'Đã thử file mẫu thiếu mã trên local: trả lỗi validation và không tạo bản ghi.',
        'trả lỗi validation',
      ],
      [
        'Người ngoài project bị từ chối.',
        'Đã kiểm tra local: tác giả sửa được, người ngoài project nhận từ chối; chưa kiểm thử khi membership vừa bị thu hồi.',
        'Đã kiểm tra local: tác giả sửa được, người ngoài project nhận từ chối; chưa kiểm thử khi membership vừa bị thu hồi.',
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

  describe('D10a (F15 / G2): contiguous literal clause substring claims and adversarial vetoes', () => {
    function evalClaimRelation(note: string, quote: string, claimText: string) {
      const f = fixture('Kiểm tra phân quyền tổ chức.', note, quote);
      f.out.claims = [
        {
          text: claimText,
          sourceRefs: [{ sourceId: 'note.body', quote }],
          originKind: 'AUTHOR_REPORT',
          supportRelation: 'FULL',
        },
      ];
      f.out.coverage = [
        { requirementIndex: 0, status: 'PARTIAL', sourceRefs: [] },
      ];
      f.out.noteAdequacy = 'UNDETERMINED';
      const parsed = parseAssessmentOutput(f.input, JSON.stringify(f.out));
      return parsed.claims[0].supportRelation;
    }

    // Group 1: Dropped negation (>= 3 cases VI + EN)
    it.each([
      [
        'Đã chạy nhưng chưa kiểm thử staging cho cổng thanh toán.',
        'kiểm thử staging cho cổng thanh toán',
      ],
      [
        'Đã viết migration, không triển khai cụm cơ sở dữ liệu phụ.',
        'triển khai cụm cơ sở dữ liệu phụ',
      ],
      [
        ' deployed worker queue, but never verified webhook signature validation.',
        'verified webhook signature validation',
      ],
      [
        'The batch importer has not completed reconciliation for invoice ledger.',
        'completed reconciliation for invoice ledger',
      ],
    ])(
      'Adversarial Group 1 (dropped negation): rejects FULL for %s -> %s',
      (note, claimText) => {
        const result = () => evalClaimRelation(note, note, claimText);
        try {
          expect(result()).toBe('PARTIAL');
        } catch (err) {
          expect((err as Error).message).toBe('SEMANTIC_POLARITY_MISMATCH');
        }
      },
    );

    // Group 2: Flipped completion / status (>= 3 cases VI + EN)
    it.each([
      [
        'Đã xong phần biểu mẫu đăng ký, chưa xong phần xác thực hai lớp.',
        'xong phần xác thực hai lớp',
      ],
      [
        'Đã hoàn thành API danh mục, chưa hoàn thành bộ lọc phân trang.',
        'hoàn thành bộ lọc phân trang',
      ],
      [
        'Completed user profile endpoint; have not completed audit export job.',
        'completed audit export job',
      ],
      [
        'Staging smoke suite passed, production smoke suite has not passed.',
        'production smoke suite has passed',
      ],
    ])(
      'Adversarial Group 2 (flipped completion status): rejects FULL for %s -> %s',
      (note, claimText) => {
        const result = () => evalClaimRelation(note, note, claimText);
        try {
          expect(result()).toBe('PARTIAL');
        } catch (err) {
          expect((err as Error).message).toBe('SEMANTIC_POLARITY_MISMATCH');
        }
      },
    );

    // Group 3: Meaning-changing conditional / mid-clause truncation (>= 3 cases VI + EN)
    it.each([
      [
        'Nếu bật cờ định tuyến mới thì API thanh toán trả 200.',
        'API thanh toán trả 200',
      ],
      [
        'Chỉ khi tài khoản có quyền quản trị, giao diện mới cho phép xóa dự án.',
        'giao diện mới cho phép xóa dự án',
      ],
      [
        'API xuất báo cáo trả mã 200 nếu tệp nhỏ hơn 5MB.',
        'API xuất báo cáo trả mã 200',
      ],
      [
        'If feature flag billing_v2 is enabled, checkout endpoint returns HTTP 200.',
        'checkout endpoint returns HTTP 200',
      ],
      [
        'Unless token is revoked, session refresh endpoint issues a new cookie.',
        'session refresh endpoint issues a new cookie',
      ],
    ])(
      'Adversarial Group 3 (meaning-changing conditional truncation): downgrades to PARTIAL for %s -> %s',
      (note, claimText) => {
        expect(evalClaimRelation(note, note, claimText)).toBe('PARTIAL');
      },
    );

    // Group 4: Insufficient context / dropped adverse failure outcome or too-short fragment (>= 3 cases VI + EN)
    it.each([
      [
        'Đã chạy kiểm thử luồng đồng bộ kho hàng nhưng thất bại.',
        'Đã chạy kiểm thử luồng đồng bộ kho hàng',
      ],
      [
        'Đã thực hiện đối soát bảng lương tháng mười, kết quả bị lỗi timeout.',
        'Đã thực hiện đối soát bảng lương tháng mười',
      ],
      [
        'Ran integration suite for webhook retry worker, but staging failed.',
        'Ran integration suite for webhook retry worker',
      ],
      ['Đã chạy thử nghiệm, và đã ghi nhận kết quả.', 'Đã chạy'],
    ])(
      'Adversarial Group 4 (insufficient context / dropped adverse outcome): downgrades to PARTIAL for %s -> %s',
      (note, claimText) => {
        expect(evalClaimRelation(note, note, claimText)).toBe('PARTIAL');
      },
    );

    // Group 5: Non-contiguous stitched claims & ambiguous repeated substrings (>= 3 cases VI + EN)
    it.each([
      [
        'Phần đăng nhập xong; phần giỏ hàng chưa xong; phần thanh toán xong.',
        'Phần đăng nhập xong; phần thanh toán xong',
      ],
      [
        'Module A passed unit tests; Module B failed; Module C passed unit tests.',
        'Module A passed unit tests Module C passed unit tests',
      ],
      [
        'Tài khoản nội bộ đọc được báo cáo và xuất được tệp CSV trên local.',
        'Tài khoản nội bộ xuất được tệp CSV trên local',
      ],
      [
        'Tài khoản nhóm A nhận mã 200; sau khi tải lại, tài khoản nhóm A nhận mã 200.',
        'tài khoản nhóm A nhận mã 200',
      ],
    ])(
      'Adversarial Group 5 (non-contiguous stitched or ambiguous repeated substring): downgrades to PARTIAL for %s -> %s',
      (note, claimText) => {
        expect(evalClaimRelation(note, note, claimText)).toBe('PARTIAL');
      },
    );

    // Group 6: Valid contiguous literal clause substrings (positive controls VI + EN)
    it.each([
      [
        'Tài khoản thuộc nhóm A đọc được hồ sơ nội bộ, và tài khoản thuộc nhóm B nhận 403.',
        'tài khoản thuộc nhóm B nhận 403',
      ],
      [
        'Tài khoản thuộc nhóm A đọc được hồ sơ nội bộ, và tài khoản thuộc nhóm B nhận 403.',
        'Tài khoản thuộc nhóm A đọc được hồ sơ nội bộ',
      ],
      [
        'Admin session can rotate signing keys; guest session receives 403 Forbidden.',
        'guest session receives 403 Forbidden',
      ],
      [
        'Đã thêm chỉ mục tìm kiếm hóa đơn; chưa kiểm thử tải cao trên staging.',
        'Đã thêm chỉ mục tìm kiếm hóa đơn',
      ],
    ])(
      'Valid Group 6 (genuine contiguous clause substring): preserves FULL for %s -> %s',
      (note, claimText) => {
        expect(evalClaimRelation(note, note, claimText)).toBe('FULL');
      },
    );
  });
});
