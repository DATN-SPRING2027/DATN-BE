export const SPLIT_SOURCE_DATABASE = 'continuum_db';
export const COLLECTION_OPTION_ALLOWLIST = Object.freeze([
  'capped',
  'size',
  'max',
  'validator',
  'validationLevel',
  'validationAction',
  'collation',
  'expireAfterSeconds',
  'timeseries',
  'changeStreamPreAndPostImages',
]);

export const DATABASE_PER_SERVICE_INVENTORY = Object.freeze({
  continuum_iam: [
    'users',
    'organizations',
    'organization_memberships',
    'projects',
    'teams',
    'project_memberships',
    'team_memberships',
    'roles',
    'role_assignments',
    'organization_capability_grants',
    'refresh_sessions',
    'sme_assignments',
    'knowledge_owner_assignments',
  ],
  continuum_capture: [
    'work_notes',
    'work_note_versions',
    'capture_drafts',
    'work_note_templates',
    'knowledge_requirements',
  ],
  continuum_jira: [
    'jira_connections',
    'jira_account_links',
    'jira_issues',
    'jira_events',
    'jira_sync_jobs',
  ],
  continuum_lifecycle: [
    'knowledge_objects',
    'knowledge_proposals',
    'knowledge_versions',
    'knowledge_evidence',
    'knowledge_verifications',
    'knowledge_gaps',
    'knowledge_conflicts',
    'knowledge_relations',
  ],
  continuum_chat: [
    'chat_sessions',
    'chat_messages',
    'chat_feedbacks',
    'query_logs',
    'retrieval_logs',
  ],
  continuum_handover: [
    'responsibilities',
    'responsibility_assignments',
    'handovers',
    'handover_items',
    'interviews',
    'interview_sessions',
    'learning_paths',
    'follow_up_tasks',
  ],
  continuum_ingestion: [
    'documents',
    'document_versions',
    'ingestion_jobs',
    'sag_mappings',
    'file_upload_tickets',
  ],
  continuum_notification: [
    'notifications',
    'notification_preferences',
    'notification_templates',
    'email_delivery_logs',
  ],
  continuum_audit: ['audit_logs', 'audit_logs_iam'],
});

const collectionOwners = new Map(
  Object.entries(DATABASE_PER_SERVICE_INVENTORY).flatMap(
    ([databaseName, collectionNames]) =>
      collectionNames.map((collectionName) => [collectionName, databaseName]),
  ),
);

export function ownerForCollection(collectionName) {
  return collectionOwners.get(collectionName) ?? null;
}

function stableValue(value) {
  if (value === undefined) return { $missing: true };
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $binary: value.toString('base64') };
  if (value._bsontype && typeof value.toString === 'function') {
    return { [`$${value._bsontype}`]: value.toString() };
  }
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function indexSignature(index, document) {
  if (index.partialFilterExpression) return { unsupported: 'partialFilterExpression' };
  if (index.collation && index.collation.locale !== 'simple') {
    return { unsupported: 'non-simple index collation' };
  }
  const fields = Object.keys(index.key ?? {});
  if (!fields.length) return { unsupported: 'missing index key' };
  const values = fields.map((field) => {
    let value = document;
    let found = true;
    for (const segment of field.split('.')) {
      if (value === null || value === undefined || !Object.hasOwn(value, segment)) {
        found = false;
        value = undefined;
        break;
      }
      value = value[segment];
    }
    return { field, found, value };
  });
  if (index.sparse && values.every((item) => !item.found)) return null;
  if (values.some((item) => Array.isArray(item.value))) {
    return { unsupported: 'multikey unique index' };
  }
  return JSON.stringify(
    values.map(({ field, found, value }) => [
      field,
      stableValue(found ? value : null),
    ]),
  );
}

function comparableIndex(index) {
  const { ns: _namespace, v: _version, ...definition } = index;
  return JSON.stringify(stableValue(definition));
}

function comparableOptions(options = {}) {
  return JSON.stringify(stableValue(options));
}

function byName(left, right) {
  return String(left.name).localeCompare(String(right.name));
}

function byId(left, right) {
  return String(left._id).localeCompare(String(right._id));
}

