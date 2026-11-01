import type {
  AssessmentGap,
  AssessmentModelOutput,
  AssessmentPurpose,
  AssessmentView,
} from './work-note-assessment.types';

/**
 * Closed internal information-need taxonomy (Plan v3 §3).
 * Kept small (12 values) so a 14B model can classify reliably while runtime
 * preserves stable gap identity independent of surface wording or gap `kind`.
 */
export const ASSESSMENT_NEED_CODES = [
  'task.criteria',
  'purpose.intent',
  'scope.completed_part',
  'implementation.mechanism',
  'decision.choice',
  'decision.rationale',
  'incident.symptom',
  'test_context.actor',
  'test_context.scenario',
  'test_result.behavior',
  'handover.next_steps',
  'contradiction.conflict',
] as const;

export type AssessmentNeedCode = (typeof ASSESSMENT_NEED_CODES)[number];

export type TaskCompletionStatus =
  | 'CRITERIA_REPORTED_MET'
  | 'CRITERIA_INCOMPLETE'
  | 'CRITERIA_CONTRADICTED'
  | 'CRITERIA_UNSPECIFIED';

export type PurposeRubricRule = {
  purpose: Exclude<AssessmentPurpose, 'AUTO'>;
  summary: string;
  requiredForAdequacy: readonly string[];
  forbiddenExtraDemands: readonly string[];
  requireWholeTaskCoverage: boolean;
  allowedBlockingNeeds: readonly AssessmentNeedCode[];
  contrastiveExamples: {
    sufficient: { task: string; note: string; reason: string };
    insufficient: {
      task: string;
      note: string;
      missingNeed: AssessmentNeedCode;
      expectedQuestion: string;
    };
  };
};

export const PURPOSE_RUBRIC_TABLE: Record<
  Exclude<AssessmentPurpose, 'AUTO'>,
  PurposeRubricRule
