// Single physical contract shared by Mongoose and the additive migration.
// This is storage validation, not authorization or a completion policy.
const text = (maxLength, minLength = 1) => ({
  bsonType: 'string',
  minLength,
  maxLength,
});
const user = () => ({ ...text(24), pattern: '^[a-f0-9]{24}$' });
const ref = () => ({ bsonType: 'objectId' });
const date = () => ({ bsonType: 'date' });
const flag = () => ({ bsonType: 'bool' });
const count = (minimum = 1) => ({
  bsonType: ['int', 'long', 'double', 'decimal'],
  minimum,
  maximum: Number.MAX_SAFE_INTEGER,
  multipleOf: 1,
});
const values = (...options) => ({
  bsonType:
    typeof options[0] === 'number'
      ? ['int', 'long', 'double', 'decimal']
      : 'string',
  enum: options,
});
const nullable = (field) => ({
  ...field,
  bsonType: [
    ...(Array.isArray(field.bsonType) ? field.bsonType : [field.bsonType]),
    'null',
  ],
});
const object = (properties, required = Object.keys(properties)) => ({
  bsonType: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});
const list = (items, maxItems, minItems = 0) => ({
  bsonType: 'array',
  items,
  minItems,
  maxItems,
});
const hash = () => ({ ...text(64), pattern: '^[a-f0-9]{64}$' });
const scope = { organizationId: ref(), projectId: ref() };
const binding = { ...scope, handoverId: ref() };
const recipientBinding = {
  ...binding,
  revisionId: ref(),
  successorUserId: user(),
  assignmentVersion: count(),
};
const itemBinding = {
  itemId: ref(),
  contentVersion: count(),
  dependencyFingerprint: hash(),
};
const source = object({
  kind: values(
    'TASK_NOTE',
    'PROJECT_DOCUMENT',
    'WORK_REPORT',
    'KNOWLEDGE_OBJECT',
  ),
  id: text(200),
  version: text(200),
});
const citation = object({
  source,
  locator: object({
    kind: values('CHUNK', 'PAGE', 'LINE', 'SECTION'),
    value: text(500),
  }),
});
const task = object({
  taskId: ref(),
  expectedVersion: count(),
  expectedAssigneeId: nullable(user()),
});
const item = object({
  ...itemBinding,
  title: text(255),
  body: text(20000, 0),
  requirement: text(2000),
  isRequired: flag(),
  evidenceRequired: flag(),
  sources: list(source, 50),
  citations: list(citation, 100),
});
const review = object({
  itemId: ref(),
  contentVersion: count(),
  decision: values('CONTENT_APPROVED', 'GAP_REMAINS'),
  impact: values('UNCHANGED', 'CHANGED'),
  reason: text(2000),
});
const gap = object({
  itemId: ref(),
  ownerUserId: user(),
  dueAt: date(),
  reason: text(2000),
});
const receipt = object(
  {
    resourceId: ref(),
    resourceVersion: count(),
    revisionId: ref(),
    jobId: ref(),
    transferId: ref(),
    followUpId: ref(),
    outcome: text(100),
  },
  [],
);

function collection(
  properties,
  required = Object.keys(properties),
  immutable = false,
) {
  return {
    immutable,
    schema: object(
      {
        _id: ref(),
        schemaVersion: values(2),
        ...properties,
        createdAt: date(),
        ...(immutable ? {} : { updatedAt: date() }),
      },
      ['schemaVersion', ...required],
    ),
    indexes: [],
  };
}

