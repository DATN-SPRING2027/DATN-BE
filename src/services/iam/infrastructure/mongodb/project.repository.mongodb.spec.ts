import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { AuthorizationPolicy } from '../../application/authorization/authorization.policy';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoProjectRepository } from './project.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('MongoProjectRepository transaction and unique index', () => {
  it('commits Project with audit, rolls back an audit failure, and scopes codes by Organization', async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    const databaseName = `pf_api_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const connection = mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    let createdDatabase = false;
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db) throw new Error('MongoDB connection unavailable');
      if (db.databaseName !== databaseName)
        throw new Error('Wrong test database');
      await db.createCollection('projects');
      createdDatabase = true;
      await db.createCollection('audit_logs_iam');
      await db.collection('projects').createIndex(
        { organizationId: 1, code: 1 },
        {
          unique: true,
          collation: { locale: 'simple' },
        },
      );
      const definition = IAM_PERSISTENCE.collections.find(
        (item) => item.name === 'projects',
      );
      if (!definition) throw new Error('Project schema missing');
      connection.model(
        'continuum_iam_projects',
        createCollectionSchema(definition),
      );
      const repository = new MongoProjectRepository(
        new AuthorizationPolicy(),
        connection,
      );
      const orgA = new Types.ObjectId().toString();
      const orgB = new Types.ObjectId().toString();
      const user = new Types.ObjectId().toString();

      const first = await repository.create(orgA, user, {
        name: 'First',
        code: 'EX',
      });
      expect(first.organizationId).toBe(orgA);
      expect(await db.collection('projects').countDocuments()).toBe(1);
      expect(
        await db.collection('audit_logs_iam').countDocuments({
          targetResourceId: first.id,
          action: 'project.create',
        }),
      ).toBe(1);

      // Test-only audit constraint forces the second audit write to fail.
      await db
        .collection('audit_logs_iam')
        .createIndex({ action: 1 }, { unique: true });
      await expect(
        repository.create(orgA, user, { name: 'Rolled back', code: 'NEW' }),
      ).rejects.toThrow();
      expect(await db.collection('projects').countDocuments()).toBe(1);
      expect(
        await db.collection('projects').countDocuments({ code: 'NEW' }),
      ).toBe(0);
      await db.collection('audit_logs_iam').dropIndex('action_1');

      await expect(
        repository.create(orgA, user, { name: 'Duplicate', code: 'EX' }),
      ).rejects.toMatchObject({ status: 409 });
      const second = await repository.create(orgB, user, {
        name: 'Other Org',
        code: 'EX',
      });
      expect(second.organizationId).toBe(orgB);
      expect(await db.collection('projects').countDocuments()).toBe(2);
      expect(await db.collection('audit_logs_iam').countDocuments()).toBe(2);
    } finally {
      if (
        createdDatabase &&
        connection.readyState === mongoose.ConnectionStates.connected &&
        connection.db?.databaseName === databaseName
      )
        await connection.db.dropDatabase();
      await connection.close();
    }
  });
});
