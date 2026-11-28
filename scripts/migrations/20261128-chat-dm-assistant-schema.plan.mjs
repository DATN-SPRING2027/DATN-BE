import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const CHAT_DM_ASSISTANT_MIGRATION = '20261128-chat-dm-assistant-schema';
export const DATABASE = 'continuum_chat';
export const CONTINUUM_AI_SENDER_ID = 'assistant:continuum_ai';
export const CONTINUUM_AI_HANDLE = 'continuumAI';

export const CHAT_MESSAGE_AUTHOR_TYPES = Object.freeze(['USER', 'ASSISTANT']);
export const CHAT_ASSISTANT_MESSAGE_STATUSES = Object.freeze([
  'PENDING',
  'COMPLETED',
  'INSUFFICIENT_EVIDENCE',
  'CANCELLED',
  'FAILED',
]);
export const CHAT_ASSISTANT_JOB_STATUSES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'INSUFFICIENT_EVIDENCE',
  'CANCELLED',
  'FAILED',
]);
export const CHAT_ASSISTANT_FAILURE_CODES = Object.freeze([
  'SOURCE_CHANGED',
  'TRIGGER_DELETED',
  'ACCESS_REVOKED',
  'SERVICE_UNAVAILABLE',
  'TIMEOUT',
  'INVALID_MODEL_OUTPUT',
]);
export const CHAT_ASSISTANT_QUERY_MODES = Object.freeze([
  'TIME_WINDOW',
  'KEYWORD',
  'HYBRID',
]);

export const CHAT_CONVERSATION_MESSAGES_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'organizationId',
      'conversationId',
      'senderId',
      'senderName',
      'clientMessageId',
      'content',
    ],
    additionalProperties: true,
    properties: {
      organizationId: { bsonType: 'objectId' },
      conversationId: { bsonType: 'objectId' },
      senderId: { bsonType: 'string', minLength: 1 },
      senderName: { bsonType: 'string', minLength: 1 },
      clientMessageId: { bsonType: 'string', minLength: 1 },
      content: { bsonType: 'string', maxLength: 8000 },
      contentVersion: { bsonType: 'int', minimum: 0 },
      authorType: { enum: [...CHAT_MESSAGE_AUTHOR_TYPES] },
      assistantMention: {
        oneOf: [
          { bsonType: 'null' },
          {
            bsonType: 'object',
            required: ['handle', 'query', 'timezone'],
            additionalProperties: false,
            properties: {
              handle: { enum: [CONTINUUM_AI_HANDLE] },
              query: { bsonType: 'string', minLength: 1, maxLength: 2000 },
              timezone: { bsonType: 'string', minLength: 1, maxLength: 64 },
            },
          },
        ],
      },
      triggerMessageId: { bsonType: ['objectId', 'null'] },
      assistantStatus: { enum: [...CHAT_ASSISTANT_MESSAGE_STATUSES] },
      assistantFailureCode: {
        enum: [...CHAT_ASSISTANT_FAILURE_CODES, null],
      },
      assistantMeta: {
        oneOf: [
          { bsonType: 'null' },
          {
            bsonType: 'object',
            required: ['handle', 'queryMode', 'partialCoverage'],
            additionalProperties: false,
            properties: {
              handle: { enum: [CONTINUUM_AI_HANDLE] },
              queryMode: { enum: [...CHAT_ASSISTANT_QUERY_MODES] },
              partialCoverage: { bsonType: 'bool' },
              coverageNote: { bsonType: ['string', 'null'], maxLength: 500 },
              model: { bsonType: ['string', 'null'], maxLength: 120 },
              promptTokens: { bsonType: ['int', 'null'], minimum: 0 },
              completionTokens: { bsonType: ['int', 'null'], minimum: 0 },
            },
          },
        ],
      },
      sourceReferences: {
        bsonType: 'array',
        maxItems: 20,
        items: {
          bsonType: 'object',
          required: [
            'refId',
            'messageId',
            'senderName',
            'createdAt',
            'sourceEditedAt',
            'sourceVersion',
            'quoteSnippet',
          ],
          additionalProperties: false,
          properties: {
            refId: { bsonType: 'string', pattern: '^M[1-9][0-9]{0,2}$' },
            messageId: { bsonType: 'objectId' },
            senderName: { bsonType: 'string', minLength: 1, maxLength: 120 },
            createdAt: { bsonType: 'date' },
            sourceEditedAt: { bsonType: ['date', 'null'] },
            sourceVersion: { bsonType: 'int', minimum: 0 },
            quoteSnippet: { bsonType: 'string', maxLength: 200 },
          },
        },
      },
    },
    oneOf: [
      {
        properties: {
          authorType: { enum: ['USER'] },
          triggerMessageId: { bsonType: 'null' },
        },
        not: {
          anyOf: [
            { required: ['sourceReferences'] },
            { required: ['assistantStatus'] },
            { required: ['assistantMeta'] },
            { required: ['assistantFailureCode'] },
            {
              required: ['senderId'],
              properties: { senderId: { enum: [CONTINUUM_AI_SENDER_ID] } },
            },
          ],
        },
      },
      {
        required: [
          'authorType',
          'senderId',
          'triggerMessageId',
          'assistantStatus',
          'sourceReferences',
        ],
        properties: {
          authorType: { enum: ['ASSISTANT'] },
          senderId: { enum: [CONTINUUM_AI_SENDER_ID] },
          triggerMessageId: { bsonType: 'objectId' },
          assistantMention: { bsonType: 'null' },
        },
      },
    ],
  },
});