function inspectIndexes(source, target, databaseName) {
  const sourceIndexes = [...(source.indexes ?? [])].sort(byName);
  const targetIndexes = [...(target?.indexes ?? [])].sort(byName);
  const sourceByName = new Map(sourceIndexes.map((index) => [index.name, index]));
  const targetByName = new Map(targetIndexes.map((index) => [index.name, index]));
  const differences = [];
  const blockingDifferences = [];
  const uniqueIndexConflicts = [];
  const unverifiableUniqueIndexes = [];
  const collectionOptionsDifferences = [];
  const unsupportedCollectionOptions = [];

  for (const index of sourceIndexes) {
    const existing = targetByName.get(index.name);
    if (!existing) {
      differences.push({
        databaseName,
        collection: source.name,
        index: index.name,
        status: 'MISSING_TARGET_INDEX',
      });
    } else if (comparableIndex(index) !== comparableIndex(existing)) {
      const difference = {
        databaseName,
        collection: source.name,
        index: index.name,
        status: 'INCOMPATIBLE_TARGET_INDEX',
        source: index,
        target: existing,
      };
      differences.push(difference);
      blockingDifferences.push(difference);
    }
  }
  for (const index of targetIndexes) {
    if (!sourceByName.has(index.name)) {
      differences.push({
        databaseName,
        collection: source.name,
        index: index.name,
        status: 'EXTRA_TARGET_INDEX_PRESERVED',
      });
    }
  }
  if (
    target &&
    comparableOptions(source.options) !== comparableOptions(target.options)
  ) {
    collectionOptionsDifferences.push({
      databaseName,
      collection: source.name,
      sourceOptions: source.options ?? {},
      targetOptions: target.options ?? {},
      status: 'INCOMPATIBLE_TARGET_COLLECTION_OPTIONS',
    });
  }
  for (const option of Object.keys(source.options ?? {})) {
    if (!COLLECTION_OPTION_ALLOWLIST.includes(option)) {
      unsupportedCollectionOptions.push({
        databaseName,
        collection: source.name,
        option,
        status: 'UNSUPPORTED_SOURCE_COLLECTION_OPTION',
      });
    }
  }

  const effectiveById = new Map();
  for (const document of [...(target?.documents ?? [])].sort(byId)) {
    effectiveById.set(String(document._id), document);
  }
  for (const document of [...source.documents].sort(byId)) {
    const id = String(document._id);
    const current = effectiveById.get(id);
    if (!current || current.digest === document.digest) {
      effectiveById.set(id, document);
    }
  }

  const uniqueIndexes = new Map();
  for (const index of [...sourceIndexes, ...targetIndexes].filter(
    (candidate) => candidate.unique,
  )) {
    uniqueIndexes.set(comparableIndex(index), index);
  }
  for (const index of [...uniqueIndexes.values()].sort(byName)) {
    const seen = new Map();
    let unsupported = null;
    for (const [id, document] of effectiveById) {
      const raw = document.raw ?? document;
      const signature = indexSignature(index, {
        ...raw,
        _id: raw._id ?? document._id,
      });
      if (signature?.unsupported) {
        unsupported = signature.unsupported;
        break;
      }
      if (signature === null) continue;
      const previous = seen.get(signature);
      if (previous && previous !== id) {
        uniqueIndexConflicts.push({
          databaseName,
          collection: source.name,
          index: index.name,
          documentIds: [previous, id].sort(),
          reason: 'documents violate a unique index after the planned copy',
        });
      } else {
        seen.set(signature, id);
      }
    }
    if (unsupported) {
      unverifiableUniqueIndexes.push({
        databaseName,
        collection: source.name,
        index: index.name,
        reason: `preflight cannot safely evaluate ${unsupported}`,
      });
    }
  }

  return {
    differences,
    blockingDifferences,
    uniqueIndexConflicts,
    unverifiableUniqueIndexes,
    collectionOptionsDifferences,
    unsupportedCollectionOptions,
  };
}

