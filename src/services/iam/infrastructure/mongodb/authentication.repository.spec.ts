import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { AuthenticationRepository } from './authentication.repository';

describe('AuthenticationRepository', () => {
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

  it('looks up only the profile name and revokes by token hash without new session fields', async () => {
    const profileQuery = {
      lean: jest.fn(),
      exec: jest
        .fn()
        .mockResolvedValue({ fullName: 'Test Person', status: 'ACTIVE' }),
    };
    profileQuery.lean.mockReturnValue(profileQuery);
    const updateQuery = {
      exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const userModel = { findById: jest.fn().mockReturnValue(profileQuery) };
    const sessionsModel = { updateOne: jest.fn().mockReturnValue(updateQuery) };
    const connection = {
      models: {
        continuum_iam_users: userModel,
        continuum_iam_refresh_sessions: sessionsModel,
      },
    } as unknown as Connection;
    const repository = new AuthenticationRepository(connection);

    await expect(
      repository.findProfileById('651a2b3c4d5e6f7a8b9c0d1e'),
    ).resolves.toEqual({ name: 'Test Person', status: 'ACTIVE' });
    await expect(
      repository.revokeRefreshSessionByHash('sha256-digest'),
    ).resolves.toBe(true);
    expect(sessionsModel.updateOne).toHaveBeenCalledWith(
      { tokenHash: 'sha256-digest', isRevoked: { $ne: true } },
      { $set: { isRevoked: true } },
    );
  });
});