export const CHAT_ASSISTANT_JOBS_VALIDATOR = Object.freeze({
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'organizationId',
      'conversationId',
      'triggerMessageId',
      'requesterUserId',
      'requesterDisplayName',
      'handle',
      'query',
      'timezone',
      'status',
      'failureCode',
      'attempts',
      'maxAttempts',
      'nextAttemptAt',
      'lockedBy',
      'lockedUntil',
      'responseMessageId',
      'completedAt',
      'createdAt',
      'updatedAt',
    ],
    additionalProperties: false,
    properties: {
      _id: { bsonType: 'objectId' },
      organizationId: { bsonType: 'objectId' },
      conversationId: { bsonType: 'objectId' },
      triggerMessageId: { bsonType: 'objectId' },
      requesterUserId: { bsonType: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      requesterDisplayName: {
        bsonType: 'string',
        minLength: 1,
        maxLength: 120,
      },
      handle: { enum: [CONTINUUM_AI_HANDLE] },
      query: { bsonType: 'string', minLength: 1, maxLength: 2000 },
      timezone: { bsonType: 'string', minLength: 1, maxLength: 64 },
      status: { enum: [...CHAT_ASSISTANT_JOB_STATUSES] },
      failureCode: { enum: [...CHAT_ASSISTANT_FAILURE_CODES, null] },
      failureReason: { bsonType: ['string', 'null'], maxLength: 300 },
      attempts: { bsonType: 'int', minimum: 0 },
      maxAttempts: { bsonType: 'int', minimum: 1, maximum: 5 },
      nextAttemptAt: { bsonType: 'date' },
      lockedBy: { bsonType: ['string', 'null'], maxLength: 160 },
      lockedUntil: { bsonType: ['date', 'null'] },
      responseMessageId: { bsonType: ['objectId', 'null'] },
      metrics: {
        oneOf: [
          { bsonType: 'null' },
          {
            bsonType: 'object',
            additionalProperties: false,
            properties: {
              queryMode: { enum: [...CHAT_ASSISTANT_QUERY_MODES, null] },
              retrievalPath: { bsonType: ['string', 'null'], maxLength: 64 },
              candidateCount: { bsonType: ['int', 'null'], minimum: 0 },
              sentSnippetCount: { bsonType: ['int', 'null'], minimum: 0 },
              citedCount: { bsonType: ['int', 'null'], minimum: 0 },
              partialCoverage: { bsonType: ['bool', 'null'] },
              retrievalLatencyMs: { bsonType: ['int', 'null'], minimum: 0 },
              sagLatencyMs: { bsonType: ['int', 'null'], minimum: 0 },
              totalLatencyMs: { bsonType: ['int', 'null'], minimum: 0 },
            },
          },
        ],
      },
      completedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      __v: { bsonType: 'int', minimum: 0 },
    },
  },
});

