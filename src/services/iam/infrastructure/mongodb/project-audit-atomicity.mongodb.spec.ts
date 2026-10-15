import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { MongoProjectAccessRepository } from './project-access.repository';

const integration =
  process.env.PROJECT_AUDIT_ATOMICITY_INTEGRATION === 'true'
    ? describe
    : describe.skip;

function localReplicaSetUri(): string {
  const value = process.env.MONGODB_URI;
  if (!value) throw new Error('MONGODB_URI is required');
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('MONGODB_URI is invalid');
  }
  if (
    uri.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost'].includes(uri.hostname) ||
    uri.port === '27017' ||
    uri.username !== '' ||
    uri.password !== '' ||
    !uri.searchParams.has('replicaSet')
  )
    throw new Error(
      'Audit atomicity test requires a local disposable replica set',
    );
  return value;
}

integration('MongoProjectAccessRepository audit atomicity', () => {
  jest.setTimeout(60_000);

  it('rolls back a Project mutation when its same-session audit insert fails', async () => {
    const uri = localReplicaSetUri();
    const databaseName = `datn90_audit_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const auditDatabaseName = `${databaseName}_audit`;
    const connection = mongoose.createConnection(uri, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5_000,
    });
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db || db.databaseName !== databaseName)
        throw new Error('Isolated IAM test database is unavailable');
      const auditConnection = connection.useDb(auditDatabaseName, {
        useCache: true,
      });
      const collections = [
        'projects',
        'users',
        'organization_memberships',
        'project_memberships',
        'roles',
        'role_assignments',
      ];
      for (const collection of collections) {
        await db.createCollection(collection);
        const definition = IAM_PERSISTENCE.collections.find(
          (item) => item.name === collection,
        );
        if (!definition) throw new Error(`${collection} schema is missing`);
        const model = connection.model(
          `continuum_iam_${collection}`,
          createCollectionSchema(definition),
        );
        await model.createIndexes();
      }
      await auditConnection.createCollection('audit_logs_iam');

      const organizationId = new Types.ObjectId();
      const projectId = new Types.ObjectId();
      const adminId = new Types.ObjectId();
      const adminRoleId = new Types.ObjectId();
      const now = new Date();
      await db.collection('projects').insertOne({
        _id: projectId,
        organizationId,
        name: 'Audit atomicity project',
        code: 'AUDIT',
        visibility: 'PRIVATE',
        status: 'ACTIVE',
        createdBy: adminId,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection('users').insertOne({
        _id: adminId,
        email: `${adminId.toHexString()}@example.test`,
        status: 'ACTIVE',
      });
      await db.collection('organization_memberships').insertOne({
        _id: new Types.ObjectId(),
        organizationId,
        userId: adminId,
        status: 'ACTIVE',
      });
      await db.collection('roles').insertOne({
        _id: adminRoleId,
        code: 'ADMIN',
        name: 'Admin',
        permissions: ['project.visibility.manage'],
        isSystem: true,
      });
      await db.collection('role_assignments').insertOne({
        _id: new Types.ObjectId(),
        organizationId,
        userId: adminId,
        roleId: adminRoleId,
        roleCode: 'ADMIN',
        assignedBy: adminId,
      });

      const repository = new MongoProjectAccessRepository(
        connection,
        auditDatabaseName,
      );
      const auditDatabase = auditConnection.db;
      if (!auditDatabase)
        throw new Error('Isolated audit test database is unavailable');
      await auditDatabase.command({
        collMod: 'audit_logs_iam',
        validator: { action: { $ne: 'PROJECT_VISIBILITY_CHANGED' } },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      try {
        const failure = await repository
          .changeVisibility(
            organizationId.toHexString(),
            adminId.toHexString(),
            projectId.toHexString(),
            'PUBLIC',
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({ code: 121 });
        expect(
          (await db.collection('projects').findOne({ _id: projectId }))
            ?.visibility,
        ).toBe('PRIVATE');
        expect(
          await auditConnection
            .collection('audit_logs_iam')
            .countDocuments({ action: 'PROJECT_VISIBILITY_CHANGED' }),
        ).toBe(0);
      } finally {
        await auditDatabase.command({
          collMod: 'audit_logs_iam',
          validator: {},
          validationLevel: 'strict',
          validationAction: 'error',
        });
      }

      const committed = await repository.changeVisibility(
        organizationId.toHexString(),
        adminId.toHexString(),
        projectId.toHexString(),
        'PUBLIC',
      );
      expect(committed.visibility).toBe('PUBLIC');
      expect(
        await auditConnection
          .collection('audit_logs_iam')
          .countDocuments({ action: 'PROJECT_VISIBILITY_CHANGED' }),
      ).toBe(1);
    } finally {
      // The runner owns this disposable replica set and discards both databases.
      await connection.close();
    }
  });
});
