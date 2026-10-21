import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
export const RECOVERY_DATABASE = 'continuum_iam';
export const RECOVERY_MARKER = 'org08-mongo8-fence-recovery-disposable';
export const RECOVERY_NAME =
  '20261021-organization-role-fence-recovery-local-v1';
const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
        )
      : value;
const canonical = (value) =>
  JSON.stringify(
    sortKeys(
      JSON.parse(
        mongoose.mongo.BSON.EJSON.stringify(value, { relaxed: false }),
      ),
    ),
  );
export const recoveryHash = (value) =>
  createHash('sha256').update(canonical(value)).digest('hex');
export const snapshotHash = (rows) =>
  recoveryHash(
    [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id))),
  );
const isId = (value) => value instanceof mongoose.mongo.ObjectId;
const isDate = (value) =>
  value instanceof Date && Number.isFinite(value.getTime());
export function buildFenceRecoveryPlan(rows, target) {
  const findings = [];
  for (const row of rows) {
    const fingerprint = recoveryHash(row._id).slice(0, 20);
    if (
      ['_id', 'organizationId', 'userId', 'roleId', 'assignedBy'].some(
        (key) => !isId(row[key]),
      ) ||
      (row.projectId != null && !isId(row.projectId)) ||
      !['ADMIN', 'MEMBER', 'TEAM_LEADER'].includes(row.roleCode) ||
      (row.projectId == null && row.roleCode === 'TEAM_LEADER') ||
      !isDate(row.createdAt) ||
      !isDate(row.updatedAt)
    )
      findings.push({ fingerprint, code: 'INVALID_ASSIGNMENT_METADATA' });
    if (
      Object.hasOwn(row, 'mutationFence') &&
      (!Number.isSafeInteger(row.mutationFence) || row.mutationFence < 0)
    )
      findings.push({ fingerprint, code: 'INVALID_EXISTING_FENCE' });
  }
  const missing = rows.filter((row) => !Object.hasOwn(row, 'mutationFence'));
  const body = {
    migration: RECOVERY_NAME,
    schemaVersion: 1,
    target,
    clean: findings.length === 0,
    totalCount: rows.length,
    missingCount: missing.length,
    beforeHash: snapshotHash(rows),
    afterHash: snapshotHash(
      rows.map((row) =>
        Object.hasOwn(row, 'mutationFence')
          ? row
          : { ...row, mutationFence: 0 },
      ),
    ),
    findings,
  };
  return { ...body, planHash: recoveryHash(body) };
}
export function validateReviewedPlan(plan, target) {
  const { planHash, ...body } = plan ?? {};
  if (
    body.migration !== RECOVERY_NAME ||
    body.schemaVersion !== 1 ||
    body.clean !== true ||
    !Array.isArray(body.findings) ||
    body.findings.length !== 0 ||
    recoveryHash(body.target) !== recoveryHash(target) ||
    recoveryHash(body) !== planHash ||
    ![body.beforeHash, body.afterHash].every(
      (value) => typeof value === 'string' && /^[a-f\d]{64}$/.test(value),
    ) ||
    !Number.isSafeInteger(body.totalCount) ||
    body.totalCount < 0 ||
    !Number.isSafeInteger(body.missingCount) ||
    body.missingCount < 0 ||
    body.missingCount > body.totalCount
  )
    throw new Error('REVIEWED_PLAN_INVALID_OR_WRONG_TARGET');
  return plan;
}
export function validateRecoveryUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('EXPLICIT_LOCAL_RECOVERY_URI_REQUIRED');
  }
  if (
    parsed.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    parsed.pathname !== '/' + RECOVERY_DATABASE ||
    [
      'tlsInsecure',
      'tlsAllowInvalidCertificates',
      'tlsAllowInvalidHostnames',
    ].some((key) => parsed.searchParams.get(key) === 'true')
  )
    throw new Error('DISPOSABLE_LOOPBACK_IAM_ONLY');
  return uri;
}
