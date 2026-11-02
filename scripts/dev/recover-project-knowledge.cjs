/* Build first. Dry-run by default. Starts only the existing knowledge consumer. */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { ConfigService } = require('@nestjs/config');
const { createHash } = require('node:crypto');
const { KnowledgeOutboxConsumer, HttpSagKnowledgeSyncTransport } = require('../../dist/services/capture/infrastructure/outbox/knowledge-outbox.consumer');
const { ProjectDocumentStorage } = require('../../dist/services/capture/infrastructure/storage/project-document.storage');
const { R2Storage } = require('../../dist/services/capture/infrastructure/storage/r2.storage');

async function main() {
  const [organizationId, projectId, mode] = process.argv.slice(2);
  if (![organizationId, projectId].every(id => /^[a-f\d]{24}$/i.test(id || '')) || ![undefined, '--apply'].includes(mode)) {
    throw new Error('Usage: node scripts/dev/recover-project-knowledge.cjs ORGANIZATION_ID PROJECT_ID [--apply]');
  }
  const config = new ConfigService(process.env);
  const connection = await mongoose.createConnection(process.env.MONGODB_URI, {
    dbName: 'continuum_capture', serverSelectionTimeoutMS: 5000,
  }).asPromise();
  const r2 = new R2Storage(config);
  try {
    const documents = await connection.collection('project_documents').find({
      organizationId: new mongoose.Types.ObjectId(organizationId),
      projectId: new mongoose.Types.ObjectId(projectId), status: 'APPROVED',
    }).toArray();
    const storage = new ProjectDocumentStorage(r2, config);
    const consumer = new KnowledgeOutboxConsumer(connection, config,
      storage, new HttpSagKnowledgeSyncTransport(config));
    for (const document of documents) {
      const version = document.latestApprovedVersionNumber ?? document.currentVersionNumber;
      const approvedVersion = await connection.collection('project_document_versions').findOne({
        documentId: document._id, organizationId: document.organizationId,
        projectId: document.projectId, versionNumber: version, status: 'APPROVED',
      });
      if (!approvedVersion) continue;
      const id = String(document._id);
      // Missing attachments must be restored/reuploaded, never replaced by metadata text.
      if (approvedVersion.file?.key) {
        try {
          const bytes = await storage.get(approvedVersion.file.key);
          const expected = approvedVersion.file.sha256 ?? approvedVersion.knowledgeSync?.fileHash;
          if ((expected && createHash('sha256').update(bytes).digest('hex') !== expected)
            || (approvedVersion.file.size && bytes.length !== approvedVersion.file.size)) {
            console.log(JSON.stringify({ documentId: id, action: 'SKIPPED_FILE_MISMATCH' }));
            continue;
          }
        } catch {
          console.log(JSON.stringify({ documentId: id, action: 'SKIPPED_FILE_UNAVAILABLE' }));
          continue;
        }
      }
      if (mode !== '--apply') {
        console.log(JSON.stringify({ documentId: id, version, action: 'WOULD_REPLAY' }));
        continue;
      }
      // Preserve historic receipts and reuse pending work on retries.
      const events = connection.collection('outbox_events');
      const pending = await events.findOne({ aggregateId: id, aggregateType: 'PROJECT_DOCUMENT',
        eventName: { $in: ['KNOWLEDGE_SOURCE_APPROVED', 'KNOWLEDGE_SOURCE_REPLACED', 'KNOWLEDGE_SOURCE_REVOKED'] }, status: 'PENDING' });
      if (!pending) {
        const now = new Date();
        await events.insertOne({ eventName: 'KNOWLEDGE_SOURCE_APPROVED', aggregateType: 'PROJECT_DOCUMENT',
          aggregateId: id, status: 'PENDING', occurredAt: now, createdAt: now, updatedAt: now,
          payload: { sourceType: 'PROJECT_DOCUMENT', sourceId: id, organizationId, projectId, version,
            approvedAt: approvedVersion.reviewedAt?.toISOString?.() ?? now.toISOString(),
            reason: 'OPERATOR_SAG_INSTANCE_RECOVERY' } });
      }
      const outcome = await consumer.runOnce(id);
      console.log(JSON.stringify({ documentId: id, version, outcome }));
    }
  } finally {
    r2.onModuleDestroy();
    await connection.close();
  }
}
main().catch(error => {
  // Provider errors may include signed URLs. Never print their raw messages.
  console.error(error.message?.startsWith('Usage:') ? error.message : `Knowledge recovery failed (${error.name})`);
  process.exitCode = 1;
});
