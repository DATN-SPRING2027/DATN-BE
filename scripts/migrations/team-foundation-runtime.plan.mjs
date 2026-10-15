import mongoose from 'mongoose';
import { lifecycleHash } from './organization-membership-lifecycle.plan.mjs';
import {
  isCanonicalArchivedReason,
  isCanonicalTeamCode,
  isCanonicalTeamName,
  isValidTeamDescription,
  isValidTeamVersion,
} from '../../src/services/iam/infrastructure/mongodb/team-foundation.rules.cjs';

export const TEAM_FOUNDATION_IAM_DATABASE = 'continuum_iam';
export const TEAM_FOUNDATION_AUDIT_DATABASE = 'continuum_audit';

export const TEAM_FOUNDATION_INDEXES = Object.freeze({
  teams: {
    key: { organizationId: 1, projectId: 1, code: 1 },
    name: 'organizationId_1_projectId_1_code_1',
    unique: true,
  },
  teamOperations: [
    {
      key: { organizationId: 1, actorUserId: 1, keyHash: 1 },
      name: 'team_operation_scope',
      unique: true,
    },
    {
      key: { expiresAt: 1 },
      name: 'team_operation_expiry',
      expireAfterSeconds: 0,
    },
  ],
  audit: {
    key: {
      organizationId: 1,
      'metadata.commandId': 1,
      action: 1,
      targetResourceId: 1,
    },
    name: 'team_audit_command_dedupe',
    unique: true,
    partialFilterExpression: {
      targetResource: 'Team',
      'metadata.commandId': { $exists: true },
    },
  },
});

const { ObjectId, BSON } = mongoose.mongo;
const mutableRuntimeFields = new Set([
  'name',
  'code',
  'description',
  'status',
  'version',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'archivedBy',
  'archivedReason',
]);
const requiredRuntimeFields = [...mutableRuntimeFields];
const validId = (value) => value instanceof ObjectId;
const idString = (value) => (validId(value) ? value.toHexString() : null);
const isDate = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left, right) => {
  if (left === undefined || right === undefined) return left === right;
  return (
    BSON.EJSON.stringify(left, { relaxed: false }) ===
    BSON.EJSON.stringify(right, { relaxed: false })
  );
};

function sameIndexKey(left, right) {
  if (!left || typeof left !== 'object') return false;
  return same(left, right);
}

function indexOptionsMatch(actual, expected) {
  const expectedNames = [
    'unique',
    'expireAfterSeconds',
    'partialFilterExpression',
    'sparse',
    'hidden',
    'collation',
  ];
  return expectedNames.every((key) => {
    if (!has(expected, key))
      return actual[key] === undefined || actual[key] === false;
    return same(actual[key], expected[key]);
  });
}

function compareIndexSet(
  collectionName,
  indexes,
  desired,
  issues,
  indexesToCreate,
) {
  for (const expected of desired) {
    const sameKey = indexes.find((index) =>
      sameIndexKey(index.key, expected.key),
    );
    const sameName = indexes.find((index) => index.name === expected.name);
    if (sameName && !sameIndexKey(sameName.key, expected.key)) {
      issues.push({
        code: 'INDEX_NAME_CONFLICT',
        collection: collectionName,
        index: expected.name,
      });
      continue;
    }
    if (!sameKey) {
      indexesToCreate.push({ collection: collectionName, ...expected });
      continue;
    }
    if (!indexOptionsMatch(sameKey, expected)) {
      issues.push({
        code: 'INDEX_OPTIONS_CONFLICT',
        collection: collectionName,
        index: expected.name,
      });
    }
  }
}

function teamProfileIssues(row, id, issues) {
  for (const [field, valid] of [
    ['name', isCanonicalTeamName(row.name)],
    ['code', isCanonicalTeamCode(row.code)],
    ['description', isValidTeamDescription(row.description)],
    ['version', isValidTeamVersion(row.version)],
  ]) {
    if (!valid) issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field });
  }
  if (!['ACTIVE', 'ARCHIVED'].includes(row.status))
    issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field: 'status' });
  for (const field of ['createdAt', 'updatedAt']) {
    if (!isDate(row[field]))
      issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field });
  }
  if (row.status === 'ACTIVE') {
    for (const field of ['archivedAt', 'archivedBy', 'archivedReason']) {
      if (row[field] !== null)
        issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field });
    }
  } else if (row.status === 'ARCHIVED') {
    if (!isDate(row.archivedAt))
      issues.push({
        code: 'EXPLICIT_MAPPING_REQUIRED',
        id,
        field: 'archivedAt',
      });
    if (!validId(row.archivedBy))
      issues.push({
        code: 'EXPLICIT_MAPPING_REQUIRED',
        id,
        field: 'archivedBy',
      });
    if (!isCanonicalArchivedReason(row.archivedReason))
      issues.push({
        code: 'EXPLICIT_MAPPING_REQUIRED',
        id,
        field: 'archivedReason',
      });
  } else {
    for (const field of ['archivedAt', 'archivedBy', 'archivedReason']) {
      if (!has(row, field))
        issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field });
    }
  }
}

