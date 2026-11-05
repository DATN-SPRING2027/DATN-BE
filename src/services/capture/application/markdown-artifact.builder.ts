import { createHash } from 'node:crypto';

export interface MarkdownArtifactResult {
  fileName: string;
  contentType: 'text/markdown';
  markdownText: string;
  bytes: Buffer;
  size: number;
  sha256: string;
}

export interface TaskNoteMarkdownArtifactInput {
  noteId: string;
  title?: string;
  taskId?: string;
  taskKey?: string;
  taskTitle?: string;
  authorId?: string;
  authorName?: string;
  version: number;
  approvedAt?: string;
  contentMarkdown?: string;
  accomplishments?: string;
  approach?: string;
  reason?: string;
}

export interface WorkReportMarkdownArtifactInput {
  reportId: string;
  title?: string;
  reportScope?: string;
  frequency?: string;
  periodStart?: Date | string;
  periodEnd?: Date | string;
  memberId?: string;
  memberName?: string;
  version: number;
  approvedAt?: string;
  contentMarkdown?: string;
  accomplishments?: string;
  approach?: string;
  reason?: string;
  blockers?: string;
  nextSteps?: string;
}

function slugifyFileSegment(
  raw: string,
  fallback: string,
  maxLength = 72,
): string {
  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (ch) => (ch === 'Đ' ? 'D' : 'd'))
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return normalized || fallback;
}

function formatIsoDate(value?: Date | string): string {
  if (!value) return 'unknown-period';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return typeof value === 'string' && value.trim()
      ? value.trim().slice(0, 10)
      : 'unknown-period';
  }
  return parsed.toISOString().slice(0, 10);
}

function stripLeadingIdenticalH1(markdownBody: string, title: string): string {
  const trimmed = markdownBody.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length === 0) return trimmed;
  const firstLine = lines[0]?.trim() ?? '';
  if (firstLine.startsWith('# ')) {
    const headingText = firstLine.slice(2).trim();
    if (headingText.toLowerCase() === title.trim().toLowerCase()) {
      return lines.slice(1).join('\n').trim();
    }
  }
  return trimmed;
}

function finalizeArtifact(
  fileName: string,
  markdownText: string,
): MarkdownArtifactResult {
  const normalizedMarkdown = `${markdownText.trim()}\n`;
  const bytes = Buffer.from(normalizedMarkdown, 'utf-8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    fileName: fileName.slice(0, 180),
    contentType: 'text/markdown',
    markdownText: normalizedMarkdown,
    bytes,
    size: bytes.length,
    sha256,
  };
}

export function buildTaskNoteMarkdownArtifact(
  input: TaskNoteMarkdownArtifactInput,
): MarkdownArtifactResult {
  const version = Math.max(1, Math.trunc(Number(input.version) || 1));
  const resolvedTitle =
    (input.title ?? '').trim() || `Task Note ${input.noteId}`;
  const rawFreeform = (input.contentMarkdown ?? '').trim();

  const structuredSections = [
    ['Accomplishments', input.accomplishments],
    ['Approach', input.approach],
    ['Decision Rationale', input.reason],
  ]
    .filter(([, text]) => typeof text === 'string' && text.trim().length > 0)
    .map(([heading, text]) => `## ${heading}\n\n${String(text).trim()}`)
    .join('\n\n');

  const body = stripLeadingIdenticalH1(
    rawFreeform || structuredSections || resolvedTitle,
    resolvedTitle,
  );

  const taskLineParts: string[] = [];
  if (input.taskKey?.trim()) {
    taskLineParts.push(`#${input.taskKey.trim()}`);
  }
  if (input.taskTitle?.trim()) {
    taskLineParts.push(input.taskTitle.trim());
  }
  if (taskLineParts.length === 0 && input.taskId?.trim()) {
    taskLineParts.push(input.taskId.trim());
  }

  const authorLabel =
    input.authorName?.trim() || input.authorId?.trim() || 'Project Member';
  const contextLines = [
    `> **Source:** Task Note (\`${input.noteId}\`)`,
    ...(taskLineParts.length > 0
      ? [`> **Task:** ${taskLineParts.join(' — ')}`]
      : []),
    `> **Author:** ${authorLabel} | **Version:** v${version}${
      input.approvedAt ? ` | **Approved At:** ${input.approvedAt}` : ''
    }`,
  ];

  const markdownText = `# ${resolvedTitle}\n\n${contextLines.join('\n')}\n\n---\n\n${body}`;
  const taskPrefix = slugifyFileSegment(
    input.taskKey?.trim() || input.noteId.slice(-8),
    'note',
    24,
  );
  const titleSlug = slugifyFileSegment(resolvedTitle, 'task-note', 72);
  const fileName = `TASK-${taskPrefix}-${titleSlug}-v${version}.md`;

  return finalizeArtifact(fileName, markdownText);
}

export function buildWorkReportMarkdownArtifact(
  input: WorkReportMarkdownArtifactInput,
): MarkdownArtifactResult {
  const version = Math.max(1, Math.trunc(Number(input.version) || 1));
  const scope =
    String(input.reportScope ?? 'MEMBER').toUpperCase() === 'LEADER'
      ? 'LEADER'
      : 'MEMBER';
  const frequency = (input.frequency ?? 'WEEKLY').trim().toUpperCase();
  const periodStartLabel = formatIsoDate(input.periodStart);
  const periodEndLabel = formatIsoDate(input.periodEnd);
  const resolvedTitle =
    (input.title ?? '').trim() ||
    `${scope === 'LEADER' ? 'Leader' : 'Member'} Work Report (${periodStartLabel})`;

  const rawFreeform = (input.contentMarkdown ?? '').trim();
  const structuredSections = [
    ['Accomplishments', input.accomplishments],
    ['Approach', input.approach],
    ['Decision Rationale', input.reason],
    ['Blockers', input.blockers],
    ['Next Steps', input.nextSteps],
  ]
    .filter(([, text]) => typeof text === 'string' && text.trim().length > 0)
    .map(([heading, text]) => `## ${heading}\n\n${String(text).trim()}`)
    .join('\n\n');

  const body = stripLeadingIdenticalH1(
    rawFreeform || structuredSections || resolvedTitle,
    resolvedTitle,
  );

  const authorLabel =
    input.memberName?.trim() || input.memberId?.trim() || 'Project Member';
  const contextLines = [
    `> **Source:** Periodic Work Report (\`${input.reportId}\`)`,
    `> **Scope & Cadence:** ${scope} · ${frequency}`,
    `> **Period:** ${periodStartLabel} -> ${periodEndLabel}`,
    `> **Author:** ${authorLabel} | **Version:** v${version}${
      input.approvedAt ? ` | **Approved At:** ${input.approvedAt}` : ''
    }`,
  ];

  const markdownText = `# ${resolvedTitle}\n\n${contextLines.join('\n')}\n\n---\n\n${body}`;
  const titleSlug = slugifyFileSegment(resolvedTitle, 'work-report', 64);
  const fileName = `report-${scope.toLowerCase()}-${periodStartLabel}-${titleSlug}-v${version}.md`;

  return finalizeArtifact(fileName, markdownText);
}
