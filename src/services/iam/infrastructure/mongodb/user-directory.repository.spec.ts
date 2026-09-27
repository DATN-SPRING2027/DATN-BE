import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoUserDirectoryRepository } from './user-directory.repository';

const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const userId = '651a2b3c4d5e6f7a8b9c0d20';
const user = {
  _id: new Types.ObjectId(userId),
  email: 'member@example.com',
  fullName: 'Member',
  status: 'ACTIVE',
  passwordHash: 'must-not-leak',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

function chain(result: unknown) {
  const query = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(result),
  };
  query.sort.mockReturnValue(query);
  query.skip.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return query;
}

describe('MongoUserDirectoryRepository', () => {
  it('lists only assigned organization users, paginates, and never returns credentials', async () => {
    const assignmentsForScope = chain([{ userId: new Types.ObjectId(userId) }]);
    const assignmentsForPage = chain([
      { userId: new Types.ObjectId(userId), roleCode: 'MEMBER' },
    ]);
    const usersForPage = chain([user]);
    const rolesModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(assignmentsForScope)
        .mockReturnValueOnce(assignmentsForPage),
    };
    const usersModel = {
      countDocuments: jest.fn().mockReturnValue(chain(1)),
      find: jest.fn().mockReturnValue(usersForPage),
    };
    const connection = {
      models: {
        continuum_iam_users: usersModel,
        continuum_iam_role_assignments: rolesModel,
      },
    } as unknown as Connection;

    const result = await new MongoUserDirectoryRepository(connection).list(
      organizationId,
      { page: 2, pageSize: 10, status: 'ACTIVE' },
    );

    const roleFindCalls = rolesModel.find.mock.calls as unknown as Array<
      [unknown, unknown?]
    >;
    const userFindCalls = usersModel.find.mock.calls as unknown as Array<
      [unknown, unknown?]
    >;
    expect(roleFindCalls[0][0]).toMatchObject({
      organizationId: new Types.ObjectId(organizationId),
    });
    expect(userFindCalls[0][0]).toMatchObject({
      _id: { $in: [new Types.ObjectId(userId)] },
      status: 'ACTIVE',
    });
    expect(userFindCalls[0][1]).not.toHaveProperty('passwordHash');
    expect(usersForPage.skip).toHaveBeenCalledWith(10);
    expect(usersForPage.limit).toHaveBeenCalledWith(10);
    expect(result.totalItems).toBe(1);
    expect(result.data[0]).toMatchObject({
      id: userId,
      email: user.email,
      roleCodes: ['MEMBER'],
    });
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('does not read a user without an organization-level assignment', async () => {
    const rolesModel = { find: jest.fn().mockReturnValue(chain([])) };
    const usersModel = { findById: jest.fn() };
    const connection = {
      models: {
        continuum_iam_users: usersModel,
        continuum_iam_role_assignments: rolesModel,
      },
    } as unknown as Connection;

    await expect(
      new MongoUserDirectoryRepository(connection).find(organizationId, userId),
    ).resolves.toBeNull();
    expect(usersModel.findById).not.toHaveBeenCalled();
  });
});
