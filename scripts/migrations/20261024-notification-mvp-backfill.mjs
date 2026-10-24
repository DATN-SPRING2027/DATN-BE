import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { planNotificationMvpMigration } from './notification-mvp-backfill.plan.mjs';

const databaseName = 'continuum_notification';
const collectionName = 'notifications';

function fingerprintUri(uri) {
  return createHash('sha256').update(uri).digest('hex');
}

async function inspectTarget(db, targetFingerprint) {
  const collections = await db
    .listCollections({ name: collectionName }, { nameOnly: false })
    .toArray();
  if (collections.length === 0) {
    return {
      databaseName: db.databaseName,
      targetFingerprint,
      collection: { objectType: null, indexes: [] },
    };
  }

  const col = db.collection(collectionName);
  const [
    documentCount,
    missingRecipientIdCount,
    missingEventKeyCount,
    duplicateGroups,
    rawIndexes,
  ] = await Promise.all([
    col.countDocuments({}),
    col.countDocuments({
      $or: [{ recipientId: { $exists: false } }, { recipientId: null }],
    }),
    col.countDocuments({
      $or: [{ eventKey: { $exists: false } }, { eventKey: null }],
    }),
    col
      .aggregate([
        {
          $match: {
            recipientId: { $type: 'string' },
            eventKey: { $type: 'string' },
          },
        },
        {
          $group: {
            _id: { recipientId: '$recipientId', eventKey: '$eventKey' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray(),
    col.indexes(),
  ]);

  return {
    databaseName: db.databaseName,
    targetFingerprint,
    collection: {
      objectType: collections[0].type ?? 'collection',
      documentCount,
      missingRecipientIdCount,
      missingEventKeyCount,
      duplicateEventKeysCount: duplicateGroups.length,
      indexes: rawIndexes.filter((idx) => idx.name !== '_id_'),
    },
  };
}

async function applyMigration(db, plan) {
  const col = db.collection(collectionName);

  if (!plan.rollback) {
    // Backfill legacy documents where recipientId or eventKey is missing
    const cursor = col.find({
      $or: [
        { recipientId: { $exists: false } },
        { recipientId: null },
        { eventKey: { $exists: false } },
        { eventKey: null },
      ],
    });
    for await (const doc of cursor) {
      const recipientId = String(doc.recipientId ?? doc.recipientUserId ?? '');
      const eventKey = String(doc.eventKey ?? `legacy:${String(doc._id)}`);
      const readAt =
        doc.readAt !== undefined
          ? doc.readAt
          : doc.isRead
            ? (doc.updatedAt ?? doc.createdAt ?? new Date())
            : null;
      await col.updateOne(
        { _id: doc._id },
        {
          $set: {
            recipientId,
            recipientUserId: doc.recipientUserId ?? recipientId,
            eventKey,
            readAt,
            message: doc.message ?? doc.body ?? '',
          },
        },
      );
    }
  }

  for (const indexSpec of plan.desiredIndexes) {
    if (indexSpec.action === 'CREATE') {
      const options = { name: indexSpec.name };
      if (indexSpec.unique) options.unique = true;
      if (indexSpec.sparse) options.sparse = true;
      if (indexSpec.expireAfterSeconds !== undefined) {
        options.expireAfterSeconds = indexSpec.expireAfterSeconds;
      }
      await col.createIndex(indexSpec.key, options);
    } else if (indexSpec.action === 'DROP') {
      await col.dropIndex(indexSpec.name);
    }
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }
  const apply = process.argv.includes('--apply');
  const rollback = process.argv.includes('--rollback');

  const conn = await mongoose.createConnection(uri).asPromise();
  try {
    const db = conn.useDb(databaseName).db;
    const snapshot = await inspectTarget(db, fingerprintUri(uri));
    const plan = planNotificationMvpMigration(snapshot, { rollback });
    console.log(JSON.stringify(plan, null, 2));

    if (!plan.clean) {
      process.exitCode = 1;
      return;
    }
    if (apply) {
      await applyMigration(db, plan);
    }
  } finally {
    await conn.close();
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
