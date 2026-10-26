import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose, { Types, type Connection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { AuthenticationRepository } from './authentication.repository';
import { MongoPlatformAdministrationRepository } from './platform-administration.repository';

const actorId = new Types.ObjectId();
const userId = new Types.ObjectId();
const otherUserId = new Types.ObjectId();
const grantorId = new Types.ObjectId();
const now = new Date();
const updatedAt = new Date(now.getTime() - 60_000);
const expiresAt = new Date(now.getTime() + 86_400_000);
const mutation = {
  actorUserId: actorId.toHexString(),
  userId: userId.toHexString(),
  reasonCode: 'ACCESS_REVIEW' as const,
  now,
};
const collections = [
  'users',
  'refresh_sessions',
  'platform_authority_assignments',
  'platform_authority_change_locks',
];

describe('Platform session revocation on an isolated Mongo replica set', () => {
  jest.setTimeout(120_000);
  let replica: MongoMemoryReplSet;
  let connection: Connection;
  let repository: MongoPlatformAdministrationRepository;
  let authentication: AuthenticationRepository;
  const audit = () =>
    connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME);

  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({
      binary: { version: '7.0.24' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    connection = await mongoose
      .createConnection(replica.getUri(), {
        dbName: `session_security_${randomUUID().replaceAll('-', '')}`,
        autoIndex: false,
      })
      .asPromise();
    for (const name of collections) {
      const definition = IAM_PERSISTENCE.collections.find(
        (c) => c.name === name,
      );
      if (!definition) throw new Error(`Unknown collection ${name}`);
      await connection.createCollection(name);
      connection.model(
        `${IAM_PERSISTENCE.databaseName}_${name}`,
        createCollectionSchema(definition),
        name,
      );
    }
    await connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .createCollection(IAM_AUDIT_COLLECTION_NAME);
    repository = new MongoPlatformAdministrationRepository(connection);
    authentication = new AuthenticationRepository(connection);
  });
  afterAll(async () => {
    await connection?.close();
    await replica?.stop();
  });
  beforeEach(async () => {
    for (const name of collections)
      await connection.collection(name).deleteMany({});
    await audit().deleteMany({});
    await connection.collection('users').insertMany(
      [actorId, userId, otherUserId].map((_id, index) => ({
        _id,
        email: `user${index}@example.test`,
        fullName: `User ${index}`,
        status: 'ACTIVE',
        mutationFence: 0,
        createdAt: updatedAt,
        updatedAt,
      })),
    );
    await connection.collection('platform_authority_change_locks').insertOne({
      permission: 'PLATFORM_OPERATOR_LIFECYCLE',
      scope: 'PLATFORM',
      version: 0,
    });
    await connection.collection('platform_authority_assignments').insertOne({
      subjectUserId: actorId,
      permission: 'platform.sessions.session.manage',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedBy: grantorId,
      grantedAt: updatedAt,
      expiresAt: null,
      revokedAt: null,
    });
  });

  async function seed(sessionId = randomUUID(), owner = userId) {
    await connection.collection('refresh_sessions').insertOne({
      userId: owner,
      sessionId,
      userFence: 0,
      context: 'ACCOUNT',
      tokenHash: `secret-${randomUUID()}`,
      ipAddress: '192.0.2.1',
      userAgent: 'private-device',
      isRevoked: false,
      createdAt: updatedAt,
      updatedAt,
      expiresAt,
    });
    return { sessionId, expectedUpdatedAt: updatedAt };
  }

  it('projects only safe metadata, groups rotation rows, and paginates families', async () => {
    const family = await seed();
    await seed(family.sessionId);
    await seed();
    const result = await repository.listUserSessions({
      userId: userId.toHexString(),
      page: 1,
      pageSize: 1,
      status: 'ACTIVE',
    });
    expect(result?.pagination).toEqual({
      page: 1,
      pageSize: 1,
      totalItems: 2,
      totalPages: 2,
    });
    expect(Object.keys(result!.data[0]).sort()).toEqual(
      [
        'id',
        'userId',
        'context',
        'organizationId',
        'status',
        'createdAt',
        'updatedAt',
        'expiresAt',
      ].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /secret-|192\.0\.2\.1|private-device/,
    );
    const next = await repository.listUserSessions({
      userId: userId.toHexString(),
      page: 2,
      pageSize: 1,
    });
    expect(next?.data[0].id).not.toBe(result?.data[0].id);
  });

  it('classifies expired and legacy families without confusing them with active sessions', async () => {
    const legacy = new Types.ObjectId();
    await connection.collection('refresh_sessions').insertOne({
      _id: legacy,
      userId,
      context: 'ACCOUNT',
      userFence: 0,
      tokenHash: 'expired-secret',
      isRevoked: false,
      createdAt: updatedAt,
      updatedAt,
      expiresAt: new Date(now.getTime() - 1),
    });
    const result = await repository.listUserSessions({
      userId: userId.toHexString(),
      page: 1,
      pageSize: 10,
      status: 'EXPIRED',
    });
    expect(result?.data).toEqual([
      expect.objectContaining({ id: legacy.toHexString(), status: 'EXPIRED' }),
    ]);
    expect(
      await authentication.hasActiveRefreshSession(
        userId.toHexString(),
        legacy.toHexString(),
        now,
      ),
    ).toBe(false);
  });

  it('revokes every credential in one family, blocks authentication, and preserves other sessions', async () => {
    const family = await seed();
    await seed(family.sessionId);
    const sibling = await seed();
    expect(
      await authentication.hasActiveRefreshSession(
        mutation.userId,
        family.sessionId,
        now,
      ),
    ).toBe(true);
    expect(
      await repository.revokeUserSession({ ...mutation, ...family }),
    ).toMatchObject({ id: family.sessionId, status: 'REVOKED' });
    expect(
      await authentication.hasActiveRefreshSession(
        mutation.userId,
        family.sessionId,
        now,
      ),
    ).toBe(false);
    expect(
      await authentication.hasActiveRefreshSession(
        mutation.userId,
        sibling.sessionId,
        now,
      ),
    ).toBe(true);
    expect(
      await audit().countDocuments({ action: 'platform.session.revoked' }),
    ).toBe(1);
    expect(JSON.stringify(await audit().findOne())).not.toMatch(
      /secret-|192\.0\.2\.1|private-device/,
    );
  });

  it('conceals foreign sessions and leaves both users untouched', async () => {
    const foreign = await seed(randomUUID(), otherUserId);
    expect(
      await repository.findUserSession(mutation.userId, foreign.sessionId),
    ).toBeNull();
    await expect(
      repository.revokeUserSession({ ...mutation, ...foreign }),
    ).rejects.toMatchObject({ response: { code: 'SESSION_NOT_FOUND' } });
    expect(
      await authentication.hasActiveRefreshSession(
        otherUserId.toHexString(),
        foreign.sessionId,
        now,
      ),
    ).toBe(true);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back an entire bulk request when a later family has stale CAS', async () => {
    const first = await seed();
    const second = await seed();
    await expect(
      repository.revokeUserSessions({
        ...mutation,
        sessions: [first, { ...second, expectedUpdatedAt: new Date(0) }],
      }),
    ).rejects.toMatchObject({ response: { code: 'SESSION_VERSION_STALE' } });
    expect(
      await connection
        .collection('refresh_sessions')
        .countDocuments({ isRevoked: false }),
    ).toBe(2);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('rolls back revocation when the required audit insert fails', async () => {
    const family = await seed();
    const db = connection.useDb(AUDIT_DATABASE_NAME, { useCache: true }).db!;
    await db.command({
      collMod: IAM_AUDIT_COLLECTION_NAME,
      validator: { action: { $eq: 'REJECT_ALL_EVENTS' } },
    });
    try {
      await expect(
        repository.revokeUserSession({ ...mutation, ...family }),
      ).rejects.toMatchObject({
        response: { code: 'PLATFORM_SESSION_MUTATION_FAILED' },
      });
      expect(
        await authentication.hasActiveRefreshSession(
          mutation.userId,
          family.sessionId,
          now,
        ),
      ).toBe(true);
      expect(await audit().countDocuments()).toBe(0);
    } finally {
      await db.command({ collMod: IAM_AUDIT_COLLECTION_NAME, validator: {} });
    }
  });

  it('makes concurrent repeat revocations idempotent with one audit event', async () => {
    const family = await seed();
    const results = await Promise.all([
      repository.revokeUserSession({ ...mutation, ...family }),
      repository.revokeUserSession({ ...mutation, ...family }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: 'REVOKED' }),
      expect.objectContaining({ status: 'REVOKED' }),
    ]);
    expect(await audit().countDocuments()).toBe(1);
  });

  it('rechecks revoked authority inside the mutation transaction', async () => {
    const family = await seed();
    await connection
      .collection('platform_authority_assignments')
      .updateMany(
        { subjectUserId: actorId },
        { $set: { status: 'REVOKED', revokedAt: now } },
      );
    await expect(
      repository.revokeUserSession({ ...mutation, ...family }),
    ).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    expect(
      await authentication.hasActiveRefreshSession(
        mutation.userId,
        family.sessionId,
        now,
      ),
    ).toBe(true);
    expect(await audit().countDocuments()).toBe(0);
  });

  it('revokes all user sessions and fences a late credential from the previous epoch', async () => {
    await seed();
    await seed();
    const foreign = await seed(randomUUID(), otherUserId);
    expect(await repository.revokeAllUserSessions(mutation)).toBe(2);
    expect(
      await connection.collection('users').findOne({ _id: userId }),
    ).toMatchObject({ mutationFence: 1 });
    expect(
      await authentication.hasActiveRefreshSession(
        otherUserId.toHexString(),
        foreign.sessionId,
        now,
      ),
    ).toBe(true);
    const late = await seed();
    expect(
      await repository.findUserSession(mutation.userId, late.sessionId),
    ).toMatchObject({ status: 'REVOKED' });
    expect(
      await audit().countDocuments({ action: 'platform.sessions.revoked_all' }),
    ).toBe(1);
  });
});
