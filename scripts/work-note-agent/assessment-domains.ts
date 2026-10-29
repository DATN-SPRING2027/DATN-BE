import {
  loadAssessmentCorpus,
  type AssessmentCorpus,
  type AssessmentScenario,
} from './assessment-evaluation';

/** Evaluation tags only: these never become model instructions or claimed Task categories. */
export const assessmentDomains: {
  id: string;
  label: string;
  families: string[];
}[] = [
  {
    id: 'frontend',
    label: 'Frontend và trạng thái giao diện',
    families: [
      'timezone-date',
      'locale-plural',
      'organization-selector',
      'human-message',
    ],
  },
  {
    id: 'ux-design',
    label: 'Thiết kế UX và accessibility',
    families: ['keyboard-dialog', 'ux-design-spec'],
  },
  {
    id: 'backend',
    label: 'Backend và API contract',
    families: [
      'workspace-context',
      'webhook-idempotency',
      'contract-schema',
      'task-scope',
      'task-fetch-status',
    ],
  },
  {
    id: 'database',
    label: 'Database và migration',
    families: ['migration-replay', 'file-dedup', 'import-validation'],
  },
  {
    id: 'qa',
    label: 'QA và chất lượng bằng chứng',
    families: [
      'permission-matrix',
      'attachment-mime',
      'human-message',
      'waiting-feedback',
      'injection-log',
      'multilang-negation',
      'task-fetch-status',
    ],
  },
  {
    id: 'security',
    label: 'Bảo mật và phân quyền',
    families: [
      'refresh-token',
      'signed-url',
      'audit-event',
      'cache-header',
      'permission-matrix',
      'attachment-mime',
    ],
  },
  {
    id: 'devops',
    label: 'DevOps và vận hành sự cố',
    families: [
      'release-claim',
      'feature-flag',
      'rollback-check',
      'trace-cause',
    ],
  },
  {
    id: 'data',
    label: 'Dữ liệu và import/export',
    families: ['csv-unicode', 'import-validation', 'file-dedup'],
  },
  {
    id: 'ai-ml',
    label: 'AI/ML và đánh giá model',
    families: ['ai-model-evaluation'],
  },
  {
    id: 'product-ba',
    label: 'BA/Product và quy tắc nghiệp vụ',
    families: [
      'invoice-rounding',
      'task-scope',
      'product-acceptance-spec',
      'report-save',
    ],
  },
  {
    id: 'documentation',
    label: 'Tài liệu và bàn giao',
    families: [
      'mail-queue',
      'project-archive',
      'reset-progress',
      'runbook-documentation',
    ],
  },
  {
    id: 'integration',
    label: 'Tích hợp, hàng đợi và thông báo',
    families: [
      'retry-upload',
      'notification-duplicate',
      'mail-queue',
      'billing-webhook',
      'webhook-idempotency',
    ],
  },
  {
    id: 'performance',
    label: 'Hiệu năng và cache',
    families: ['search-latency', 'cache-header', 'reset-progress'],
  },
];

const additionalTasks = [
  {
    family: 'ux-design-spec',
    title: 'Thiết kế màn chọn tổ chức',
    requirements: [
      'Bản thiết kế mô tả trạng thái loading, empty và lỗi.',
      'Mô tả thứ tự focus và hành vi phím Escape cho dialog.',
    ],
    complete:
      'Bản thiết kế đã có loading, empty, lỗi; thứ tự focus đi từ ô tìm kiếm đến danh sách và nút xác nhận; Escape đóng dialog. Chưa triển khai code.',
    incomplete: 'Đã hoàn thành bản thiết kế màn chọn tổ chức.',
    topic: 'loading|empty|lỗi|focus|Escape|trạng thái|bàn phím',
    accepted:
      'Completion means the design specification is complete. Do not require implemented UI or executed browser tests when the Task asks only for design.',
  },
  {
    family: 'ai-model-evaluation',
    title: 'Đánh giá bộ phân loại mức ưu tiên',
    requirements: [
      'Đo macro-F1 trên tập validation đóng băng.',
      'So sánh với baseline trên cùng bộ dữ liệu.',
    ],
    complete:
      'Đã đo trên tập validation đóng băng eval-01: macro-F1 của model là 0.78, baseline là 0.73 trên cùng tập. Chưa đo production.',
    incomplete: 'Model hiện cho kết quả tốt.',
    topic: 'macro|F1|validation|baseline|dữ liệu|đánh giá|kết quả',
    accepted:
      'Treat supplied metrics as synthetic author reports, not independent verification or production performance. Ask for evaluation context/comparison when absent.',
  },
  {
    family: 'product-acceptance-spec',
    title: 'Viết tiêu chí mời thành viên',
    requirements: [
      'Đặc tả chỉ cho phép quản lý gửi lời mời thành viên.',
      'Nêu phản hồi khi email đã có lời mời đang chờ.',
    ],
    complete:
      'Đặc tả đã ghi chỉ quản lý được gửi lời mời; email có lời mời đang chờ thì hiển thị thông báo đã mời và không tạo lời mời trùng. Chưa triển khai API.',
    incomplete: 'Đã chốt đặc tả mời thành viên.',
    topic: 'quản lý|vai trò|quyền|email|trùng|đang chờ|lời mời',
    accepted:
      'Assess specification content; do not require deployed APIs, stakeholder approval or a new policy absent from the Task.',
  },
  {
    family: 'runbook-documentation',
    title: 'Viết runbook rollback',
    requirements: [
      'Runbook có thao tác rollback và tiêu chí dừng.',
      'Nêu rõ nhóm chịu trách nhiệm vận hành.',
    ],
    complete:
      'Runbook hướng dẫn hoàn nguyên về bản build trước; dừng khi healthcheck lỗi; nhóm vận hành chịu trách nhiệm. Chưa diễn tập rollback.',
    incomplete: 'Đã viết xong runbook rollback.',
    topic: 'rollback|thao tác|dừng|healthcheck|trách nhiệm|vận hành|nhóm',
    accepted:
      'Writing a runbook is distinct from executing rollback. Preserve the explicit untested limitation without inventing an execution requirement.',
  },
];

