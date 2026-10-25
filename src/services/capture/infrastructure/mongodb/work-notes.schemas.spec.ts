import { CAPTURE_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { Mongoose, Types } from 'mongoose';

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

  it('prevents duplicate work report obligations within each reporting scope', () => {
    const indexes = collections.get('work_reports')?.indexes ?? [];
    expect(
      indexes.some(
        (index) =>
          index.options?.unique === true &&
          JSON.stringify(index.fields) ===
            JSON.stringify({
              projectId: 1,
              memberUserId: 1,
              reportScope: 1,
              periodStart: 1,
            }),
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
    expect(
      createCollectionSchema(
        collections.get('project_document_versions')!,
      ).path('file.key'),
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
    expect(schema.path('taskId')?.options.required).toBe(true);
    expect(schema.path('type')).toBeDefined();
  });

  it('keeps Project Documents project-scoped without a Task association and tracks latest approved version', () => {
    const documentDefinition = collections.get('project_documents')!;
    const versionDefinition = collections.get('project_document_versions')!;
    const documentSchema = createCollectionSchema(documentDefinition);
    const versionSchema = createCollectionSchema(versionDefinition);
    expect(documentSchema.path('taskId')).toBeUndefined();
    expect(versionSchema.path('taskId')).toBeUndefined();
    expect(documentSchema.path('latestApprovedVersionNumber')).toBeDefined();
    expect(
      (documentDefinition.indexes ?? []).some(
        (index) => 'taskId' in index.fields,
      ),
    ).toBe(false);
  });

  it('accepts a file-only document draft while upload and submission remain separate steps', () => {
    const schema = createCollectionSchema(
      collections.get('project_document_versions')!,
    );
    const Version = new Mongoose().model('FileOnlyDocumentVersion', schema);
    const version = new Version({
      organizationId: new Types.ObjectId(),
      projectId: new Types.ObjectId(),
      documentId: new Types.ObjectId(),
      versionNumber: 1,
      title: 'Database design',
      documentType: 'DATABASE_DESIGN',
      content: '',
      status: 'DRAFT',
      editedByUserId: new Types.ObjectId(),
    });
    expect(version.validateSync()).toBeUndefined();
    version.set('file', {
      key: 'work-notes/test-file',
      name: 'database-design.pdf',
      contentType: 'application/pdf',
      size: 128,
    });
    expect(version.validateSync()).toBeUndefined();
  });
});
