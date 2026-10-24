import { CAPTURE_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

describe('Work Notes persistence contract', () => {
  const collections = new Map(
    CAPTURE_PERSISTENCE.collections.map((definition) => [
      definition.name,
      definition,
    ]),
  );

  it('owns the document, immutable document version, report and settings collections', () => {
    expect([...collections.keys()]).toEqual(
      expect.arrayContaining([
        'project_documents',
        'project_document_versions',
        'work_reports',
        'work_report_settings',
      ]),
    );
  });

  it('prevents duplicate work report obligations for one project member period', () => {
    const indexes = collections.get('work_reports')?.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          JSON.stringify(index.fields) ===
            JSON.stringify({ projectId: 1, memberUserId: 1, periodStart: 1 }),
      ),
    ).toBe(true);
  });

  it('keeps document versions unique and separate from mutable document metadata', () => {
    const indexes = collections.get('project_document_versions')?.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          JSON.stringify(index.fields) ===
            JSON.stringify({ documentId: 1, versionNumber: 1 }),
      ),
    ).toBe(true);
    expect(
      createCollectionSchema(
        collections.get('project_document_versions')!,
      ).path('content'),
    ).toBeDefined();
  });

  it('stores Task Notes with a Task association in the existing Work Notes collection', () => {
    const definition = collections.get('work_notes');
    expect(definition?.indexes).toContainEqual(
      expect.objectContaining({
        fields: { organizationId: 1, projectId: 1, taskId: 1, createdAt: -1 },
      }),
    );
    const schema = createCollectionSchema(definition!);
    expect(schema.path('taskId')).toBeDefined();
    expect(schema.path('type')).toBeDefined();
  });
});
