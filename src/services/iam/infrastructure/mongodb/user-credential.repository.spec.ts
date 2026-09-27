import type { Connection } from 'mongoose';
import { UserCredentialRepository } from './user-credential.repository';

describe('UserCredentialRepository', () => {
  it('looks up only the credential fields using the existing users model', async () => {
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => 'user-123' },
        passwordHash: '$argon2id$fixture',
      }),
    };
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;
    const repository = new UserCredentialRepository(connection);

    await expect(
      repository.findByEmail('  PERSON@EXAMPLE.COM '),
    ).resolves.toEqual({
      userId: 'user-123',
      passwordHash: '$argon2id$fixture',
    });
    expect(model.findOne).toHaveBeenCalledWith(
      { email: 'person@example.com' },
      { _id: 1, passwordHash: 1 },
    );
    expect(query.lean).toHaveBeenCalledTimes(1);
  });

  it('returns null when the user does not exist', async () => {
    const query = {
      lean: jest.fn(),
      exec: jest.fn().mockResolvedValue(null),
    };
    query.lean.mockReturnValue(query);
    const model = { findOne: jest.fn().mockReturnValue(query) };
    const connection = {
      models: { continuum_iam_users: model },
    } as unknown as Connection;

    await expect(
      new UserCredentialRepository(connection).findByEmail(
        'nobody@example.com',
      ),
    ).resolves.toBeNull();
  });

  it('fails explicitly when MongoDB or the WP-01 users model is unavailable', async () => {
    await expect(
      new UserCredentialRepository().findByEmail('user@example.com'),
    ).rejects.toThrow('CONNECTION_UNAVAILABLE');

    const connection = { models: {} } as unknown as Connection;
    await expect(
      new UserCredentialRepository(connection).findByEmail('user@example.com'),
    ).rejects.toThrow('USER_MODEL_UNAVAILABLE');
  });
});