export function buildDatabasePerServiceSplitReport({
  sourceCollections,
  targetCollections,
}) {
  const targetsByDatabase = new Map(
    Object.entries(targetCollections).map(([databaseName, collections]) => [
      databaseName,
      new Map(
        (Array.isArray(collections) ? collections : Object.values(collections)).map(
          (collection) => [collection.name, collection],
        ),
      ),
    ]),
  );
  const plannedCollections = [];
  const unmappedCollections = [];
  const conflictingCollections = [];
  const indexDifferences = [];
  const blockingIndexDifferences = [];
  const uniqueIndexConflicts = [];
  const unverifiableUniqueIndexes = [];
  const collectionOptionsDifferences = [];
  const unsupportedCollectionOptions = [];
  const allDocuments = [];
  const targetOnlyDocuments = [];

  for (const source of [...sourceCollections].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (source.type && source.type !== 'collection') {
      unmappedCollections.push({
        collection: source.name,
        documentCount: 0,
        reason: `source object type '${source.type}' is not a migratable collection`,
        documentIds: [],
      });
      continue;
    }
    const databaseName = ownerForCollection(source.name);
    if (!databaseName) {
      unmappedCollections.push({
        collection: source.name,
        documentCount: source.documents.length,
        reason:
          source.name === 'outbox_events'
            ? 'legacy outbox documents have no persisted service owner'
            : 'collection is absent from the accepted active-service inventory',
        documentIds: source.documents.map((document) => String(document._id)).sort(),
      });
      continue;
    }

    const target = targetsByDatabase.get(databaseName)?.get(source.name) ?? null;
    const targetById = new Map(
      (target?.documents ?? []).map((document) => [
        String(document._id),
        document,
      ]),
    );
    const documents = [...source.documents].sort(byId).map((document) => {
      const id = String(document._id);
      const existing = targetById.get(id);
      const action = !existing
        ? 'INSERT'
        : existing.digest === document.digest
          ? 'IDENTICAL_NOOP'
          : 'CONFLICT';
      const item = {
        id,
        action,
        sourceDigest: document.digest,
        targetDigest: existing?.digest ?? null,
      };
      allDocuments.push({
        sourceCollection: source.name,
        targetDatabase: databaseName,
        targetCollection: source.name,
        ...item,
      });
      if (action === 'CONFLICT') {
        conflictingCollections.push({
          collection: source.name,
          databaseName,
          documentId: id,
          reason: 'target already contains a different document with this _id',
        });
      }
      return item;
    });
    const sourceIds = new Set(source.documents.map((document) => String(document._id)));
    for (const document of [...(target?.documents ?? [])].sort(byId)) {
      if (!sourceIds.has(String(document._id))) {
        targetOnlyDocuments.push({
          targetDatabase: databaseName,
          targetCollection: source.name,
          id: String(document._id),
          targetDigest: document.digest,
        });
      }
    }

    const targetCount = target?.documents.length ?? 0;
    const indexInspection = inspectIndexes(
      source,
      target,
      databaseName,
    );
    indexDifferences.push(...indexInspection.differences);
    blockingIndexDifferences.push(...indexInspection.blockingDifferences);
    uniqueIndexConflicts.push(...indexInspection.uniqueIndexConflicts);
    unverifiableUniqueIndexes.push(...indexInspection.unverifiableUniqueIndexes);
    collectionOptionsDifferences.push(...indexInspection.collectionOptionsDifferences);
    unsupportedCollectionOptions.push(...indexInspection.unsupportedCollectionOptions);
    plannedCollections.push({
      sourceCollection: source.name,
      targetDatabase: databaseName,
      targetCollection: source.name,
      sourceCount: source.documents.length,
      targetCount,
      documents,
      sourceIndexes: [...(source.indexes ?? [])].sort(byName),
      targetIndexes: [...(target?.indexes ?? [])].sort(byName),
      sourceOptions: source.options ?? {},
      targetOptions: target?.options ?? {},
      indexDifferences: indexInspection.differences,
    });
  }

  const clean =
    unmappedCollections.length === 0 &&
    conflictingCollections.length === 0 &&
    blockingIndexDifferences.length === 0 &&
    uniqueIndexConflicts.length === 0 &&
    unverifiableUniqueIndexes.length === 0 &&
    collectionOptionsDifferences.length === 0 &&
    unsupportedCollectionOptions.length === 0;
  return {
    sourceDatabase: SPLIT_SOURCE_DATABASE,
    inventory: DATABASE_PER_SERVICE_INVENTORY,
    clean,
    counts: {
      sourceCollections: sourceCollections.length,
      mappedCollections: plannedCollections.length,
      unmappedCollections: unmappedCollections.length,
      sourceDocuments: sourceCollections.reduce(
        (total, collection) => total + collection.documents.length,
        0,
      ),
      documentsToInsert: allDocuments.filter((item) => item.action === 'INSERT')
        .length,
      identicalExistingDocuments: allDocuments.filter(
        (item) => item.action === 'IDENTICAL_NOOP',
      ).length,
      conflictingDocuments: conflictingCollections.length,
      targetOnlyDocuments: targetOnlyDocuments.length,
      indexDifferences: indexDifferences.length,
      blockingIndexDifferences: blockingIndexDifferences.length,
      uniqueIndexConflicts: uniqueIndexConflicts.length,
      unverifiableUniqueIndexes: unverifiableUniqueIndexes.length,
      collectionOptionsDifferences: collectionOptionsDifferences.length,
      unsupportedCollectionOptions: unsupportedCollectionOptions.length,
    },
    collections: plannedCollections,
    documents: allDocuments.sort((a, b) =>
      `${a.targetDatabase}:${a.targetCollection}:${a.id}`.localeCompare(
        `${b.targetDatabase}:${b.targetCollection}:${b.id}`,
      ),
    ),
    targetOnlyDocuments: targetOnlyDocuments.sort((a, b) =>
      `${a.targetDatabase}:${a.targetCollection}:${a.id}`.localeCompare(
        `${b.targetDatabase}:${b.targetCollection}:${b.id}`,
      ),
    ),
    unmappedCollections,
    conflictingCollections,
    indexDifferences,
    blockingIndexDifferences,
    uniqueIndexConflicts,
    unverifiableUniqueIndexes,
    collectionOptionsDifferences,
    unsupportedCollectionOptions,
  };
}
