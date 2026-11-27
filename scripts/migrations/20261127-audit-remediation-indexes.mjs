import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { targetFingerprint } from './organization-membership-backfill.plan.mjs';

export const AUDIT_REMEDIATION_INDEX_MIGRATION =
  '20261127-audit-remediation-indexes';

/**
 * BE-PERF-002: Additive compound & partial MongoDB indexes across Continuum service databases.
 * Never modifies or drops existing indexes or documents.
 */
export const AUDIT_REMEDIATION_INDEX_SPECS = Object.freeze([
  // IAM (continuum_iam)
  Object.freeze({
    database: 'continuum_iam',
    collection: 'role_assignments',
    name: 'iam_role_assignments_user_project_org',
    key: Object.freeze({ userId: 1, projectId: 1, organizationId: 1 }),
  }),
  Object.freeze({
    database: 'continuum_iam',
    collection: 'project_memberships',
    name: 'iam_project_memberships_org_user_status_project',
    key: Object.freeze({
      organizationId: 1,
      userId: 1,
      status: 1,
      projectId: 1,
    }),
  }),
  Object.freeze({
    database: 'continuum_iam',
    collection: 'projects',
    name: 'iam_projects_org_status_updated_desc',
    key: Object.freeze({ organizationId: 1, status: 1, updatedAt: -1 }),
  }),
  Object.freeze({
    database: 'continuum_iam',
    collection: 'outbox_events',
    name: 'iam_outbox_poll_idx',
    key: Object.freeze({ eventName: 1, status: 1, occurredAt: 1, _id: 1 }),
  }),
  Object.freeze({
    database: 'continuum_iam',
    collection: 'outbox_events',
    name: 'iam_outbox_status_occurred_idx',
    key: Object.freeze({ status: 1, occurredAt: 1, _id: 1 }),
  }),

  // Audit (continuum_audit)
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_logs_iam_occurred_desc',
    key: Object.freeze({ occurredAt: -1, _id: -1 }),
  }),
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_logs_iam_org_occurred_desc',
    key: Object.freeze({ organizationId: 1, occurredAt: -1, _id: -1 }),
  }),
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_logs_iam_actor_occurred_desc',
    key: Object.freeze({ actorUserId: 1, occurredAt: -1, _id: -1 }),
  }),
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_logs_iam_request_id',
    key: Object.freeze({ requestId: 1 }),
    sparse: true,
  }),
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_iam_target_occurred_desc',
    key: Object.freeze({
      targetResource: 1,
      targetResourceId: 1,
      occurredAt: -1,
    }),
  }),
  Object.freeze({
    database: 'continuum_audit',
    collection: 'audit_logs_iam',
    name: 'audit_iam_action_occurred_desc',
    key: Object.freeze({ action: 1, occurredAt: -1, _id: -1 }),
  }),

  // Task Workspace (continuum_task)
  Object.freeze({
    database: 'continuum_task',
    collection: 'tasks',
    name: 'deadline_scan_active_status_due_cursor',
    key: Object.freeze({ status: 1, dueDate: 1, _id: 1 }),
    partialFilterExpression: Object.freeze({
      status: Object.freeze({
        $in: Object.freeze(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED']),
      }),
    }),
  }),

  // Capture & AI Token Usage (continuum_capture)
  Object.freeze({
    database: 'continuum_capture',
    collection: 'project_document_versions',
    name: 'capture_doc_versions_org_project_sha_size',
    key: Object.freeze({
      organizationId: 1,
      projectId: 1,
      'file.sha256': 1,
      'file.size': 1,
    }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'project_document_versions',
    name: 'capture_doc_versions_file_key',
    key: Object.freeze({ 'file.key': 1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'work_notes',
    name: 'capture_work_notes_md_file_key',
    key: Object.freeze({ 'provenance.mdFile.key': 1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'work_notes',
    name: 'capture_work_notes_org_project_review_updated',
    key: Object.freeze({
      organizationId: 1,
      projectId: 1,
      'provenance.review.status': 1,
      updatedAt: -1,
    }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'work_reports',
    name: 'capture_work_reports_md_file_key',
    key: Object.freeze({ 'provenance.mdFile.key': 1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'work_reports',
    name: 'capture_work_reports_status_due_cursor',
    key: Object.freeze({ status: 1, dueAt: 1, _id: 1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'outbox_events',
    name: 'capture_outbox_status_event_occurred',
    key: Object.freeze({ status: 1, eventName: 1, occurredAt: 1, _id: 1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'outbox_events',
    name: 'capture_outbox_aggregate_status_occurred',
    key: Object.freeze({
      aggregateType: 1,
      aggregateId: 1,
      status: 1,
      occurredAt: 1,
      _id: 1,
    }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'ai_token_usage_logs',
    name: 'ai_token_usage_org_user_occurred_desc',
    key: Object.freeze({ organizationId: 1, userId: 1, occurredAt: -1 }),
  }),
  Object.freeze({
    database: 'continuum_capture',
    collection: 'ai_token_usage_logs',
    name: 'ai_token_usage_org_project_dedupe_unique',
    key: Object.freeze({ organizationId: 1, dedupeKey: 1, projectId: 1 }),
    unique: true,
    partialFilterExpression: Object.freeze({
      dedupeKey: Object.freeze({ $type: 'string' }),
    }),
  }),

  // Chat (continuum_chat)
  Object.freeze({
    database: 'continuum_chat',
    collection: 'chat_blocks',
    name: 'chat_blocks_org_target_user',
    key: Object.freeze({ organizationId: 1, targetId: 1, userId: 1 }),
  }),
  Object.freeze({
    database: 'continuum_chat',
    collection: 'chat_conversation_messages',
    name: 'chat_messages_pinned_partial',
    key: Object.freeze({ conversationId: 1, isPinned: 1, createdAt: -1 }),
    partialFilterExpression: Object.freeze({ isPinned: true }),
  }),
  Object.freeze({
    database: 'continuum_chat',
    collection: 'chat_conversation_messages',
    name: 'chat_messages_attachments_kind_partial',
    key: Object.freeze({
      conversationId: 1,
      'attachments.kind': 1,
      createdAt: -1,
    }),
    partialFilterExpression: Object.freeze({
      'attachments.kind': Object.freeze({ $exists: true }),
    }),
  }),

  // Notification (continuum_notification)
  Object.freeze({
    database: 'continuum_notification',
    collection: 'notifications',
    name: 'notifications_recipient_org_read_created_desc',
    key: Object.freeze({
      recipientId: 1,
      organizationId: 1,
      readAt: 1,
      createdAt: -1,
    }),
  }),
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

function keyMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function optionsMatch(existing, desired) {
  return (
    Boolean(existing.unique) === Boolean(desired.unique) &&
    Boolean(existing.sparse) === Boolean(desired.sparse) &&
    (existing.expireAfterSeconds ?? undefined) ===
      (desired.expireAfterSeconds ?? undefined) &&
    JSON.stringify(normalize(existing.partialFilterExpression ?? null)) ===
      JSON.stringify(normalize(desired.partialFilterExpression ?? null))
  );
}

/**
 * Pure planner evaluating existing indexes per `database.collection` and emitting
 * CREATE / NOOP / BLOCK actions with conflict diagnostics.
 */
export function planAuditRemediationIndexes({
  target,
  existingByNamespace,
  specs = AUDIT_REMEDIATION_INDEX_SPECS,
}) {
  const entries = specs.map((spec) => {
    const namespace = `${spec.database}.${spec.collection}`;
    const existing = existingByNamespace[namespace] ?? [];
    const relevant = existing.filter(
      (idx) =>
        idx.name !== '_id_' &&
        (idx.name === spec.name || keyMatches(idx.key, spec.key)),
    );
    const exact = relevant.find(
      (idx) => keyMatches(idx.key, spec.key) && optionsMatch(idx, spec),
    );
    const conflicts = relevant.filter(
      (idx) => !(keyMatches(idx.key, spec.key) && optionsMatch(idx, spec)),
    );

    const action =
      conflicts.length > 0 ? 'BLOCK' : exact ? 'NOOP' : 'CREATE';
    return {
      database: spec.database,
      collection: spec.collection,
      name: spec.name,
      key: spec.key,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.sparse ? { sparse: true } : {}),
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
      action,
      conflicts: conflicts.map((idx) => ({
        name: idx.name ?? null,
        key: idx.key ?? null,
      })),
    };
  });

  const clean = entries.every((entry) => entry.action !== 'BLOCK');
  const createCount = entries.filter((entry) => entry.action === 'CREATE').length;
  const noopCount = entries.filter((entry) => entry.action === 'NOOP').length;
  const blockCount = entries.filter((entry) => entry.action === 'BLOCK').length;

  return {
    migration: AUDIT_REMEDIATION_INDEX_MIGRATION,
    target,
    clean,
    summary: {
      total: entries.length,
      create: createCount,
      noop: noopCount,
      block: blockCount,
    },
    indexes: entries,
  };
}

export function hashAuditRemediationPlan(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

const isDirectExecution =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);

async function runMigration() {
  const apply = process.argv.includes('--apply');
  const expectedHash = process.argv
    .find((arg) => arg.startsWith('--expected-report-sha256='))
    ?.split('=')[1];
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI must be explicitly provided by the caller');
  }
  if (apply && !expectedHash) {
    throw new Error(
      'Apply requires --expected-report-sha256=<dry-run-sha256>',
    );
  }

  const fingerprint = targetFingerprint(mongoUri, 'continuum_multi_service');
  const connection = mongoose.createConnection(mongoUri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 10000,
  });

  const namespaces = [
    ...new Set(
      AUDIT_REMEDIATION_INDEX_SPECS.map((s) => `${s.database}.${s.collection}`),
    ),
  ];

  async function inspect() {
    const existingByNamespace = {};
    for (const ns of namespaces) {
      const [dbName, collName] = ns.split('.');
      const db = connection.useDb(dbName, { useCache: true }).db;
      if (!db) {
        existingByNamespace[ns] = [];
        continue;
      }
      const listed = await db
        .listCollections({ name: collName }, { nameOnly: true })
        .toArray();
      existingByNamespace[ns] =
        listed.length > 0 ? await db.collection(collName).indexes() : [];
    }
    const plan = planAuditRemediationIndexes({
      target: fingerprint,
      existingByNamespace,
    });
    return { ...plan, reportSha256: hashAuditRemediationPlan(plan) };
  }

  try {
    await connection.asPromise();
    const report = await inspect();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.clean) {
      process.exitCode = 2;
      return;
    }
    if (apply) {
      if (expectedHash !== report.reportSha256) {
        throw new Error(
          'Apply refused: current dry-run hash differs from --expected-report-sha256',
        );
      }
      for (const spec of report.indexes) {
        if (spec.action !== 'CREATE') continue;
        const db = connection.useDb(spec.database, { useCache: true }).db;
        await db.collection(spec.collection).createIndex(spec.key, {
          name: spec.name,
          ...(spec.unique ? { unique: true } : {}),
          ...(spec.sparse ? { sparse: true } : {}),
          ...(spec.partialFilterExpression
            ? { partialFilterExpression: spec.partialFilterExpression }
            : {}),
        });
      }
      const verified = await inspect();
      if (!verified.clean || verified.summary.create !== 0) {
        throw new Error('Post-apply index verification failed');
      }
      process.stdout.write(
        `Verified all ${verified.summary.total} audit remediation indexes.\n`,
      );
    }
  } finally {
    await connection.close();
  }
}

if (isDirectExecution) {
  runMigration().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Migration failed'}\n`,
    );
    process.exitCode = 1;
  });
}