export const CHAT_DM_ASSISTANT_COLLECTIONS = Object.freeze([
  Object.freeze({
    name: 'chat_conversation_messages',
    validator: CHAT_CONVERSATION_MESSAGES_VALIDATOR,
    validationLevel: 'moderate',
    validationAction: 'error',
    preserveOnRollback: true,
  }),
  Object.freeze({
    name: 'chat_assistant_jobs',
    validator: CHAT_ASSISTANT_JOBS_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
    preserveOnRollback: false,
  }),
]);

export const CHAT_DM_ASSISTANT_INDEX_SPECS = Object.freeze([
  Object.freeze({
    collection: 'chat_conversation_messages',
    name: 'chat_messages_assistant_trigger_unique',
    key: Object.freeze({ conversationId: 1, triggerMessageId: 1 }),
    unique: true,
    partialFilterExpression: Object.freeze({
      authorType: 'ASSISTANT',
      triggerMessageId: Object.freeze({ $type: 'objectId' }),
    }),
  }),
  Object.freeze({
    collection: 'chat_conversation_messages',
    name: 'chat_messages_assistant_source_refs_idx',
    key: Object.freeze({ conversationId: 1, 'sourceReferences.messageId': 1 }),
    partialFilterExpression: Object.freeze({
      authorType: 'ASSISTANT',
    }),
  }),
  Object.freeze({
    collection: 'chat_assistant_jobs',
    name: 'chat_assistant_jobs_trigger_unique',
    key: Object.freeze({ triggerMessageId: 1 }),
    unique: true,
  }),
  Object.freeze({
    collection: 'chat_assistant_jobs',
    name: 'chat_assistant_jobs_claim_idx',
    key: Object.freeze({
      status: 1,
      nextAttemptAt: 1,
      lockedUntil: 1,
      createdAt: 1,
      _id: 1,
    }),
  }),
  Object.freeze({
    collection: 'chat_assistant_jobs',
    name: 'chat_assistant_jobs_conv_trigger_idx',
    key: Object.freeze({
      organizationId: 1,
      conversationId: 1,
      triggerMessageId: 1,
    }),
  }),
  Object.freeze({
    collection: 'chat_assistant_jobs',
    name: 'chat_assistant_jobs_conv_status_created_idx',
    key: Object.freeze({
      organizationId: 1,
      conversationId: 1,
      status: 1,
      createdAt: -1,
    }),
  }),
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

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

export function keyMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function indexOptionsMatch(existing, desired) {
  return (
    Boolean(existing.unique) === Boolean(desired.unique) &&
    Boolean(existing.sparse) === Boolean(desired.sparse) &&
    Boolean(existing.hidden) === Boolean(desired.hidden) &&
    (existing.expireAfterSeconds ?? undefined) ===
      (desired.expireAfterSeconds ?? undefined) &&
    JSON.stringify(normalize(existing.partialFilterExpression ?? null)) ===
      JSON.stringify(normalize(desired.partialFilterExpression ?? null))
  );
}

function isNonEmptyValidator(validator) {
  return Boolean(
    validator && typeof validator === 'object' && Object.keys(validator).length,
  );
}

export function validateTarget(uri) {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new Error('CHAT_MONGODB_URI or MONGODB_URI is required');
  }
  const match =
    /^(mongodb(?:\+srv)?:\/\/)([^/?#]+)(?:\/[^?#]*)?(?:\?([^#]*))?$/.exec(uri);
  if (!match) {
    throw new Error('A valid MongoDB connection URI is required');
  }
  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const endpoint = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (!endpoint) {
    throw new Error('MongoDB URI has no host endpoint');
  }
  const hosts = endpoint.split(',').map((hostPort) => {
    const trimmed = hostPort.trim();
    if (trimmed.startsWith('[')) {
      const closing = trimmed.indexOf(']');
      return closing > 0 ? trimmed.slice(0, closing + 1) : trimmed;
    }
    return trimmed.split(':')[0];
  });
  if (hosts.some((host) => !host)) {
    throw new Error('MongoDB URI contains an empty host');
  }
  const loopback =
    scheme === 'mongodb://' && hosts.every((host) => LOOPBACK_HOSTS.has(host));
  const parameters = new URLSearchParams(match[3] ?? '');
  const routingOptions = [...parameters]
    .filter(([key]) =>
      [
        'replicaset',
        'directconnection',
        'loadbalanced',
        'srvservicename',
      ].includes(key.toLowerCase()),
    )
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([left], [right]) => left.localeCompare(right));

  return {
    databaseName: DATABASE,
    loopback,
    targetFingerprint: createHash('sha256')
      .update(
        `${scheme}${endpoint}\u0000${DATABASE}\u0000${JSON.stringify(routingOptions)}`,
      )
      .digest('hex'),
  };
}

export function hashChatDmAssistantPlan(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

export function planChatDmAssistantSchema({
  databaseName,
  targetFingerprint = 'offline-plan',
  inventory = {},
}) {
  if (databaseName !== DATABASE) {
    throw new Error(`Expected database ${DATABASE}, got ${databaseName}`);
  }

  const blockers = [];
  const collections = [];

  for (const spec of CHAT_DM_ASSISTANT_COLLECTIONS) {
    const current = inventory[spec.name] ?? { exists: false };
    const objectType = current.objectType ?? (current.exists ? 'collection' : null);

    if (objectType && objectType !== 'collection') {
      blockers.push({
        collection: spec.name,
        code: 'INVALID_OBJECT_TYPE',
        objectType,
      });
    }

    if ((current.invalidDocumentCount ?? 0) > 0) {
      blockers.push({
        collection: spec.name,
        code: 'INVALID_DOCUMENTS',
        count: current.invalidDocumentCount,
      });
    }

    const hasExistingValidator = isNonEmptyValidator(current.validator);
    const validatorMatches =
      hasExistingValidator &&
      isDeepStrictEqual(current.validator, spec.validator);
    if (hasExistingValidator && !validatorMatches) {
      blockers.push({
        collection: spec.name,
        code: 'VALIDATOR_CONFLICT',
      });
    }

    const levelMatches = current.validationLevel === spec.validationLevel;
    const actionMatches = current.validationAction === spec.validationAction;
    const collectionBlocked = blockers.some(
      (entry) => entry.collection === spec.name,
    );

    const action = collectionBlocked
      ? 'BLOCK'
      : !current.exists
        ? 'CREATE'
        : validatorMatches && levelMatches && actionMatches
          ? 'NOOP'
          : 'VALIDATE';

    collections.push({
      name: spec.name,
      exists: Boolean(current.exists),
      documentCount: current.documentCount ?? 0,
      ...(spec.name === 'chat_conversation_messages'
        ? {
            legacyMessageCount: current.legacyMessageCount ?? 0,
            assistantMessageCount: current.assistantMessageCount ?? 0,
          }
        : {
            activeJobCount: current.activeJobCount ?? 0,
          }),
      validationLevel: spec.validationLevel,
      validationAction: spec.validationAction,
      action,
    });
  }

  const indexes = [];
  for (const spec of CHAT_DM_ASSISTANT_INDEX_SPECS) {
    const current = inventory[spec.collection] ?? { exists: false };
    const existingIndexes = current.indexes ?? [];
    const relevant = existingIndexes.filter(
      (idx) =>
        idx.name !== '_id_' &&
        (idx.name === spec.name || keyMatches(idx.key, spec.key)),
    );
    const exact = relevant.find(
      (idx) =>
        idx.name === spec.name &&
        keyMatches(idx.key, spec.key) &&
        indexOptionsMatch(idx, spec),
    );
    const conflicts = relevant.filter(
      (idx) =>
        !(
          idx.name === spec.name &&
          keyMatches(idx.key, spec.key) &&
          indexOptionsMatch(idx, spec)
        ),
    );
    const duplicateGroups =
      spec.unique && !exact
        ? (current.duplicateKeysByIndex?.[spec.name] ?? [])
        : [];

    if (conflicts.length > 0) {
      blockers.push({
        collection: spec.collection,
        index: spec.name,
        code: 'INDEX_CONFLICT',
        existing: conflicts.map((idx) => ({
          name: idx.name ?? null,
          key: idx.key ?? null,
        })),
      });
    }

    if (duplicateGroups.length > 0) {
      blockers.push({
        collection: spec.collection,
        index: spec.name,
        code: 'DUPLICATE_KEYS',
        groups: duplicateGroups,
      });
    }

    const action =
      conflicts.length > 0 || duplicateGroups.length > 0
        ? 'BLOCK'
        : exact
          ? 'NOOP'
          : 'CREATE';

    indexes.push({
      collection: spec.collection,
      name: spec.name,
      key: spec.key,
      ...(spec.unique ? { unique: true } : {}),
      ...(spec.partialFilterExpression
        ? { partialFilterExpression: spec.partialFilterExpression }
        : {}),
      action,
    });
  }

  const clean = blockers.length === 0;
  const plan = {
    migration: CHAT_DM_ASSISTANT_MIGRATION,
    mode: 'apply',
    databaseName,
    targetFingerprint,
    rewriteDocuments: false,
    preservesExistingIndexes: true,
    clean,
    summary: {
      collectionsCreate: collections.filter((c) => c.action === 'CREATE').length,
      collectionsValidate: collections.filter((c) => c.action === 'VALIDATE')
        .length,
      collectionsNoop: collections.filter((c) => c.action === 'NOOP').length,
      collectionsBlock: collections.filter((c) => c.action === 'BLOCK').length,
      indexesCreate: indexes.filter((i) => i.action === 'CREATE').length,
      indexesNoop: indexes.filter((i) => i.action === 'NOOP').length,
      indexesBlock: indexes.filter((i) => i.action === 'BLOCK').length,
      blockers: blockers.length,
    },
    collections,
    indexes,
    blockers,
    rollbackPreview: {
      dropManagedIndexes: indexes
        .filter((i) => i.action === 'CREATE')
        .map(({ collection, name }) => ({ collection, name })),
      clearManagedValidators: collections
        .filter((c) => c.action === 'CREATE' || c.action === 'VALIDATE')
        .map((c) => c.name),
      neverDropsLegacyCollectionsOrIndexes: true,
    },
  };

  return {
    ...plan,
    reportSha256: hashChatDmAssistantPlan(plan),
  };
}

export function planChatDmAssistantRollback({
  databaseName,
  targetFingerprint = 'offline-plan',
  inventory = {},
  dropEmptyJobsCollection = false,
}) {
  if (databaseName !== DATABASE) {
    throw new Error(`Expected database ${DATABASE}, got ${databaseName}`);
  }

  const blockers = [];
  const collections = [];
  const dropIndexes = [];

  for (const spec of CHAT_DM_ASSISTANT_COLLECTIONS) {
    const current = inventory[spec.name] ?? { exists: false };
    const objectType = current.objectType ?? (current.exists ? 'collection' : null);

    if (objectType && objectType !== 'collection') {
      blockers.push({
        collection: spec.name,
        code: 'INVALID_OBJECT_TYPE',
        objectType,
      });
    }

    if (spec.name === 'chat_assistant_jobs') {
      const activeJobCount = current.activeJobCount ?? 0;
      const documentCount = current.documentCount ?? 0;
      if (activeJobCount > 0) {
        blockers.push({
          collection: spec.name,
          code: 'ACTIVE_JOBS_PRESENT',
          count: activeJobCount,
        });
      }
      if (dropEmptyJobsCollection && current.exists && documentCount > 0) {
        blockers.push({
          collection: spec.name,
          code: 'NON_EMPTY_JOBS_COLLECTION',
          count: documentCount,
        });
      }
    }

    const hasExistingValidator = isNonEmptyValidator(current.validator);
    const validatorMatches =
      hasExistingValidator &&
      isDeepStrictEqual(current.validator, spec.validator);

    if (hasExistingValidator && !validatorMatches) {
      blockers.push({
        collection: spec.name,
        code: 'VALIDATOR_CONFLICT',
      });
    }

    const canDropJobsCollection =
      spec.name === 'chat_assistant_jobs' &&
      dropEmptyJobsCollection &&
      Boolean(current.exists) &&
      (current.documentCount ?? 0) === 0 &&
      (current.activeJobCount ?? 0) === 0;

    const collectionBlocked = blockers.some(
      (entry) => entry.collection === spec.name,
    );

    const action = collectionBlocked
      ? 'BLOCK'
      : !current.exists
        ? 'NOOP'
        : canDropJobsCollection
          ? 'DROP_COLLECTION'
          : validatorMatches
            ? 'CLEAR_VALIDATOR'
            : 'NOOP';

    collections.push({
      name: spec.name,
      exists: Boolean(current.exists),
      documentCount: current.documentCount ?? 0,
      ...(spec.name === 'chat_assistant_jobs'
        ? { activeJobCount: current.activeJobCount ?? 0 }
        : {}),
      action,
    });
  }

  const jobsAction = collections.find(
    (entry) => entry.name === 'chat_assistant_jobs',
  )?.action;

  for (const spec of CHAT_DM_ASSISTANT_INDEX_SPECS) {
    const current = inventory[spec.collection] ?? { exists: false };
    const existingIndexes = current.indexes ?? [];
    const exact = existingIndexes.find(
      (idx) =>
        idx.name === spec.name &&
        keyMatches(idx.key, spec.key) &&
        indexOptionsMatch(idx, spec),
    );
    const mismatchedName = existingIndexes.find(
      (idx) =>
        idx.name === spec.name &&
        (!keyMatches(idx.key, spec.key) || !indexOptionsMatch(idx, spec)),
    );

    if (mismatchedName) {
      blockers.push({
        collection: spec.collection,
        index: spec.name,
        code: 'INDEX_CONFLICT',
      });
    }

    const droppedWithCollection =
      spec.collection === 'chat_assistant_jobs' &&
      jobsAction === 'DROP_COLLECTION';

    dropIndexes.push({
      collection: spec.collection,
      name: spec.name,
      action: mismatchedName
        ? 'BLOCK'
        : exact && !droppedWithCollection
          ? 'DROP'
          : 'NOOP',
    });
  }

  const clean = blockers.length === 0;
  const plan = {
    migration: CHAT_DM_ASSISTANT_MIGRATION,
    mode: 'rollback',
    databaseName,
    targetFingerprint,
    dropEmptyJobsCollection: Boolean(dropEmptyJobsCollection),
    preservesLegacyCollectionsAndIndexes: true,
    clean,
    summary: {
      collectionsClearValidator: collections.filter(
        (c) => c.action === 'CLEAR_VALIDATOR',
      ).length,
      collectionsDrop: collections.filter((c) => c.action === 'DROP_COLLECTION')
        .length,
      collectionsNoop: collections.filter((c) => c.action === 'NOOP').length,
      indexesDrop: dropIndexes.filter((i) => i.action === 'DROP').length,
      indexesNoop: dropIndexes.filter((i) => i.action === 'NOOP').length,
      blockers: blockers.length,
    },
    collections,
    dropIndexes,
    blockers,
  };

  return {
    ...plan,
    reportSha256: hashChatDmAssistantPlan(plan),
  };
}
