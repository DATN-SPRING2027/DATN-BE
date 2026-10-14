import mongoose from 'mongoose';
import { lifecycleHash } from './organization-membership-lifecycle.plan.mjs';
import {
  isCanonicalArchivedReason,
  isCanonicalTeamCode,
  isCanonicalTeamName,
  isValidTeamDescription,
  isValidTeamVersion,
  normalizeTeamCode,
} from '../../src/services/iam/infrastructure/mongodb/team-foundation.rules.cjs';

export const TEAM_FOUNDATION_DATABASE = 'continuum_iam';
export const TEAM_CODE_INDEX = Object.freeze({
  organizationId: 1,
  projectId: 1,
  code: 1,
});
const { ObjectId, BSON } = mongoose.mongo;
const id = (value) => (value instanceof ObjectId ? value.toHexString() : null);
const date = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
export function planTeamFoundation(snapshot) {
  if (snapshot.databaseName !== TEAM_FOUNDATION_DATABASE)
    throw new Error('IAM_TARGET_REQUIRED');
  const issues = [],
    collisions = new Map();
  const add = (issueCode, row, field) =>
    issues.push({
      code: issueCode,
      id: id(row?._id),
      ...(field ? { field } : {}),
    });
  for (const name of ['teams', 'organizations', 'projects']) {
    if (snapshot.objects[name]?.type !== 'collection')
      add('COLLECTION_UNAVAILABLE', null, name);
  }
  const orgs = new Set(
    snapshot.organizations.map((row) => id(row._id)).filter(Boolean),
  );
  const projects = new Map(snapshot.projects.map((row) => [id(row._id), row]));
  for (const row of snapshot.teams) {
    for (const field of ['_id', 'organizationId', 'projectId'])
      if (!id(row[field])) add('INVALID_OBJECT_ID', row, field);
    const parent = projects.get(id(row.projectId));
    if (
      !orgs.has(id(row.organizationId)) ||
      !parent ||
      id(parent.organizationId) !== id(row.organizationId)
    )
      add('PARENT_MISSING_OR_MISMATCHED', row);
    if (!isCanonicalTeamName(row.name))
      add('INVALID_OR_NONCANONICAL', row, 'name');
    if (!isCanonicalTeamCode(row.code))
      add('INVALID_OR_NONCANONICAL', row, 'code');
    if (!isValidTeamDescription(row.description))
      add('INVALID_OR_MISSING', row, 'description');
    if (!['ACTIVE', 'ARCHIVED'].includes(row.status))
      add('LIFECYCLE_MAPPING_REQUIRED', row, 'status');
    if (!isValidTeamVersion(row.version))
      add('VERSION_MAPPING_REQUIRED', row, 'version');
    for (const field of ['createdAt', 'updatedAt'])
      if (!date(row[field])) add('INVALID_BSON_DATE', row, field);
    for (const field of ['archivedAt', 'archivedBy', 'archivedReason']) {
      const validArchive =
        field === 'archivedAt'
          ? date(row[field])
          : field === 'archivedBy'
            ? id(row[field]) !== null
            : isCanonicalArchivedReason(row[field]);
      if (row.status === 'ARCHIVED' ? !validArchive : row[field] !== null)
        add('ARCHIVE_MAPPING_REQUIRED', row, field);
    }
    const normalizedCode =
      typeof row.code === 'string' ? normalizeTeamCode(row.code) : null;
    if (id(row.organizationId) && id(row.projectId) && normalizedCode) {
      const key = `${id(row.organizationId)}:${id(row.projectId)}:${normalizedCode}`;
      const previous = collisions.get(key);
      if (previous) add('CODE_COLLISION', row, 'code');
      else collisions.set(key, id(row._id) ?? 'invalid');
    }
  }
  const object = snapshot.objects.teams;
  const sameKey = (index) =>
    JSON.stringify(index.key) === JSON.stringify(TEAM_CODE_INDEX);
  const exact = (index) =>
    sameKey(index) &&
    index.unique === true &&
    !index.sparse &&
    !index.hidden &&
    index.partialFilterExpression === undefined &&
    index.expireAfterSeconds === undefined &&
    (!index.collation || index.collation.locale === 'simple');
  const indexes = object?.indexes ?? [];
  if (
    !indexes.some(exact) ||
    indexes.some((index) => sameKey(index) && !exact(index))
  )
    add('CODE_INDEX_REVIEW_REQUIRED');
  if (
    object?.options?.collation &&
    object.options.collation.locale !== 'simple'
  )
    add('COLLECTION_COLLATION_REVIEW_REQUIRED');
  // This is an inventory, not a rollout plan: no inferred defaults or writes.
  const report = {
    migration: '20261014-team-foundation-preflight-v1',
    databaseName: snapshot.databaseName,
    targetFingerprint: snapshot.targetFingerprint,
    assessmentBasis: {
      source: 'DATN-89 latest Team decision table',
      asOf: '2026-10-14',
      decisionStatus: 'PARTIAL',
      dispositions: {
        'TQ-01': 'APPROVE',
        'TQ-02': 'APPROVE',
        'TQ-03': 'APPROVE',
        'TQ-04': 'APPROVE',
        'TQ-05': 'AMEND',
        'TQ-06': 'AMEND',
        'TQ-07': 'AMEND',
        'TQ-08': 'AMEND',
        'TQ-09': { contract: 'APPROVE', mutations: 'DEFER' },
        'TQ-10': 'DEFER',
      },
      runtimeSchemaEnforced: false,
      rolloutReady: false,
    },
    sourceSha256: lifecycleHash(
      BSON.EJSON.serialize(snapshot, { relaxed: false }),
    ),
    counts: {
      teams: snapshot.teams.length,
      organizations: snapshot.organizations.length,
      projects: snapshot.projects.length,
    },
    observedIndexes: indexes,
    desiredCodeIndex: { key: TEAM_CODE_INDEX, unique: true },
    clean: issues.length === 0,
    issues,
    applySupported: false,
    proposedDocumentWrites: [],
  };
  return { ...report, reportSha256: lifecycleHash(report) };
}
