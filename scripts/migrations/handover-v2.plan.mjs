import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import contract from '../../src/services/handover/infrastructure/mongodb/handover-v2.contract.cjs';

export const DATABASE = 'continuum_handover';
export { contract };

export function validateTarget(uri, allowShared = false) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Invalid MongoDB target');
  }
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (
    !['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    authority.includes(',')
  )
    throw new Error('A single MongoDB host is required');
  if (parsed.pathname && !['/', `/${DATABASE}`].includes(parsed.pathname))
    throw new Error(`Target path must be ${DATABASE}`);
  const loopback =
    ['localhost', '127.0.0.1', '[::1]'].includes(
      parsed.hostname.toLowerCase(),
    ) && parsed.protocol === 'mongodb:';
  if (!loopback && !allowShared)
    throw new Error('Shared target requires explicit authorization');
  return {
    databaseName: DATABASE,
    loopback,
    targetFingerprint: createHash('sha256')
      .update(
        `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || 'default'}/${DATABASE}`,
      )
      .digest('hex'),
  };
}

const keyEquals = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);
function optionsEqual(left, right) {
  return (
    ['unique', 'sparse', 'hidden'].every(
      (key) => Boolean(left[key]) === Boolean(right[key]),
    ) &&
    [
      'partialFilterExpression',
      'expireAfterSeconds',
      'collation',
      'wildcardProjection',
    ].every((key) => isDeepStrictEqual(left[key] ?? null, right[key] ?? null))
  );
}

export function planHandoverV2({
  databaseName,
  inventory,
  targetFingerprint = 'offline-plan',
}) {
  if (databaseName !== DATABASE) throw new Error(`Expected ${DATABASE}`);
  const collections = [],
    indexes = [],
    blockers = [];
  for (const [name, definition] of Object.entries(contract.collections)) {
    const current = inventory[name] ?? { exists: false };
    const validator = contract.validatorFor(name);
    if (current.invalidCount)
      blockers.push({
        collection: name,
        code: 'INVALID_DOCUMENTS',
        count: current.invalidCount,
      });
    if (current.orphanCount)
      blockers.push({
        collection: name,
        code: 'ORPHAN_REFERENCES',
        count: current.orphanCount,
      });
    if (
      current.validator &&
      Object.keys(current.validator).length &&
      !isDeepStrictEqual(current.validator, validator)
    )
      blockers.push({ collection: name, code: 'VALIDATOR_CONFLICT' });
    collections.push({
      name,
      action: !current.exists
        ? 'CREATE'
        : isDeepStrictEqual(current.validator, validator) &&
            current.validationLevel === 'strict' &&
            current.validationAction === 'error'
          ? 'KEEP'
          : 'VALIDATE',
      validator,
    });
    for (const index of definition.indexes) {
      const named = current.indexes?.find((i) => i.name === index.name);
      const matchingKey =
        current.indexes?.filter((i) => keyEquals(i.key, index.key)) ?? [];
      const equivalent = matchingKey.find((i) => optionsEqual(i, index));
      if (
        (named &&
          (!keyEquals(named.key, index.key) || !optionsEqual(named, index))) ||
        (matchingKey.length && !equivalent)
      )
        blockers.push({
          collection: name,
          index: index.name,
          code: 'INDEX_CONFLICT',
        });
      if (current.duplicateIndexes?.includes(index.name))
        blockers.push({
          collection: name,
          index: index.name,
          code: 'DUPLICATE_KEYS',
        });
      indexes.push({
        collection: name,
        ...index,
        action: equivalent ? 'KEEP' : 'CREATE',
      });
    }
  }
  const report = {
    databaseName,
    targetFingerprint,
    rewriteDocuments: false,
    inventory,
    collections,
    indexes,
    blockers,
  };
  return {
    ...report,
    reportSha256: createHash('sha256')
      .update(JSON.stringify(report))
      .digest('hex'),
  };
}
