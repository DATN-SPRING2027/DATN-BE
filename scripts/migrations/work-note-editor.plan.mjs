export const editorIndexes = {
  work_note_agent_drafts: [
    {
      key: {
        organizationId: 1,
        projectId: 1,
        ownerUserId: 1,
        workflow: 1,
        resourceId: 1,
        updatedAt: -1,
      },
      name: 'agent_drafts_workflow_resume',
    },
  ],
  work_report_versions: [
    {
      key: { reportId: 1, versionNumber: 1 },
      unique: true,
      name: 'report_editor_versions_unique',
    },
  ],
  project_document_editor_versions: [
    {
      key: { documentId: 1, versionNumber: 1 },
      unique: true,
      name: 'document_editor_versions_unique',
    },
  ],
};
export function reportBackfill(row) {
  if (row.contentSchemaVersion !== undefined) {
    if (
      row.contentSchemaVersion !== 2 ||
      typeof row.contentMarkdown !== 'string'
    )
      throw Error('Unsupported report content version');
    return null;
  }
  const fields = [
    ['Accomplishments', row.accomplishments],
    ['Approach', row.approach],
    ['Reason', row.reason],
    ['Blockers', row.blockers],
    ['Next steps', row.nextSteps],
  ];
  if (!fields.some(([, v]) => typeof v === 'string' && v.trim())) return null;
  if (fields.some(([, v]) => v !== undefined && typeof v !== 'string'))
    throw Error('Invalid report content; manual review required');
  const body = fields
    .filter(([, v]) => typeof v === 'string' && v.length)
    .map(([label, v]) => `## ${label}\n${v}`)
    .join('\n\n');
  const date = new Date(row.periodStart);
  if (!Number.isFinite(date.getTime())) throw Error('Invalid report period');
  const title =
    typeof row.title === 'string' && row.title.trim()
      ? row.title
      : `Work report ${date.toISOString().slice(0, 10)}`;
  if (body.length > 30000 || title.length > 300)
    throw Error('Report exceeds editor bounds; manual review required');
  return { title, contentMarkdown: body, contentSchemaVersion: 2 };
}
