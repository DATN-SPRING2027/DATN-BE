import {
  buildTaskNoteMarkdownArtifact,
  buildWorkReportMarkdownArtifact,
} from './markdown-artifact.builder';

describe('MarkdownArtifactBuilder', () => {
  it('builds a deterministic UTF-8 .md artifact and SHA-256 hash for freeform and legacy Task Notes', () => {
    const freeform = buildTaskNoteMarkdownArtifact({
      noteId: '65f000000000000000000011',
      title: 'Tối ưu pipeline đồng bộ R2 & SAG',
      taskKey: 'DATN-42',
      taskTitle: 'Chuẩn hóa Upload Progress',
      authorName: 'Nguyễn Thành Tài',
      version: 2,
      approvedAt: '2026-11-02T14:00:00.000Z',
      contentMarkdown: '## Kết quả\n\nĐã giảm thời gian duyệt xuống dưới 20ms.',
    });

    expect(freeform.contentType).toBe('text/markdown');
    expect(freeform.fileName).toBe(
      'TASK-DATN-42-Toi-uu-pipeline-dong-bo-R2-SAG-v2.md',
    );
    expect(freeform.size).toBe(freeform.bytes.byteLength);
    expect(freeform.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(freeform.markdownText).toContain(
      '# Tối ưu pipeline đồng bộ R2 & SAG',
    );
    expect(freeform.markdownText).toContain(
      '#DATN-42 — Chuẩn hóa Upload Progress',
    );
    expect(freeform.markdownText).toContain('## Kết quả');

    const legacy = buildTaskNoteMarkdownArtifact({
      noteId: '65f000000000000000000012',
      title: 'Refactor Auth Cookie',
      accomplishments: 'Added SameSite strict policy',
      approach: 'Updated session middleware',
      reason: 'Prevent CSRF vectors',
      version: 1,
    });
    expect(legacy.markdownText).toContain('## Accomplishments');
    expect(legacy.markdownText).toContain('Added SameSite strict policy');
    expect(legacy.markdownText).toContain('## Decision Rationale');
  });

  it('builds a deterministic .md artifact for Member and Leader Periodic Work Reports', () => {
    const report = buildWorkReportMarkdownArtifact({
      reportId: '65f000000000000000000099',
      title: 'Báo cáo tuần 44 - Module Capture',
      reportScope: 'MEMBER',
      frequency: 'WEEKLY',
      periodStart: '2026-10-26T00:00:00.000Z',
      periodEnd: '2026-11-02T00:00:00.000Z',
      memberName: 'Mina Member',
      version: 1,
      approvedAt: '2026-11-02T15:00:00.000Z',
      contentMarkdown:
        '# Báo cáo tuần 44 - Module Capture\n\n## Tiến độ\n\nHoàn thành 100% API.',
    });

    expect(report.contentType).toBe('text/markdown');
    expect(report.fileName).toBe(
      'report-member-2026-10-26-Bao-cao-tuan-44-Module-Capture-v1.md',
    );
    expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
    // Does not duplicate identical leading H1
    expect(
      report.markdownText.match(/# Báo cáo tuần 44 - Module Capture/g)?.length,
    ).toBe(1);
    expect(report.markdownText).toContain('MEMBER · WEEKLY');
    expect(report.markdownText).toContain('2026-10-26 -> 2026-11-02');
  });
});