function mappingSetFor(entry, id, issues) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    issues.push({ code: 'INVALID_MAPPING_ENTRY', id });
    return {};
  }
  if (Object.keys(entry).some((field) => !mutableRuntimeFields.has(field))) {
    issues.push({ code: 'INVALID_MAPPING_FIELD', id });
    return {};
  }
  return entry;
}

function sourceHash(snapshot) {
  return lifecycleHash(BSON.EJSON.serialize(snapshot, { relaxed: false }));
}

export function planTeamFoundationRuntime(snapshot, mapping = { teams: [] }) {
  if (snapshot.iamDatabaseName !== TEAM_FOUNDATION_IAM_DATABASE)
    throw new Error('IAM_TARGET_REQUIRED');
  if (snapshot.auditDatabaseName !== TEAM_FOUNDATION_AUDIT_DATABASE)
    throw new Error('AUDIT_TARGET_REQUIRED');

  const issues = [];
  const indexesToCreate = [];
  const createCollections = [];
  const validMappingShape =
    mapping !== null &&
    typeof mapping === 'object' &&
    !Array.isArray(mapping) &&
    Object.keys(mapping).length === 1 &&
    has(mapping, 'teams') &&
    Array.isArray(mapping.teams);
  const mappingRows = validMappingShape ? mapping.teams : [];
  if (!validMappingShape) issues.push({ code: 'INVALID_MAPPING_FILE' });

  const mappings = new Map();
  for (const row of mappingRows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).length !== 2 ||
      !has(row, 'id') ||
      !has(row, 'set')
    ) {
      issues.push({ code: 'INVALID_MAPPING_ENTRY' });
      continue;
    }
    const id = typeof row?.id === 'string' ? row.id.toLowerCase() : '';
    if (!/^[a-f\d]{24}$/.test(id) || mappings.has(id)) {
      issues.push({ code: 'INVALID_OR_DUPLICATE_MAPPING_ID' });
      continue;
    }
    mappings.set(id, mappingSetFor(row.set, id, issues));
  }

  const objects = snapshot.objects ?? {};
  for (const name of ['organizations', 'projects']) {
    if (objects[name]?.type !== 'collection')
      issues.push({ code: 'PARENT_COLLECTION_UNAVAILABLE', collection: name });
  }
  if (objects.teams?.type === undefined)
    createCollections.push({
      database: TEAM_FOUNDATION_IAM_DATABASE,
      name: 'teams',
    });
  else if (objects.teams.type !== 'collection')
    issues.push({ code: 'COLLECTION_TYPE_CONFLICT', collection: 'teams' });
  if (objects.team_operations?.type === undefined)
    createCollections.push({
      database: TEAM_FOUNDATION_IAM_DATABASE,
      name: 'team_operations',
    });
  else if (objects.team_operations.type !== 'collection')
    issues.push({
      code: 'COLLECTION_TYPE_CONFLICT',
      collection: 'team_operations',
    });
  if (snapshot.auditObjects?.audit_logs_iam?.type === undefined)
    createCollections.push({
      database: TEAM_FOUNDATION_AUDIT_DATABASE,
      name: 'audit_logs_iam',
    });
  else if (snapshot.auditObjects.audit_logs_iam.type !== 'collection')
    issues.push({
      code: 'COLLECTION_TYPE_CONFLICT',
      collection: 'audit_logs_iam',
    });

  const organizations = new Set(
    (snapshot.organizations ?? [])
      .map((row) => idString(row._id))
      .filter(Boolean),
  );
  const projects = new Map(
    (snapshot.projects ?? []).map((row) => [idString(row._id), row]),
  );
  const teamRows = snapshot.teams ?? [];
  const updates = [];
  const codes = new Map();
  const matchedMappings = new Set();

  for (const row of teamRows) {
    const id = idString(row._id);
    if (!id) {
      issues.push({ code: 'INVALID_TEAM_ID' });
      continue;
    }
    const supplied = mappings.get(id) ?? {};
    if (mappings.has(id)) matchedMappings.add(id);
    const next = { ...row, ...supplied };
    for (const field of requiredRuntimeFields) {
      if (!has(next, field))
        issues.push({ code: 'EXPLICIT_MAPPING_REQUIRED', id, field });
    }
    for (const field of ['organizationId', 'projectId']) {
      if (!validId(row[field]))
        issues.push({ code: 'INVALID_OBJECT_ID', id, field });
    }
    const project = projects.get(idString(row.projectId));
    if (
      !organizations.has(idString(row.organizationId)) ||
      !project ||
      idString(project.organizationId) !== idString(row.organizationId)
    )
      issues.push({ code: 'PARENT_MISSING_OR_MISMATCHED', id });

    teamProfileIssues(next, id, issues);
    if (
      isCanonicalTeamCode(next.code) &&
      idString(row.organizationId) &&
      idString(row.projectId)
    ) {
      const key = `${idString(row.organizationId)}:${idString(row.projectId)}:${next.code}`;
      if (codes.has(key))
        issues.push({ code: 'TEAM_CODE_COLLISION', id, field: 'code' });
      else codes.set(key, id);
    }

    const set = Object.fromEntries(
      Object.entries(supplied).filter(
        ([field, value]) => !same(row[field], value),
      ),
    );
    if (Object.keys(set).length > 0) {
      const filter = { _id: row._id };
      for (const field of [
        'organizationId',
        'projectId',
        'name',
        'code',
        'description',
        'status',
        'version',
        'createdAt',
        'updatedAt',
        'archivedAt',
        'archivedBy',
        'archivedReason',
      ]) {
        filter[field] = has(row, field)
          ? row[field] === null
            ? { $eq: null, $exists: true }
            : row[field]
          : { $exists: false };
      }
      updates.push({ id, filter, set });
    }
  }

  for (const id of mappings.keys()) {
    if (!matchedMappings.has(id))
      issues.push({ code: 'MAPPING_TEAM_NOT_FOUND', id });
  }

  const teamIndexes = objects.teams?.indexes ?? [];
  compareIndexSet(
    'teams',
    teamIndexes,
    [TEAM_FOUNDATION_INDEXES.teams],
    issues,
    indexesToCreate,
  );
  compareIndexSet(
    'team_operations',
    objects.team_operations?.indexes ?? [],
    TEAM_FOUNDATION_INDEXES.teamOperations,
    issues,
    indexesToCreate,
  );
  compareIndexSet(
    'audit_logs_iam',
    snapshot.auditObjects?.audit_logs_iam?.indexes ?? [],
    [TEAM_FOUNDATION_INDEXES.audit],
    issues,
    indexesToCreate,
  );

  for (const duplicate of snapshot.duplicateGroups ?? []) {
    if (duplicate.count > 0)
      issues.push({
        code: 'UNIQUE_INDEX_DUPLICATES',
        collection: duplicate.collection,
        index: duplicate.index,
      });
  }

  const mappingSha256 = lifecycleHash(
    BSON.EJSON.serialize(mapping, { relaxed: false }),
  );
  const sourceSha256 = sourceHash(snapshot);
  const summary = {
    migration: '20261015-team-foundation-runtime-v1',
    iamDatabaseName: snapshot.iamDatabaseName,
    auditDatabaseName: snapshot.auditDatabaseName,
    targetFingerprint: snapshot.targetFingerprint,
    sourceSha256,
    mappingSha256,
    counts: {
      teams: teamRows.length,
      organizations: (snapshot.organizations ?? []).length,
      projects: (snapshot.projects ?? []).length,
      explicitTeamUpdates: updates.length,
      collectionsToCreate: createCollections.length,
      indexesToCreate: indexesToCreate.length,
    },
    clean: issues.length === 0,
    issues,
    createCollections,
    indexesToCreate,
    writesSupported: true,
  };
  return {
    ...summary,
    updates,
    reportSha256: lifecycleHash(summary),
  };
}

export function publicTeamFoundationRuntimeReport(plan) {
  const { updates: _updates, ...report } = plan;
  return report;
}