> = {
  PROGRESS: {
    purpose: 'PROGRESS',
    summary:
      'Ghi nhận tiến độ hiện tại hoặc trạng thái đang bị chặn cùng giới hạn có liên quan.',
    requiredForAdequacy: [
      'Phần việc cụ thể đã thực hiện hoặc trạng thái chưa bắt đầu/đang bị chặn có lý do rõ.',
      'Giới hạn hoặc phần chưa làm/chưa kiểm thử nếu tác giả có nêu.',
    ],
    forbiddenExtraDemands: [
      'Không đòi đã hoàn thành kiểm thử cho phần chưa kiểm thử.',
      'Không đòi hoàn thành các bước checklist còn lại của toàn Task.',
      'Không đòi tài liệu vận hành hoặc nghiệm thu cuối.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: ['scope.completed_part', 'contradiction.conflict'],
    contrastiveExamples: {
      sufficient: {
        task: 'Thêm retry upload từng phần; checklist: retry file lỗi và giữ nguyên file đã lên.',
        note: 'Đã thêm nút retry cho từng file lỗi; chưa kiểm thử khi mất mạng giữa chừng.',
        reason:
          'Nêu rõ phần đã làm và giới hạn kiểm thử; tiêu chí chưa test chỉ làm Task chưa hoàn tất, không làm thiếu note Progress.',
      },
      insufficient: {
        task: 'Cập nhật bảng danh sách công việc theo múi giờ người dùng.',
        note: 'Đã xử lý xong phần bảng.',
        missingNeed: 'scope.completed_part',
        expectedQuestion: 'Bạn đã cập nhật phần cụ thể nào của bảng danh sách?',
      },
    },
  },
  DECISION: {
    purpose: 'DECISION',
    summary:
      'Ghi nhận quyết định kỹ thuật/nghiệp vụ và mục đích hoặc lý do chọn.',
    requiredForAdequacy: [
      'Phương án hoặc quyết định cụ thể đã chốt.',
      'Mục đích hoặc lý do trực tiếp đi kèm trong câu (như mệnh đề "để ...", "nhằm ...", "vì ...", "do ...", "tránh ...").',
    ],
    forbiddenExtraDemands: [
      'Không đòi đã triển khai code, đã chạy kiểm thử hoặc đã chốt tham số phụ mà tác giả nêu rõ là chưa chọn.',
      'Không đòi đã viết hướng dẫn vận hành hoặc hoàn thành các bước checklist khác của Task.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: [
      'decision.choice',
      'decision.rationale',
      'contradiction.conflict',
    ],
    contrastiveExamples: {
      sufficient: {
        task: 'Xử lý hàng đợi gửi email; checklist: cấu hình retry và có hướng dẫn vận hành retry email.',
        note: 'Chốt dùng backoff luỹ thừa tối đa 5 lần để tránh nghẽn SMTP; chưa viết hướng dẫn vận hành.',
        reason:
          'Đã có đủ quyết định và lý do; bước hướng dẫn vận hành thuộc tiến độ toàn Task, không phải điều kiện đủ của note Decision.',
      },
      insufficient: {
        task: 'Chọn định dạng lưu trữ sự kiện kiểm toán.',
        note: 'Quyết định dùng JSON Lines.',
        missingNeed: 'decision.rationale',
        expectedQuestion:
          'Ràng buộc hoặc lý do nào khiến bạn chọn định dạng JSON Lines?',
      },
    },
  },
  INCIDENT: {
    purpose: 'INCIDENT',
    summary:
      'Ghi nhận hiện tượng sự cố cụ thể và tình huống/phạm vi ảnh hưởng đang quan sát được.',
    requiredForAdequacy: [
      'Triệu chứng, mã lỗi hoặc hành vi bất thường cụ thể.',
      'Tình huống xảy ra hoặc phạm vi ảnh hưởng đã biết.',
    ],
    forbiddenExtraDemands: [
      'Không đòi nguyên nhân gốc (root cause) khi tác giả chưa xác định.',
      'Không đòi bản vá hoặc kết quả kiểm thử sau sửa khi sự cố đang mở.',
      'Không coi kết quả thực tế trái kỳ vọng của Task là mâu thuẫn lời khai của tác giả.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: ['incident.symptom', 'contradiction.conflict'],
    contrastiveExamples: {
      sufficient: {
        task: 'Nhập danh sách khách hàng từ tệp CSV UTF-8.',
        note: 'Khi tải tệp CSV có dấu tiếng Việt trên staging, API trả 400 INVALID_ENCODING ở dòng tiêu đề; chưa rõ nguyên nhân.',
        reason:
          'Đã có hiện tượng lỗi cụ thể và tình huống tái hiện; chưa biết nguyên nhân là bình thường với note Incident.',
      },
      insufficient: {
        task: 'Hiển thị biểu mẫu tạo dự án.',
        note: 'Biểu mẫu đang bị lỗi.',
        missingNeed: 'incident.symptom',
        expectedQuestion:
          'Bạn quan sát thấy thông báo lỗi hoặc hiện tượng bất thường cụ thể nào trên biểu mẫu?',
      },
    },
  },
  QA: {
    purpose: 'QA',
    summary:
      'Ghi nhận thao tác kiểm tra, phạm vi/đối tượng đã thử và kết quả quan sát được của đợt test đang báo.',
    requiredForAdequacy: [
      'Thao tác hoặc kịch bản/vai trò kiểm thử đã thực hiện.',
      'Phạm vi đang báo cáo và kết quả quan sát được (đạt/lỗi/hành vi thực tế).',
    ],
    forbiddenExtraDemands: [
      'Không đòi kiểm thử các hạng mục khác trong Task mà tác giả đã nói chưa test hoặc ngoài phạm vi đợt QA này.',
      'Không đòi toàn bộ Task đã hoàn tất.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: [
      'test_context.actor',
      'test_context.scenario',
      'test_result.behavior',
      'contradiction.conflict',
    ],
    contrastiveExamples: {
      sufficient: {
        task: 'Kiểm tra tải tệp đính kèm PDF và PNG dưới 10MB.',
        note: 'QA local: thử tải PDF 4MB và PDF giả đuôi .exe, hệ thống nhận PDF hợp lệ và chặn tệp giả; chưa test PNG.',
        reason:
          'Nêu rõ thao tác, phạm vi đã test, kết quả và giới hạn chưa test PNG.',
      },
      insufficient: {
        task: 'Kiểm tra phân quyền sửa ghi chú theo vai trò.',
        note: 'QA: đã kiểm tra quyền sửa ghi chú, chưa ghi vai trò và kết quả.',
        missingNeed: 'test_context.actor',
        expectedQuestion:
          'Bạn đã kiểm tra quyền sửa ghi chú với vai trò/tài khoản nào và kết quả ra sao?',
      },
    },
  },
  HANDOVER: {
    purpose: 'HANDOVER',
    summary:
      'Ghi nhận trạng thái hiện tại và thông tin/thao tác cần thiết để người nhận tiếp tục công việc.',
    requiredForAdequacy: [
      'Trạng thái phần việc đã xong và phần còn tồn đọng/rủi ro.',
      'Thông tin cấu hình, điểm tiếp nhận hoặc bước thao tác để người nhận làm tiếp.',
    ],
    forbiddenExtraDemands: [
      'Không đòi người nhận đã xác nhận đọc bàn giao nếu Task không có tiêu chí đó.',
      'Không đòi người giao phải hoàn tất nốt phần việc đang bàn giao.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: ['handover.next_steps', 'contradiction.conflict'],
    contrastiveExamples: {
      sufficient: {
        task: 'Bàn giao worker đồng bộ lịch trực.',
        note: 'Worker đã chạy ổn định trên staging; cần bật biến SYNC_CRON khi lên prod và chạy lệnh npm run sync:verify để kiểm tra.',
        reason:
          'Đủ trạng thái hiện tại và bước hành động cụ thể cho người nhận.',
      },
      insufficient: {
        task: 'Bàn giao hàng đợi retry email kèm quy trình xử lý thư lỗi.',
        note: 'Đã đẩy nhánh retry email, nhờ ca sau theo dõi tiếp.',
        missingNeed: 'handover.next_steps',
        expectedQuestion:
          'Người nhận cần thao tác hoặc cấu hình cụ thể nào để theo dõi và xử lý hàng đợi retry email?',
      },
    },
  },
  COMPLETION: {
    purpose: 'COMPLETION',
    summary:
      'Báo cáo hoàn thành đáp ứng đầy đủ các tiêu chí thực sự có trong Task đã tải.',
    requiredForAdequacy: [
      'Task có tiêu chí rõ ràng từ nguồn Task chính thức (taskContextStatus = CLEAR).',
      'Mọi tiêu chí thực sự của Task đều có bằng chứng tác giả báo cáo đạt (coverage = SUPPORTED, không mâu thuẫn).',
    ],
    forbiddenExtraDemands: [
      'Không tự bịa thêm điều kiện nghiệm thu ngoài văn bản Task/checklist (ví dụ tự đòi load test, runbook hoặc duyệt chéo khi Task không nêu).',
      'Không coi lời báo của tác giả là bằng chứng xác minh độc lập (giữ AUTHOR_REPORTED).',
    ],
    requireWholeTaskCoverage: true,
    allowedBlockingNeeds: [
      'task.criteria',
      'scope.completed_part',
      'implementation.mechanism',
      'test_context.actor',
      'test_context.scenario',
      'test_result.behavior',
      'contradiction.conflict',
    ],
    contrastiveExamples: {
      sufficient: {
        task: 'Kiểm tra quyền sửa Task Note: tác giả sửa được; người ngoài project bị từ chối.',
        note: 'Đã kiểm tra local: tài khoản tác giả sửa và lưu thành công, tài khoản ngoài project nhận 403.',
        reason:
          'Đáp ứng đủ cả hai tiêu chí thực tế của Task mà không thiếu actor hay kết quả.',
      },
      insufficient: {
        task: 'Kiểm tra quyền sửa Task Note: tác giả sửa được; người ngoài project bị từ chối.',
        note: 'Đã kiểm tra quyền sửa Task Note, chưa ghi actor nào.',
        missingNeed: 'test_context.actor',
        expectedQuestion:
          'Bạn đã kiểm tra với những vai trò/tài khoản nào và kết quả cho từng vai trò ra sao?',
      },
    },
  },
  OTHER: {
    purpose: 'OTHER',
    summary:
      'Ghi chú tham chiếu hoặc lưu ý chung không nhằm tuyên bố hoàn thành Task.',
    requiredForAdequacy: [
      'Nội dung ghi chú rõ nghĩa, tự nhất quán và không mâu thuẫn nội tại.',
    ],
    forbiddenExtraDemands: [
      'Không đòi hoàn thành tiêu chí Task hoặc kết quả kiểm thử toàn Task.',
    ],
    requireWholeTaskCoverage: false,
    allowedBlockingNeeds: ['purpose.intent', 'contradiction.conflict'],
    contrastiveExamples: {
      sufficient: {
        task: ' Chuẩn hóa API thanh toán.',
        note: 'Lưu ý tham khảo tài liệu đối soát v2 của cổng thanh toán khi đọc mã lỗi.',
        reason: 'Thông tin tham chiếu rõ nghĩa, không tuyên bố hoàn thành.',
      },
      insufficient: {
        task: 'Chuẩn hóa API thanh toán.',
        note: 'Ghi tạm.',
        missingNeed: 'purpose.intent',
        expectedQuestion:
          'Bạn muốn lưu thông tin cụ thể nào trong ghi chú này?',
      },
    },
  },
};

export const AUTO_PURPOSE_RESOLUTION_POLICY = {
  rule:
    'Khi purpose đầu vào là AUTO, suy diễn mục đích hẹp nhất khớp trực tiếp với lời tác giả: ' +
    'chỉ chọn COMPLETION khi tác giả tuyên bố đã hoàn tất toàn bộ Task/hạng mục nghiệm thu; ' +
    'nếu tác giả báo phần việc đang làm hoặc nêu phần chưa làm/chưa test thì chọn PROGRESS; ' +
    'nếu báo hiện tượng lỗi chọn INCIDENT; nếu chốt phương án kèm lựa chọn chọn DECISION; ' +
    'nếu báo đợt chạy thử chọn QA; nếu chuyển giao ca/người nhận chọn HANDOVER; ' +
    'nếu ghi chú tham chiếu chung chọn OTHER.',
} as const;

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[đĐ]/gu, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function isAssessmentNeedCode(v: unknown): v is AssessmentNeedCode {
  return (
    typeof v === 'string' &&
    (ASSESSMENT_NEED_CODES as readonly string[]).includes(v)
  );
}

/**
 * Deterministically maps any gap (with or without explicit model `needCode`)
 * onto the canonical 12-code information-need taxonomy.
 */
export function classifyGapNeedCode(
  gap: Pick<AssessmentGap, 'kind' | 'owner' | 'target'> & {
    needCode?: AssessmentNeedCode;
  },
  purpose?: AssessmentPurpose,
): AssessmentNeedCode {
  if (gap.needCode && isAssessmentNeedCode(gap.needCode)) {
    if (gap.owner === 'TASK_REQUIREMENT_OWNER') return 'task.criteria';
    if (gap.kind === 'CONTRADICTION') return 'contradiction.conflict';
    return gap.needCode;
  }
  if (gap.owner === 'TASK_REQUIREMENT_OWNER') return 'task.criteria';
  if (gap.kind === 'CONTRADICTION') return 'contradiction.conflict';
  if (gap.kind === 'PURPOSE') return 'purpose.intent';

  const t = fold(gap.target);
  if (
    /\b(?:actor|vai tro|tai khoan|user|nguoi dung|permission|quyen|role|author|tac gia|outsider|nguoi ngoai|member)\b/u.test(
      t,
    )
  )
    return 'test_context.actor';
  if (
    purpose === 'DECISION' ||
    /\b(?:ly do|rationale|reason|rang buoc|constraint|trade\s*off|tai sao|vi sao)\b/u.test(
      t,
    )
  ) {
    if (
      /\b(?:phuong an|lua chon|choice|option|quyet dinh chon)\b/u.test(t) &&
      !/\b(?:ly do|rationale|reason|rang buoc)\b/u.test(t)
    )
      return 'decision.choice';
    return 'decision.rationale';
  }
  if (
    purpose === 'HANDOVER' ||
    /\b(?:ban giao|handover|nguoi nhan|tiep tuc|runbook|van hanh|operating|chay lai|tiep nhan)\b/u.test(
      t,
    )
  )
    return 'handover.next_steps';
  if (
    purpose === 'INCIDENT' ||
    /\b(?:hien tuong|symptom|thong bao loi|error message|stack|status code|ma loi|anh huong|impact)\b/u.test(
      t,
    )
  )
    return 'incident.symptom';
  if (
    /\b(?:moi truong|environment|staging|local|prod|production|kich ban|scenario|ca thu|test case|du lieu thu|input|edge case|trinh duyet|browser)\b/u.test(
      t,
    )
  )
    return 'test_context.scenario';
  if (
    gap.kind === 'IMPLEMENTATION' ||
    /\b(?:cach|co che|mechanism|cau hinh|config|nguon du lieu|data source|thuat toan|library)\b/u.test(
      t,
    )
  )
    return 'implementation.mechanism';
  if (
    gap.kind === 'SCOPE' ||
    /\b(?:phan viec|pham vi|hang muc|phan nao|completed part|scope)\b/u.test(t)
  )
    return 'scope.completed_part';
  return 'test_result.behavior';
}

export function extractGapNeedCode(gapId: string): AssessmentNeedCode | null {
  const match = /^gap-([a-z_]+\.[a-z_]+)-[a-f0-9]{12,32}$/u.exec(gapId);
  return match && isAssessmentNeedCode(match[1]) ? match[1] : null;
}

/**
 * Deterministic 3rd independent conclusion (Plan v3 §1 & §5):
 * Separates overall Task criteria coverage from note adequacy for the current purpose.
 */
export function deriveTaskCompletionStatus(
  view: Pick<
    AssessmentView,
    'taskContextStatus' | 'taskUnderstanding' | 'coverage'
  >,
): TaskCompletionStatus {
  const requirements = view.taskUnderstanding.requirements;
  if (view.taskContextStatus === 'INSUFFICIENT' || requirements.length === 0)
    return 'CRITERIA_UNSPECIFIED';
  if (view.coverage.some((c) => c.status === 'CONTRADICTORY'))
    return 'CRITERIA_CONTRADICTED';
  const allSupported =
    view.taskContextStatus === 'CLEAR' &&
    view.coverage.length === requirements.length &&
    requirements.every((req) =>
      view.coverage.some(
        (c) => c.requirementId === req.id && c.status === 'SUPPORTED',
      ),
    );
  return allSupported ? 'CRITERIA_REPORTED_MET' : 'CRITERIA_INCOMPLETE';
}

export function checkRawModelOutputConsistency(
  out: AssessmentModelOutput,
): string[] {
  const violations: string[] = [];
  const hasBlocking = out.gaps.some((g) => g.impact === 'BLOCKING');
  if (out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' && hasBlocking)
    violations.push('ENOUGH_WITH_BLOCKING_GAP');
  if (out.noteAdequacy === 'ENOUGH_FOR_PURPOSE' && out.nextQuestion !== null)
    violations.push('ENOUGH_WITH_QUESTION');
  if (out.noteAdequacy === 'CONTRADICTORY' && out.nextQuestion !== null)
    violations.push('CONTRADICTORY_WITH_QUESTION');
  if (out.nextQuestion !== null) {
    const gap = out.gaps[out.nextQuestion.gapIndex];
    if (!gap) violations.push('QUESTION_WITHOUT_GAP');
    else if (gap.impact !== 'BLOCKING')
      violations.push('QUESTION_ON_OPTIONAL_GAP');
  }
  return violations;
}
