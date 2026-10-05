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

      await create('old');
      await expect(
        repository.rotateRefreshSession('old', 'new', expiresAt, now),
      ).resolves.toEqual({
        outcome: 'ROTATED',
        userId: String(userId),
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
