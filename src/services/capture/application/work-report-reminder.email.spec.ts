import { buildWorkReportReminderEmail } from './work-report-reminder.email';

describe('Work Report reminder content', () => {
  it('converts the UTC date boundary to Vietnam time in both formats', () => {
    const email = buildWorkReportReminderEmail(
      new Date('2026-11-01T23:30:00Z'),
      'https://app.example.test/work-reports',
      'Đồ án tốt nghiệp – Kỳ 8',
    );
    for (const content of [email.text, email.html]) {
      expect(content).toContain('02 November 2026 at 06:30');
      expect(content).toContain('UTC+7');
      expect(content).not.toContain('2026-11-01T23:30:00');
    }
  });

  it('escapes project content and URLs and removes subject line breaks', () => {
    const email = buildWorkReportReminderEmail(
      new Date('2026-11-01T09:44:00Z'),
      'https://app.example.test/reports?a=1&b=2',
      '<img src=x onerror="alert(1)">\r\nBcc: other@example.test',
    );
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img');
    expect(email.html).toContain('reports?a=1&amp;b=2');
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it('uses a readable fallback when the project name is missing', () => {
    const email = buildWorkReportReminderEmail(
      new Date('2026-11-01T09:44:00Z'),
      'https://app.example.test/work-reports',
    );
    expect(email.text).toContain('Project: Your project');
    expect(email.html).toContain('View Work Report');
    for (const content of [email.text, email.html]) {
      expect(content).toContain('Dear Project Member,');
      expect(content).toContain('Thank you for your time and cooperation.');
      expect(content).toContain('Kind regards,');
      expect(content).toContain('Continuum AI');
    }
  });
});