export function loadDomainAssessmentCorpus(): AssessmentCorpus {
  const scenarios: AssessmentScenario[] = additionalTasks.flatMap((t) =>
    ['complete', 'incomplete'].map((variant) => {
      const complete = variant === 'complete';
      const makeSource = (id: string, kind: 'TASK' | 'NOTE', text: string) => ({
        id,
        kind,
        label: id,
        text,
        version: 'domain-challenge-v1',
        loadStatus: 'LOADED' as const,
        includedInRequest: true,
      });
      return {
        id: `domain-${t.family}-${variant}`,
        family: t.family,
        category: `domain-${variant}`,
        split: 'validation' as const,
        synthetic: true as const,
        pilot: false,
        critical: false,
        purpose: 'COMPLETION' as const,
        sources: [
          makeSource('task.title', 'TASK', t.title),
          makeSource('task.description', 'TASK', t.requirements.join('\n')),
          ...t.requirements.map((r, i) =>
            makeSource(`task.step.${i}`, 'TASK', r),
          ),
          makeSource('task.status', 'TASK', 'IN_PROGRESS'),
          makeSource('note.title', 'NOTE', `Synthetic ${t.family}`),
          makeSource('note.body', 'NOTE', complete ? t.complete : t.incomplete),
        ],
        turns: [
          {
            action: 'assess' as const,
            expected: {
              taskContextStatus: ['CLEAR' as const, 'PARTIAL' as const],
              noteAdequacy: complete
                ? ['ENOUGH_FOR_PURPOSE' as const]
                : ['NEEDS_AUTHOR_INPUT' as const, 'UNDETERMINED' as const],
              question: complete ? ('none' as const) : ('required' as const),
              questionGapKinds: ['EVIDENCE'],
              questionTopicPatterns: [t.topic],
              forbiddenAssertions: [
                'independently verified',
                'đã được kiểm chứng độc lập',
                'production.*(?:passed|thành công)',
              ],
              minReportedClaims: 1,
              requirements: 'grounded' as const,
            },
          },
        ],
        rubric: {
          accepted: [
            t.accepted,
            'Use only Task, note and scoped answers; keep taskContextStatus separate from adequacy.',
          ],
          prohibited: [
            'Do not invent or rewrite Task criteria.',
            'Do not require execution when the deliverable is a specification.',
            'Do not ask an already answered/unknown/skipped point or invent validation.',
          ],
          questionUtility: `Ask only about a missing ${t.topic} detail needed for this deliverable.`,
        },
      };
    }),
  );
  return {
    version: 'task-note-domain-challenge/2026-10-29.v1',
    classification: 'synthetic-only',
    splitPolicy:
      'Eight new authored evaluation cases; never inserted into prompt examples. Validation tag denotes this separate challenge, not the original twelve-case validation split. No independent reviewer labels.',
    scenarios,
  };
}

export function createAssessmentCampaign(): AssessmentCorpus {
  const base = loadAssessmentCorpus(),
    extra = loadDomainAssessmentCorpus();
  return {
    version: 'task-note-cross-domain-campaign/2026-10-29.v1',
    classification: 'synthetic-only',
    splitPolicy: `${base.splitPolicy} Original validation first, then holdout, development and eight separately tagged domain challenge cases. Prompts and rubrics remain frozen throughout this campaign.`,
    scenarios: [
      ...base.scenarios.filter((s) => s.split === 'validation'),
      ...base.scenarios.filter((s) => s.split === 'holdout'),
      ...base.scenarios.filter((s) => s.split === 'development'),
      ...extra.scenarios,
    ],
  };
}
