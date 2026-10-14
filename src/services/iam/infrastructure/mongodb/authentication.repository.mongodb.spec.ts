import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import type { Db } from 'mongodb';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';
import { AuthenticationRepository } from './authentication.repository';

const integration =
  process.env.MONGODB_INTEGRATION === 'true' ? describe : describe.skip;

integration(
  'AuthenticationRepository password reset on MongoDB replica set',
  () => {
    let connection: Connection | undefined;
    let database: Db | undefined;
    const userId = new Types.ObjectId();
    const repository = () => {
      if (!connection) throw new Error('MongoDB connection unavailable');
      return new AuthenticationRepository(connection);
    };

    beforeAll(async () => {
      const uri = process.env.MONGODB_URI;
      if (!uri) throw new Error('MONGODB_URI is required');

      connection = mongoose.createConnection(uri, {
        dbName: `auth_reset_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        autoIndex: false,
        serverSelectionTimeoutMS: 5000,
      });
      await connection.asPromise();
      database = connection.db;
      if (!database) throw new Error('MongoDB database unavailable');

      for (const collectionName of ['users', 'refresh_sessions']) {
        await database.createCollection(collectionName);
        const definition = IAM_PERSISTENCE.collections.find(
          (entry) => entry.name === collectionName,
        );
        if (!definition) throw new Error(`${collectionName} schema missing`);
        const model = connection.model(
          `${IAM_PERSISTENCE.databaseName}_${collectionName}`,
          createCollectionSchema(definition),
        );
        await model.createIndexes();
      }
    });

    beforeEach(async () => {
      if (!database) throw new Error('MongoDB database unavailable');
      await database.collection('users').deleteMany({});
      await database.collection('refresh_sessions').deleteMany({});
      await database.collection('users').insertOne({
        _id: userId,
        email: 'password-reset@example.test',
        fullName: 'Password Reset',
        status: 'ACTIVE',
        passwordHash: 'old-hash',
      });
      await database.collection('refresh_sessions').insertMany([
        {
          userId,
          tokenHash: randomUUID(),
          isRevoked: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          userId,
          tokenHash: randomUUID(),
          isRevoked: false,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]);
    });

    afterAll(async () => {
      if (database) await database.dropDatabase();
      await connection?.close();
    });

    it('updates the ACTIVE password and revokes every refresh session together', async () => {
      if (!database) throw new Error('MongoDB database unavailable');

      await expect(
        repository().resetPassword(String(userId), 'new-hash'),
      ).resolves.toBe(true);

      const user = await database.collection('users').findOne({ _id: userId });
      const sessions = await database
        .collection('refresh_sessions')
        .find({ userId })
        .toArray();
      expect(user?.passwordHash).toBe('new-hash');
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.isRevoked === true)).toBe(
        true,
      );
    });

    it('rolls back the password update if refresh-session revocation fails', async () => {
      if (!database) throw new Error('MongoDB database unavailable');
      await database.command({
        collMod: 'refresh_sessions',
        validator: { isRevoked: false },
        validationLevel: 'strict',
      });

      await expect(
        repository().resetPassword(String(userId), 'new-hash'),
      ).rejects.toThrow();

      const user = await database.collection('users').findOne({ _id: userId });
      const sessions = await database
        .collection('refresh_sessions')
        .find({ userId })
        .toArray();
      expect(user?.passwordHash).toBe('old-hash');
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => session.isRevoked === false)).toBe(
        true,
      );
    });
  },
);
