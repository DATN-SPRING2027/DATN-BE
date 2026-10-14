import mongoose from 'mongoose';
import { TASK_COLLECTION, TASK_EVENT_COLLECTION } from './task-contract';
import {
  TASK_COLLECTION_VALIDATORS,
  TASK_PERSISTENCE_INDEXES,
  taskValidatorCommand,
} from './task-database-schema';

export const TASK_DISPOSABLE_FIXTURE_MARKER =
  'datn-95-task-data-foundation-mongo7-disposable';
const DISPOSABLE_DATABASE_PATTERN = /^datn95task_[a-f\d]{32}$/;
const ALLOWED_COLLECTIONS = new Set([TASK_COLLECTION, TASK_EVENT_COLLECTION]);

export async function initializeTaskDisposableDatabase(
  database: mongoose.mongo.Db,
): Promise<void> {
  if (!DISPOSABLE_DATABASE_PATTERN.test(database.databaseName))
    throw new Error('Task initializer requires a named disposable database');

  const marker = await database.client
    .db('admin')
    .collection<{ _id: string }>('datn_migration_test_fixture')
    .findOne({ _id: TASK_DISPOSABLE_FIXTURE_MARKER });
  if (!marker)
    throw new Error(
      'Task initializer requires its MongoDB 7 test fixture marker',
    );

  const collections = await database
    .listCollections({}, { nameOnly: true })
    .toArray();
  if (collections.some(({ name }) => !ALLOWED_COLLECTIONS.has(name)))
    throw new Error(
      'Disposable Task database contains an unexpected collection',
    );

  await ensureCollection(database, TASK_COLLECTION);
  await ensureCollection(database, TASK_EVENT_COLLECTION);
  await database.collection(TASK_COLLECTION).createIndexes(
    TASK_PERSISTENCE_INDEXES.tasks.map(({ key, name, ...options }) => ({
      key: { ...key },
      name,
      ...options,
    })),
  );
  await database.collection(TASK_EVENT_COLLECTION).createIndexes(
    TASK_PERSISTENCE_INDEXES.task_events.map(({ key, name, ...options }) => ({
      key: { ...key },
      name,
      ...options,
    })),
  );
}

async function ensureCollection(
  database: mongoose.mongo.Db,
  name: typeof TASK_COLLECTION | typeof TASK_EVENT_COLLECTION,
): Promise<void> {
  const exists = await database
    .listCollections({ name }, { nameOnly: true })
    .hasNext();
  if (!exists) {
    await database.createCollection(name, {
      validator: TASK_COLLECTION_VALIDATORS[name],
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return;
  }
  await database.command(taskValidatorCommand(name));
}
