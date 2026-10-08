import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { AuthenticationRepository } from './authentication.repository';
import { createCollectionSchema } from './mongodb.schemas';
import { IAM_PERSISTENCE } from '../persistence';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration('refresh session rotation on MongoDB replica set', () => {
  it('commits rotation and replay invalidation, enforces expiry, and rolls back a failed insert', async () => {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    const databaseName = `refresh_it_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const connection = mongoose.createConnection(process.env.MONGODB_URI, {
      dbName: databaseName,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    });
    let createdDatabase = false;
    try {
      await connection.asPromise();
      const db = connection.db;
      if (!db || db.databaseName !== databaseName)
        throw new Error('Wrong integration database');
      createdDatabase = true;
      const definition = IAM_PERSISTENCE.collections.find(
        (item) => item.name === 'refresh_sessions',
      );
      if (!definition) throw new Error('Refresh schema missing');
      await db.createCollection('refresh_sessions');
      const model = connection.model(
        'continuum_iam_refresh_sessions',
        createCollectionSchema(definition),
      );
      await model.createIndexes();
      const repository = new AuthenticationRepository(connection);
      const userId = new Types.ObjectId();
      const organizationId = new Types.ObjectId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const create = (hash: string, expiry = expiresAt, revoked = false) =>
        model.create({
          userId,
          organizationId,
          tokenHash: hash,
          expiresAt: expiry,
          isRevoked: revoked,
        });

      const initialHash = 'a'.repeat(64);
      await repository.createRefreshSession({
        userId: String(userId),
        context: 'ORGANIZATION',
        organizationId: String(organizationId),
        tokenHash: initialHash,
        expiresAt,
      });
      const initialRow = await model.findOne({ tokenHash: initialHash }).lean();
      expect(initialRow?.tokenHash).toBe(initialHash);

      await create('old');
      await expect(
        repository.rotateRefreshSession('old', 'new', expiresAt, now),
      ).resolves.toEqual({
        outcome: 'ROTATED',
        userId: String(userId),
        context: 'ORGANIZATION',
        organizationId: String(organizationId),
      });
      expect(
        (await model.findOne({ tokenHash: 'old' }).lean())?.isRevoked,
      ).toBe(true);
      expect(
        (await model.findOne({ tokenHash: 'new' }).lean())?.isRevoked,
      ).toBe(false);
      await create('other');
      const otherUserId = new Types.ObjectId();
      await model.create({
        userId: otherUserId,
        organizationId,
        tokenHash: 'other-user',
        expiresAt,
        isRevoked: false,
      });
      await expect(
        repository.rotateRefreshSession('old', 'never-issued', expiresAt, now),
      ).resolves.toEqual({ outcome: 'REPLAYED' });
      expect(await model.countDocuments({ userId, isRevoked: false })).toBe(0);
      expect(
        await model.countDocuments({ userId: otherUserId, isRevoked: false }),
      ).toBe(1);
      expect(await model.countDocuments({ tokenHash: 'never-issued' })).toBe(0);

      await repository.createRefreshSession({
        userId: String(userId),
        context: 'PLATFORM',
        tokenHash: 'platform-initial',
        expiresAt,
      });
      const platformSession = await model
        .findOne({ tokenHash: 'platform-initial' })
        .lean();
      expect(platformSession?.context).toBe('PLATFORM');
      expect(platformSession).not.toHaveProperty('organizationId');
      await expect(
        repository.findRefreshSessionForRotation('platform-initial'),
      ).resolves.toEqual({
        outcome: 'ACTIVE',
        userId: String(userId),
        context: 'PLATFORM',
        expiresAt,
      });
      await expect(
        repository.rotateRefreshSession(
          'platform-initial',
          'platform-replacement',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({
        outcome: 'ROTATED',
        userId: String(userId),
        context: 'PLATFORM',
      });
      const platformReplacement = await model
        .findOne({ tokenHash: 'platform-replacement' })
        .lean();
      expect(platformReplacement?.context).toBe('PLATFORM');
      expect(platformReplacement).not.toHaveProperty('organizationId');
      await create('org-active-after-platform-rotation');
      await repository.revokeRefreshSessionByHash('platform-replacement');
      await expect(
        repository.rotateRefreshSession(
          'platform-replacement',
          'platform-replay-not-issued',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({ outcome: 'REPLAYED' });
      expect(await model.countDocuments({ userId, isRevoked: false })).toBe(0);
      expect(
        await model.countDocuments({ tokenHash: 'platform-replay-not-issued' }),
      ).toBe(0);

      const logoutHash = 'logout-refresh';
      await create(logoutHash);
      await expect(
        repository.findRefreshSessionForRotation(logoutHash),
      ).resolves.toMatchObject({
        outcome: 'ACTIVE',
        userId: String(userId),
        organizationId: String(organizationId),
      });
      await expect(
        repository.revokeRefreshSessionByHash(logoutHash),
      ).resolves.toBe(true);
      await expect(
        repository.findRefreshSessionForRotation(logoutHash),
      ).resolves.toMatchObject({ outcome: 'REVOKED' });
      await expect(
        repository.rotateRefreshSession(
          logoutHash,
          'logout-replacement',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({ outcome: 'REPLAYED' });
      expect(
        await model.countDocuments({ tokenHash: 'logout-replacement' }),
      ).toBe(0);

      await create('expired', new Date(now.getTime() - 1000));
      await expect(
        repository.rotateRefreshSession(
          'expired',
          'not-issued',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({ outcome: 'INVALID' });
      expect(await model.countDocuments({ tokenHash: 'not-issued' })).toBe(0);
      await expect(
        repository.rotateRefreshSession(
          'unknown',
          'not-issued',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({ outcome: 'INVALID' });

      await db.collection('refresh_sessions').insertOne({
        userId,
        organizationId,
        tokenHash: 'legacy-missing-revocation',
        expiresAt,
      });
      await expect(
        repository.rotateRefreshSession(
          'legacy-missing-revocation',
          'legacy-replacement',
          expiresAt,
          now,
        ),
      ).resolves.toEqual({ outcome: 'INVALID' });
      expect(
        await model.countDocuments({ tokenHash: 'legacy-replacement' }),
      ).toBe(0);

      await create('rollback');
      await expect(
        repository.rotateRefreshSession('rollback', 'old', expiresAt, now),
      ).rejects.toThrow();
      expect(
        (await model.findOne({ tokenHash: 'rollback' }).lean())?.isRevoked,
      ).toBe(false);
      expect(await model.countDocuments({ tokenHash: 'old' })).toBe(1);
    } finally {
      if (createdDatabase && connection.db?.databaseName === databaseName) {
        await connection.dropDatabase();
      }
      await connection.close();
    }
  });
});
