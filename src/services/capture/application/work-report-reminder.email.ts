const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });

/** Email uses an explicit timezone, independent of the backend host timezone. */
export function buildWorkReportReminderEmail(
  dueAt: Date,
  url: string,
  projectName?: string,
): { subject: string; text: string; html: string } {
  const name = projectName?.replace(/[\r\n]+/g, ' ').trim() || 'Your project';
  const date = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(dueAt);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(dueAt);
  const deadline = `${date} at ${time} (Vietnam time, UTC+7)`;
  const subject = `Work Report Submission Reminder — ${name}`;
  const text = `Dear Project Member,\n\nThis is a reminder that your Work Report for the project below is due soon.\n\nProject: ${name}\nSubmission deadline: ${deadline}\n\nPlease review your progress and submit your report by the deadline above. Your report should include completed work, any challenges encountered, and your planned next steps.\n\nYou can access and submit your report using the following link:\n${url}\n\nIf you have already submitted your report, please disregard this reminder.\n\nThank you for your time and cooperation.\n\nKind regards,\nContinuum AI\n\nThis is an automated notification. Replies to this email are not monitored.`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Work Report Submission Reminder</title></head>
<body style="margin:0;padding:0;background-color:#f2f4f7;color:#1d2939;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e4e7ec;border-radius:16px;">
<tr><td style="padding:28px 24px 16px;color:#3538cd;font-size:18px;font-weight:700;">Continuum AI</td></tr>
<tr><td style="padding:0 24px;"><h1 style="margin:0 0 20px;font-size:24px;line-height:1.35;color:#101828;">Work Report Submission Reminder</h1>
<p style="margin:0 0 12px;font-size:16px;line-height:1.6;">Dear Project Member,</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.6;">This is a reminder that your Work Report for the project below is due soon.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f9fafb;border:1px solid #e4e7ec;border-radius:8px;">
<tr><td style="padding:16px 16px 4px;font-size:14px;color:#475467;">Project</td></tr>
<tr><td style="padding:0 16px 16px;font-size:16px;font-weight:700;overflow-wrap:anywhere;">${escapeHtml(name)}</td></tr>
<tr><td style="padding:0 16px 4px;font-size:14px;color:#475467;">Submission deadline</td></tr>
<tr><td style="padding:0 16px 16px;font-size:16px;font-weight:700;line-height:1.6;">${escapeHtml(deadline)}</td></tr></table>
<p style="margin:20px 0;font-size:16px;line-height:1.6;">Please review your progress and submit your report by the deadline above. Your report should include completed work, any challenges encountered, and your planned next steps.</p>
<p style="margin:20px 0;font-size:16px;line-height:1.6;"><a href="${escapeHtml(url)}" style="color:#3538cd;text-decoration:underline;">View Work Report</a></p>
<p style="margin:20px 0 12px;font-size:14px;line-height:1.6;color:#475467;">If you have already submitted your report, please disregard this reminder.</p>

<p style="margin:0 0 20px;font-size:16px;line-height:1.6;">Thank you for your time and cooperation.</p>
<p style="margin:0 0 24px;font-size:16px;line-height:1.6;">Kind regards,<br>Continuum AI</p>
</td></tr><tr><td style="border-top:1px solid #e4e7ec;padding:20px 24px;font-size:12px;line-height:1.6;color:#475467;">Continuum AI · Work Report Notifications<br>This is an automated notification. Replies to this email are not monitored.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
