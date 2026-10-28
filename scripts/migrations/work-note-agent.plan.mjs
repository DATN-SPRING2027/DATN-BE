export const indexes = {
  work_note_agent_drafts: [
    { key: { organizationId: 1, projectId: 1, ownerUserId: 1, taskId: 1, noteId: 1, updatedAt: -1 }, name: 'agent_drafts_owned_resume' },
    { key: { expiresAt: 1 }, name: 'agent_drafts_expiry', expireAfterSeconds: 0 },
  ],
  work_note_agent_operations: [
    { key: { expiresAt: 1 }, name: 'agent_operations_expiry', expireAfterSeconds: 0 },
    { key: { draftId: 1, ownerUserId: 1 }, name: 'agent_operations_draft_cleanup' },
  ],
};
export function validateDatabaseName(name) { if (name !== 'continuum_capture') throw new Error('Only continuum_capture is allowed'); }
export function legacyContent(row) {
  const fields = [['Accomplishments', row.whatDone], ['Approach', row.howSolved], ['Reason', row.whyThisWay]];
  if (fields.some(([, value]) => typeof value !== 'string')) throw new Error('Missing legacy content; manual inventory required');
  const body = fields.map(([label, value]) => `## ${label}\n${value}`).join('\n\n');
  if (body.length > 30000) throw new Error('Legacy content exceeds editor limit; manual inventory required');
  return body;
}
export function buildBackfill(row) {
  if(typeof row.title!=='string'||!row.title.trim()||row.title.length>300)throw new Error('Invalid legacy title; manual inventory required');
  if(row.currentVersionNumber!==undefined&&(!Number.isSafeInteger(row.currentVersionNumber)||row.currentVersionNumber<1))throw new Error('Invalid current version; manual inventory required');
  if (row.contentSchemaVersion !== undefined) {
    if (row.contentSchemaVersion !== 2 || typeof row.contentMarkdown !== 'string') throw new Error('Unsupported existing content version');
    return null;
  }
  return { contentSchemaVersion: 2, contentMarkdown: legacyContent(row), currentVersionNumber: row.currentVersionNumber ?? 1 };
}