const collections = {
  handovers: collection(
    {
      ...scope,
      departingUserId: user(),
      assignedLeaderId: user(),
      successorUserId: nullable(user()),
      title: text(255),
      targetCompletionDate: date(),
      status: values('OPEN', 'COMPLETED', 'CANCELLED'),
      version: count(),
      draftVersion: count(0),
      assignmentVersion: count(0),
      publishedRevisionId: nullable(ref()),
      selectedSources: list(source, 100),
      selectedTasks: list(task, 100),
      createdBy: user(),
      completedAt: date(),
      completedBy: user(),
      completionReviewNote: text(2000),
      cancelledAt: date(),
      cancelledBy: user(),
      cancellationReason: text(2000),
    },
    [
      ...Object.keys(scope),
      'departingUserId',
      'assignedLeaderId',
      'successorUserId',
      'title',
      'targetCompletionDate',
      'status',
      'version',
      'draftVersion',
      'assignmentVersion',
      'publishedRevisionId',
      'selectedSources',
      'selectedTasks',
      'createdBy',
    ],
  ),
  handover_items: collection({
    ...binding,
    ...item.properties,
    updatedBy: user(),
  }),
  handover_revisions: collection(
    {
      ...binding,
      number: count(),
      draftVersion: count(0),
      assignmentVersion: count(0),
      successorUserId: nullable(user()),
      items: list(item, 100),
      selectedSources: list(source, 100),
      selectedTasks: list(task, 100),
      reviews: list(review, 100),
      gaps: list(gap, 100),
      publishedBy: user(),
      publishedAt: date(),
      sourceFingerprint: hash(),
      reviewNote: text(2000),
    },
    undefined,
    true,
  ),
  handover_acceptances: collection(
    {
      ...recipientBinding,
      kind: values('PACKAGE', 'ITEM'),
      ...itemBinding,
      decision: values('ACCEPTED', 'UNDERSTOOD', 'NEEDS_CLARIFICATION'),
      note: text(2000, 0),
      commandId: ref(),
      sequence: count(),
      occurredAt: date(),
      carriedFromAcceptanceId: ref(),
    },
    [
      ...Object.keys(recipientBinding),
      'kind',
      'decision',
      'note',
      'commandId',
      'sequence',
      'occurredAt',
    ],
    true,
  ),
  handover_evidence: collection(
    {
      ...recipientBinding,
      ...itemBinding,
      resultText: text(10000),
      links: list({ ...text(2000), pattern: '^https://[^\\s]+$' }, 10),
      commandId: ref(),
      sequence: count(),
      submittedAt: date(),
    },
    undefined,
    true,
  ),
  handover_evidence_reviews: collection(
    {
      ...recipientBinding,
      ...itemBinding,
      evidenceId: ref(),
      reviewerUserId: user(),
      decision: values('APPROVED', 'REJECTED'),
      note: text(2000),
      commandId: ref(),
      sequence: count(),
      reviewedAt: date(),
    },
    undefined,
    true,
  ),
  handover_operations: collection(
    {
      ...scope,
      handoverId: ref(),
      actorUserId: user(),
      namespace: text(100),
      key: {
        ...text(36),
        pattern:
          '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      },
      fingerprint: hash(),
      kind: values('COMMAND', 'TASK_TRANSFER', 'TASK_TRANSFER_CHILD'),
      state: values(
        'PENDING',
        'DISPATCHED',
        'COMMITTED',
        'REJECTED',
        'UNKNOWN',
        'PARTIAL',
        'CONFLICT',
        'SUPERSEDED',
        'FAILED',
      ),
      expectedVersion: count(),
      assignmentVersion: count(),
      revisionId: ref(),
      successorUserId: user(),
      parentOperationId: ref(),
      taskIntent: object({ ...task.properties, targetUserId: user() }),
      taskOutcome: object(
        {
          state: values('COMMITTED', 'REJECTED', 'UNKNOWN', 'CONFLICT'),
          taskVersion: count(),
          assigneeId: nullable(user()),
          owningOperationId: text(200),
          safeErrorCode: text(100),
        },
        ['state'],
      ),
      receipt,
      safeErrorCode: text(100),
      leaseOwner: text(100),
      leaseExpiresAt: date(),
      fence: count(0),
    },
    [
      ...Object.keys(scope),
      'actorUserId',
      'namespace',
      'key',
      'fingerprint',
      'kind',
      'state',
    ],
  ),
  handover_jobs: collection(
    {
      ...binding,
      initiatedBy: user(),
      commandId: ref(),
      kind: values('SOURCE_PROPOSAL', 'GENERATION'),
      state: values(
        'PENDING',
        'RUNNING',
        'SUCCEEDED',
        'FAILED',
        'SUPERSEDED',
        'CANCELLED',
      ),
      inputDraftVersion: count(0),
      query: text(4000),
      sourceFingerprint: hash(),
      selectedSources: list(source, 100),
      candidates: list(source, 100),
      resultItems: list(item, 100),
      appliedDraftVersion: count(0),
      attempt: count(0),
      safeErrorCode: text(100),
      leaseOwner: text(100),
      leaseExpiresAt: date(),
      finishedAt: date(),
    },
    [
      ...Object.keys(binding),
      'initiatedBy',
      'commandId',
      'kind',
      'state',
      'inputDraftVersion',
      'sourceFingerprint',
      'selectedSources',
      'attempt',
    ],
  ),
  follow_up_tasks: collection(
    {
      ...binding,
      revisionId: ref(),
      itemId: ref(),
      kind: values('KNOWLEDGE_GAP'),
      isRequired: flag(),
      ownerUserId: user(),
      reason: text(2000),
      dueAt: date(),
      status: values('OPEN', 'RESOLVED'),
      version: count(),
      createdBy: user(),
      resolvedAt: nullable(date()),
      resolvedBy: user(),
      resolutionNote: text(10000),
      resolutionEvidenceId: ref(),
    },
    [
      ...Object.keys(binding),
      'revisionId',
      'itemId',
      'kind',
      'isRequired',
      'ownerUserId',
      'reason',
      'dueAt',
      'status',
      'version',
      'createdBy',
      'resolvedAt',
    ],
  ),
};

// Conditions are also enforced by MongoDB for writes bypassing Mongoose.
collections.handovers.schema.oneOf = [
  { properties: { status: { enum: ['OPEN'] } } },
  {
    properties: {
      status: { enum: ['COMPLETED'] },
      successorUserId: user(),
      publishedRevisionId: ref(),
      assignmentVersion: count(),
    },
    required: ['completedAt', 'completedBy', 'completionReviewNote'],
  },
  {
    properties: { status: { enum: ['CANCELLED'] } },
    required: ['cancelledAt', 'cancelledBy', 'cancellationReason'],
  },
];
collections.handover_acceptances.schema.oneOf = [
  {
    properties: {
      kind: { enum: ['PACKAGE'] },
      decision: { enum: ['ACCEPTED'] },
    },
    not: {
      anyOf: [
        'itemId',
        'contentVersion',
        'dependencyFingerprint',
        'carriedFromAcceptanceId',
      ].map((field) => ({ required: [field] })),
    },
  },
  {
    properties: {
      kind: { enum: ['ITEM'] },
      decision: { enum: ['UNDERSTOOD', 'NEEDS_CLARIFICATION'] },
    },
    required: Object.keys(itemBinding),
  },
];
collections.handover_operations.schema.oneOf = [
  { properties: { kind: { enum: ['COMMAND'] } } },
  {
    properties: { kind: { enum: ['TASK_TRANSFER'] } },
    required: [
      'handoverId',
      'revisionId',
      'assignmentVersion',
      'successorUserId',
      'expectedVersion',
    ],
  },
  {
    properties: { kind: { enum: ['TASK_TRANSFER_CHILD'] } },
    required: [
      'handoverId',
      'revisionId',
      'assignmentVersion',
      'successorUserId',
      'expectedVersion',
      'parentOperationId',
      'taskIntent',
    ],
  },
];
collections.handover_jobs.schema.oneOf = [
  { properties: { kind: { enum: ['SOURCE_PROPOSAL'] } }, required: ['query'] },
  { properties: { kind: { enum: ['GENERATION'] } } },
];
collections.follow_up_tasks.schema.oneOf = [
  {
    properties: {
      status: { enum: ['OPEN'] },
      resolvedAt: { bsonType: 'null' },
    },
  },
  {
    properties: { status: { enum: ['RESOLVED'] }, resolvedAt: date() },
    required: ['resolvedBy', 'resolutionNote'],
  },
];

const addIndex = (collectionName, name, key, options = {}) =>
  collections[collectionName].indexes.push({ name, key, ...options });
const v2 = { schemaVersion: 2 };
addIndex(
  'handovers',
  'handover_v2_open_unique',
  { organizationId: 1, projectId: 1, departingUserId: 1 },
  { unique: true, partialFilterExpression: { ...v2, status: 'OPEN' } },
);
addIndex(
  'handovers',
  'handover_v2_project_status_date',
  {
    organizationId: 1,
    projectId: 1,
    status: 1,
    targetCompletionDate: 1,
    _id: 1,
  },
  { partialFilterExpression: v2 },
);
addIndex(
  'handover_items',
  'handover_v2_draft_item_unique',
  { handoverId: 1, itemId: 1 },
  { unique: true, partialFilterExpression: v2 },
);
addIndex(
  'handover_revisions',
  'handover_v2_revision_unique',
  { handoverId: 1, number: 1 },
  { unique: true },
);
for (const name of [
  'handover_acceptances',
  'handover_evidence',
  'handover_evidence_reviews',
]) {
  addIndex(name, `${name}_command_unique`, { commandId: 1 }, { unique: true });
  addIndex(name, `${name}_binding_sequence`, {
    handoverId: 1,
    revisionId: 1,
    successorUserId: 1,
    assignmentVersion: 1,
    itemId: 1,
    sequence: -1,
  });
}
addIndex('handover_evidence_reviews', 'handover_evidence_review_submission', {
  evidenceId: 1,
  sequence: -1,
});
addIndex(
  'handover_operations',
  'handover_operation_key_unique',
  { organizationId: 1, projectId: 1, actorUserId: 1, namespace: 1, key: 1 },
  { unique: true },
);
addIndex('handover_operations', 'handover_operation_pending', {
  handoverId: 1,
  kind: 1,
  state: 1,
});
addIndex('handover_operations', 'handover_operation_children', {
  parentOperationId: 1,
  _id: 1,
});
addIndex(
  'handover_jobs',
  'handover_job_command_unique',
  { commandId: 1 },
  { unique: true },
);
addIndex('handover_jobs', 'handover_job_project_state', {
  organizationId: 1,
  projectId: 1,
  state: 1,
  createdAt: -1,
});
addIndex(
  'follow_up_tasks',
  'handover_v2_followup_owner_due',
  { organizationId: 1, projectId: 1, ownerUserId: 1, status: 1, dueAt: 1 },
  { partialFilterExpression: v2 },
);
addIndex(
  'follow_up_tasks',
  'handover_v2_followup_item_unique',
  { handoverId: 1, revisionId: 1, itemId: 1 },
  { unique: true, partialFilterExpression: v2 },
);

const legacyCollections = ['handovers', 'handover_items', 'follow_up_tasks'];
function validatorFor(name) {
  const current = { $jsonSchema: collections[name].schema };
  const validator = legacyCollections.includes(name)
    ? {
        $or: [
          { schemaVersion: { $exists: false } },
          { schemaVersion: 1 },
          current,
        ],
      }
    : current;
  // Avoid oversized immutable snapshots independently of the HTTP request limit.
  if (name === 'handover_revisions')
    return {
      $and: [
        validator,
        { $expr: { $lte: [{ $bsonSize: '$$ROOT' }, 4 * 1024 * 1024] } },
      ],
    };
  if (name === 'handover_evidence_reviews')
    return {
      $and: [
        validator,
        { $expr: { $ne: ['$reviewerUserId', '$successorUserId'] } },
      ],
    };
  return validator;
}

module.exports = { collections, legacyCollections, validatorFor };
