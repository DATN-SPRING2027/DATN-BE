import { buildProjectCodeIndexPlan } from './project-code-index.plan.mjs';

export async function inspectProjectCodeIndex({ db, collectionName = 'projects', targetFingerprint }) {
  const collectionExists = (await db.listCollections({ name: collectionName }, { nameOnly: true }).toArray()).length === 1;
  const collection = db.collection(collectionName);
  const indexes = collectionExists ? await collection.indexes() : [];
  const duplicatePairs = collectionExists ? await collection.aggregate([
    { $group: { _id: { organizationId: '$organizationId', code: '$code' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { '_id.organizationId': 1, '_id.code': 1 } },
    { $project: { _id: 0, organizationId: '$_id.organizationId', code: '$_id.code', count: 1 } },
  ], { collation: { locale: 'simple' } }).toArray() : [];
  const projectCount = collectionExists ? await collection.countDocuments() : 0;
  return buildProjectCodeIndexPlan({
    databaseName: db.databaseName,
    targetFingerprint,
    collectionExists,
    projectCount,
    indexes,
    duplicatePairs,
  });
}
