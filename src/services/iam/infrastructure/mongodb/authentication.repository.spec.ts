/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Mongoose query doubles expose driver any types. */
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { AuthenticationRepository } from './authentication.repository';

describe('AuthenticationRepository', () => {
  it('changes an ACTIVE password and revokes all refresh sessions in one transaction', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const session = {
      withTransaction: jest.fn(async (callback: () => Promise<boolean>) =>
        callback(),
      ),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const userUpdate = { matchedCount: 1, modifiedCount: 1 };
    const sessionUpdate = { matchedCount: 2, modifiedCount: 2 };
    const users = {
      updateOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(userUpdate) }),
    };
    const sessions = {
      updateMany: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(sessionUpdate) }),
    };
    const connection = {
      models: {
        continuum_iam_users: users,
        continuum_iam_refresh_sessions: sessions,
      },
      startSession: jest.fn().mockResolvedValue(session),
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).resetPassword(
        userId,
        'new-hash',
      ),
    ).resolves.toBe(true);
    expect(users.updateOne).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(userId), status: 'ACTIVE' },
      {
        $set: { passwordHash: 'new-hash' },
        $inc: { mutationFence: 1 },
      },
      { session },
    );
    expect(sessions.updateMany).toHaveBeenCalledWith(
      { userId: new Types.ObjectId(userId), isRevoked: { $ne: true } },
      { $set: { isRevoked: true } },
      { session },
    );
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  it('looks up only complete refresh-session fields before rotation', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
    const sessionId = '7b4e98c4-4a2d-4e36-9d69-4c42b8a093f1';
    const expiresAt = new Date(Date.now() + 60_000);
    const query = {
      select: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(userId),
        sessionId,
        organizationId: new Types.ObjectId(organizationId),
        isRevoked: false,
        expiresAt,
      }),
    };
    query.select.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_refresh_sessions: model },
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);

    await expect(
      repository.findRefreshSessionForRotation('sha256-digest'),
    ).resolves.toEqual({
      outcome: 'ACTIVE',
      userId,
      sessionId,
      userFence: 0,
      context: 'ORGANIZATION',
      organizationId,
      expiresAt,
    });
    expect(model.findOne).toHaveBeenCalledWith({ tokenHash: 'sha256-digest' });
    expect(query.select).toHaveBeenCalledWith({
      _id: 1,
      userId: 1,
      sessionId: 1,
      userFence: 1,
      organizationId: 1,
      context: 1,
      isRevoked: 1,
      expiresAt: 1,
    });
  });

  it('looks up Platform refresh sessions without requiring an Organization ID', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const sessionId = '7b4e98c4-4a2d-4e36-9d69-4c42b8a093f1';
    const expiresAt = new Date(Date.now() + 60_000);
    const query = {
      select: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(userId),
        sessionId,
        context: 'PLATFORM',
        isRevoked: false,
        expiresAt,
      }),
    };
    query.select.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_refresh_sessions: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).findRefreshSessionForRotation(
        'platform-session-hash',
      ),
    ).resolves.toEqual({
      outcome: 'ACTIVE',
      userId,
      sessionId,
      userFence: 0,
      context: 'PLATFORM',
      expiresAt,
    });
  });

  it('looks up Account refresh sessions without requiring an Organization ID', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const sessionId = '7b4e98c4-4a2d-4e36-9d69-4c42b8a093f1';
    const expiresAt = new Date(Date.now() + 60_000);
    const query = {
      select: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(userId),
        sessionId,
        context: 'ACCOUNT',
        isRevoked: false,
        expiresAt,
      }),
    };
    query.select.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const connection = {
      models: {
        continuum_iam_refresh_sessions: {
          findOne: jest.fn().mockReturnValue(query),
        },
      },
    } as unknown as Connection;
    await expect(
      new AuthenticationRepository(connection).findRefreshSessionForRotation(
        'account-hash',
      ),
    ).resolves.toEqual({
      outcome: 'ACTIVE',
      userId,
      sessionId,
      userFence: 0,
      context: 'ACCOUNT',
      expiresAt,
    });
  });

  it('loads only the account fields needed after a committed refresh rotation', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        email: 'person@example.com',
        status: 'ACTIVE',
        twoFactorEnabled: false,
      }),
    };
    query.lean.mockReturnValue(query);
    const model = { findById: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;
    await expect(
      new AuthenticationRepository(connection).findAccountById(userId),
    ).resolves.toEqual({
      email: 'person@example.com',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
    expect(model.findById).toHaveBeenCalledWith(new Types.ObjectId(userId), {
      email: 1,
      status: 1,
      twoFactorEnabled: 1,
    });
  });

  it('loads only ACTIVE organization memberships', async () => {
    const userId = '651a2b3c4d5e6f7a8b9c0d1e';
    const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
    const query = {
      sort: jest.fn(),
      lean: jest.fn(),
      exec: jest
        .fn()
        .mockResolvedValue([
          { organizationId: new Types.ObjectId(organizationId) },
        ]),
    };
    query.sort.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const model = { find: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_organization_memberships: model },
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);
    await expect(
      repository.findActiveOrganizationMembershipIds(userId),
    ).resolves.toEqual([organizationId]);
    expect(model.find).toHaveBeenCalledWith(
      { userId: new Types.ObjectId(userId), status: 'ACTIVE' },
      { organizationId: 1, _id: 0 },
    );
    expect(query.sort).toHaveBeenCalledWith({ organizationId: 1 });
  });

  it('loads credential, status and profile fields from the existing user model', async () => {
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => '651a2b3c4d5e6f7a8b9c0d1e' },
        email: 'person@example.com',
        fullName: 'Test Person',
        passwordHash: '$argon2id$phc',
        status: 'ACTIVE',
        twoFactorEnabled: false,
      }),
    };
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);

    await expect(
      repository.findAccountByEmail(' PERSON@EXAMPLE.COM '),
    ).resolves.toEqual({
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      email: 'person@example.com',
      name: 'Test Person',
      passwordHash: '$argon2id$phc',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
    expect(model.findOne).toHaveBeenCalledWith(
      { email: 'person@example.com' },
      {
        _id: 1,
        email: 1,
        fullName: 1,
        passwordHash: 1,
        googleSubject: 1,
        status: 1,
        twoFactorEnabled: 1,
      },
    );
  });

  it('queries only organization-level role assignments and projects a stable subset', async () => {
    const query = {
      sort: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        {
          organizationId: { toString: () => '651a2b3c4d5e6f7a8b9c0d1f' },
          roleCode: 'ADMIN',
        },
      ]),
    };
    query.sort.mockReturnValue(query);
    query.lean.mockReturnValue(query);
    const model = { find: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_role_assignments: model },
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);

    await expect(
      repository.findOrganizationRoleAssignments('651a2b3c4d5e6f7a8b9c0d1e'),
    ).resolves.toEqual([
      { organizationId: '651a2b3c4d5e6f7a8b9c0d1f', roleCode: 'ADMIN' },
    ]);
    expect(model.find).toHaveBeenCalledWith(
      {
        userId: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
        $or: [{ projectId: { $exists: false } }, { projectId: null }],
      },
      { organizationId: 1, roleCode: 1, _id: 0 },
    );
    expect(query.sort).toHaveBeenCalledWith({ organizationId: 1, roleCode: 1 });
  });

  it('does not query project assignments when the subject is not an ObjectId', async () => {
    const model = { find: jest.fn() };
    const connection = {
      models: { continuum_iam_role_assignments: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).findOrganizationRoleAssignments(
        'not-an-id',
      ),
    ).resolves.toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });

  it('loads names only for verified organization assignments', async () => {
    const orgA = '651a2b3c4d5e6f7a8b9c0d1f';
    const orgB = '651a2b3c4d5e6f7a8b9c0d20';
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        { _id: new Types.ObjectId(orgB), name: 'Beta' },
        { _id: new Types.ObjectId(orgA), name: 'Alpha' },
      ]),
    };
    query.lean.mockReturnValue(query);
    const model = { find: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_organizations: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).findOrganizationOptions([
        orgA,
        orgB,
      ]),
    ).resolves.toEqual([
      { id: orgA, name: 'Alpha' },
      { id: orgB, name: 'Beta' },
    ]);
    expect(model.find).toHaveBeenCalledWith(
      { _id: { $in: [new Types.ObjectId(orgA), new Types.ObjectId(orgB)] } },
      { _id: 1, name: 1 },
    );
  });

  it('replaces a verified legacy hash only if it is still current', async () => {
    const updateQuery = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const userModel = { updateOne: jest.fn().mockReturnValue(updateQuery) };
    const connection = {
      models: { continuum_iam_users: userModel },
    } as unknown as Connection;

    await new AuthenticationRepository(connection).replacePasswordHashIfCurrent(
      '651a2b3c4d5e6f7a8b9c0d1e',
      '$argon2id$legacy',
      '$2b$12$replacement',
    );

    expect(userModel.updateOne).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
        passwordHash: '$argon2id$legacy',
      },
      { $set: { passwordHash: '$2b$12$replacement' } },
    );
  });

  it('loads the mutation fence and revokes by token hash', async () => {
    const profileQuery = {
      lean: jest.fn(),
      exec: jest
        .fn()
        .mockResolvedValue({ fullName: 'Test Person', status: 'ACTIVE' }),
    };
    profileQuery.lean.mockReturnValue(profileQuery);
    const sessionId = '7b4e98c4-4a2d-4e36-9d69-4c42b8a093f1';
    const sessionRow = {
      _id: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d22'),
      userId: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
      sessionId,
      isRevoked: false,
    };
    const lookup = {
      session: jest.fn(),
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue(sessionRow),
    };
    lookup.session.mockReturnValue(lookup);
    lookup.lean.mockReturnValue(lookup);
    const updateQuery = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    };
    const userModel = { findById: jest.fn().mockReturnValue(profileQuery) };
    const sessionsModel = {
      findOne: jest.fn().mockReturnValue(lookup),
      updateMany: jest.fn().mockReturnValue(updateQuery),
    };
    const transaction = {
      withTransaction: jest.fn(async (callback: () => Promise<boolean>) =>
        callback(),
      ),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    const connection = {
      models: {
        continuum_iam_users: userModel,
        continuum_iam_refresh_sessions: sessionsModel,
      },
      startSession: jest.fn().mockResolvedValue(transaction),
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);

    await expect(
      repository.findProfileById('651a2b3c4d5e6f7a8b9c0d1e'),
    ).resolves.toEqual({
      name: 'Test Person',
      status: 'ACTIVE',
      mutationFence: 0,
    });
    expect(userModel.findById).toHaveBeenCalledWith(
      new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
      { fullName: 1, status: 1, mutationFence: 1 },
    );
    await expect(
      repository.revokeRefreshSessionByHash('sha256-digest'),
    ).resolves.toBe(true);
    expect(sessionsModel.updateMany).toHaveBeenCalledWith(
      {
        userId: sessionRow.userId,
        $or: [{ sessionId }],
        isRevoked: { $ne: true },
      },
      { $set: { isRevoked: true, updatedAt: expect.any(Date) } },
      { session: transaction, timestamps: false },
    );
    expect(transaction.withTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.endSession).toHaveBeenCalledTimes(1);
  });

  it('finds a passwordless account by its stable Google subject', async () => {
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
        email: 'person@example.com',
        fullName: 'Google Person',
        googleSubject: 'google-subject-123',
        status: 'ACTIVE',
        twoFactorEnabled: false,
      }),
    };
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).findAccountByGoogleSubject(
        'google-subject-123',
      ),
    ).resolves.toEqual({
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      email: 'person@example.com',
      name: 'Google Person',
      passwordHash: '',
      googleSubject: 'google-subject-123',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
    expect(model.findOne).toHaveBeenCalledWith(
      { googleSubject: 'google-subject-123' },
      expect.objectContaining({ googleSubject: 1 }),
    );
  });

  it('links a Google subject only when the existing account has no subject', async () => {
    const query = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const model = { updateOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).linkGoogleSubjectIfMissing(
        '651a2b3c4d5e6f7a8b9c0d1e',
        'google-subject-123',
      ),
    ).resolves.toBe(true);
    expect(model.updateOne).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
        $or: [{ googleSubject: { $exists: false } }, { googleSubject: null }],
      },
      { $set: { googleSubject: 'google-subject-123' } },
    );
  });

  it('creates a Google account without persisting a password hash', async () => {
    const created = {
      toObject: () => ({
        _id: new Types.ObjectId('651a2b3c4d5e6f7a8b9c0d1e'),
        email: 'person@example.com',
        fullName: 'Google Person',
        googleSubject: 'google-subject-123',
        status: 'ACTIVE',
        twoFactorEnabled: false,
      }),
    };
    const model = { create: jest.fn().mockResolvedValue(created) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;

    await expect(
      new AuthenticationRepository(connection).createGoogleAccount({
        email: 'person@example.com',
        name: 'Google Person',
        googleSubject: 'google-subject-123',
      }),
    ).resolves.toMatchObject({
      userId: '651a2b3c4d5e6f7a8b9c0d1e',
      googleSubject: 'google-subject-123',
      passwordHash: '',
    });
    expect(model.create).toHaveBeenCalledWith({
      email: 'person@example.com',
      fullName: 'Google Person',
      googleSubject: 'google-subject-123',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });
  });
});
