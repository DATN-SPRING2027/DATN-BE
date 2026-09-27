import 'dotenv/config';
import { ConflictException } from '@nestjs/common';
import { createConnection, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoUserDirectoryRepository } from '../src/services/iam/infrastructure/mongodb/user-directory.repository';
import { createCollectionSchema } from '../src/services/iam/infrastructure/mongodb/mongodb.schemas';
import { IAM_PERSISTENCE } from '../src/services/iam/infrastructure/persistence';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('User status invariants in continuum_db', () => {
  let connection: Connection;
  let repository: MongoUserDirectoryRepository;
  const organizationA = new Types.ObjectId();
  const organizationB = new Types.ObjectId();
  const adminA = new Types.ObjectId();
  const adminB = new Types.ObjectId();
  const sharedAdmin = new Types.ObjectId();
  const roleId = new Types.ObjectId();
  const userIds = [adminA, adminB, sharedAdmin];
  const organizationIds = [organizationA, organizationB];

  beforeAll(async () => {
    connection = await createConnection(process.env.MONGODB_URI ?? '', {
      dbName: 'continuum_db',
      serverSelectionTimeoutMS: 10000,
    }).asPromise();
    for (const definition of IAM_PERSISTENCE.collections) {
      if (
        ['users', 'organizations', 'role_assignments'].includes(definition.name)
      ) {
        connection.model(
          `${IAM_PERSISTENCE.databaseName}_${definition.name}`,
          createCollectionSchema(definition),
        );
      }
    }
    repository = new MongoUserDirectoryRepository(connection);
    const now = new Date();
    await connection.collection('organizations').insertMany(
      organizationIds.map((_id, index) => ({
        _id,
        name: `Disposable User Review ${index}`,
        slug: `disposable-user-review-${_id.toHexString()}`,
        plan: 'FREE',
        createdAt: now,
        updatedAt: now,
      })),
    );
    await connection.collection('users').insertMany(
      userIds.map((_id, index) => ({
        _id,
        email: `disposable-user-review-${_id.toHexString()}@example.test`,
        fullName: `Disposable Admin ${index}`,
        passwordHash: 'unused-in-status-test',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      })),
    );
    await connection.collection('role_assignments').insertMany(
      [
        [organizationA, adminA],
        [organizationA, adminB],
        [organizationA, sharedAdmin],
        [organizationB, sharedAdmin],
      ].map(([organizationId, userId]) => ({
        organizationId,
        userId,
        roleId,
        roleCode: 'ADMIN',
        assignedBy: adminA,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }, 30000);

  afterAll(async () => {
    if (!connection) return;
    await connection.collection('role_assignments').deleteMany({
      organizationId: { $in: organizationIds },
    });
    await connection.collection('users').deleteMany({ _id: { $in: userIds } });
    await connection.collection('organizations').deleteMany({
      _id: { $in: organizationIds },
    });
    await connection.close();
  }, 30000);

  it('lists a bounded page with role and status filters without exposing credentials', async () => {
    const first = await repository.list(organizationA.toHexString(), {
      page: 1,
      pageSize: 2,
      roleCode: 'ADMIN',
      status: 'ACTIVE',
    });
    const second = await repository.list(organizationA.toHexString(), {
      page: 2,
      pageSize: 2,
      roleCode: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(first.totalItems).toBe(3);
    expect(first.data).toHaveLength(2);
    expect(second.totalItems).toBe(3);
    expect(second.data).toHaveLength(1);
    expect(JSON.stringify([first, second])).not.toContain('passwordHash');
  }, 30000);

  it('serializes concurrent suspension of the last two admins', async () => {
    // The shared account remains active in A, so first remove its A role.
    await connection.collection('role_assignments').deleteOne({
      organizationId: organizationA,
      userId: sharedAdmin,
    });
    const results = await Promise.allSettled([
      repository.update(organizationA.toHexString(), adminA.toHexString(), {
        status: 'SUSPENDED',
      }),
      repository.update(organizationA.toHexString(), adminB.toHexString(), {
        status: 'SUSPENDED',
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === 'rejected',
        ) as PromiseRejectedResult
      ).reason,
    ).toBeInstanceOf(ConflictException);
    expect(
      await repository.countActiveAdmins(organizationA.toHexString()),
    ).toBe(1);
  }, 30000);

  it('rejects a status change to an account shared with another organization', async () => {
    await connection.collection('role_assignments').insertOne({
      organizationId: organizationA,
      userId: sharedAdmin,
      roleId,
      roleCode: 'ADMIN',
      assignedBy: adminA,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      repository.update(
        organizationA.toHexString(),
        sharedAdmin.toHexString(),
        {
          status: 'SUSPENDED',
        },
      ),
    ).rejects.toMatchObject({
      response: { code: 'SHARED_ACCOUNT_STATUS_CHANGE' },
    });
    expect(
      await repository.countActiveAdmins(organizationB.toHexString()),
    ).toBe(1);
  }, 30000);
});
