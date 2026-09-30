import { buildProjectCodeIndexPlan } from './project-code-index.plan.mjs';

export async function inspectProjectCodeIndex({
  db,
  collectionName = 'projects',
  targetFingerprint,
}) {
  const objects = await db.listCollections({ name: collectionName }).toArray();
  const objectType = objects.length === 0 ? null : objects[0].type;
  const collectionExists = objectType === 'collection';
  const collection = db.collection(collectionName);
  const indexes = collectionExists ? await collection.indexes() : [];
  const normalizeCodeStages = [
    {
      $set: {
        codeIsString: { $eq: [{ $type: '$code' }, 'string'] },
        normalizedCode: {
          $cond: [
            { $eq: [{ $type: '$code' }, 'string'] },
            { $toUpper: { $trim: { input: '$code' } } },
            null,
          ],
        },
      },
    },
    {
      $set: {
        codeIsCanonical: {
          $and: ['$codeIsString', { $eq: ['$code', '$normalizedCode'] }],
        },
      },
    },
  ];
  const aggregateOptions = { collation: { locale: 'simple' } };
  const duplicatePairs = collectionExists
    ? await collection
        .aggregate(
          [
            ...normalizeCodeStages,
            { $match: { codeIsString: true } },
            {
              $group: {
                _id: {
                  organizationId: '$organizationId',
                  code: '$normalizedCode',
                },
                count: { $sum: 1 },
              },
            },
            { $match: { count: { $gt: 1 } } },
            { $sort: { '_id.organizationId': 1, '_id.code': 1 } },
            {
              $project: {
                _id: 0,
                organizationId: '$_id.organizationId',
                code: '$_id.code',
                count: 1,
              },
            },
          ],
          aggregateOptions,
        )
        .toArray()
    : [];
  const nonCanonicalProjectCodes = collectionExists
    ? await collection
        .aggregate(
          [
            ...normalizeCodeStages,
            { $match: { codeIsCanonical: false } },
            {
              $project: {
                _id: 0,
                projectId: '$_id',
                organizationId: 1,
                code: 1,
                normalizedCode: 1,
              },
            },
            { $sort: { projectId: 1 } },
          ],
          aggregateOptions,
        )
        .toArray()
    : [];
  const projectCount = collectionExists ? await collection.countDocuments() : 0;
  return buildProjectCodeIndexPlan({
    databaseName: db.databaseName,
    targetFingerprint,
    collectionExists,
    objectType,
    projectCount,
    indexes,
    duplicatePairs,
    nonCanonicalProjectCodes,
  });
}
