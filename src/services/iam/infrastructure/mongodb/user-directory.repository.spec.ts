import { Types } from 'mongoose';
import type { Connection, PipelineStage } from 'mongoose';
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
  it('lists active organization members, filters by role, paginates, and never returns credentials', async () => {
    const assignmentsForPage = chain([
      { userId: new Types.ObjectId(userId), roleCode: 'MEMBER' },
    ]);
    const aggregate = {
      allowDiskUse: jest.fn(),
      exec: jest
        .fn()
        .mockResolvedValue([{ data: [user], total: [{ count: 1 }] }]),
    };
    aggregate.allowDiskUse.mockReturnValue(aggregate);
    let pipeline: PipelineStage[] = [];
    const membershipsModel = {
      aggregate: jest.fn((stages: PipelineStage[]) => {
        pipeline = stages;
        return aggregate;
      }),
    };
    const rolesModel = {
      find: jest.fn().mockReturnValue(assignmentsForPage),
    };
    const connection = {
      models: {
        continuum_iam_role_assignments: rolesModel,
        continuum_iam_organization_memberships: membershipsModel,
      },
    } as unknown as Connection;

    const result = await new MongoUserDirectoryRepository(connection).list(
      organizationId,
      { page: 2, pageSize: 10, status: 'ACTIVE', roleCode: 'MEMBER' },
    );

    expect(pipeline[0]).toMatchObject({
      $match: {
        organizationId: new Types.ObjectId(organizationId),
        status: 'ACTIVE',
      },
    });
    expect(JSON.stringify(pipeline)).toContain('"roleCode":"MEMBER"');
    expect(pipeline).toContainEqual({ $match: { 'user.status': 'ACTIVE' } });
    expect(JSON.stringify(pipeline)).not.toContain('passwordHash');
    expect(JSON.stringify(pipeline)).toContain('"$skip":10');
    expect(aggregate.allowDiskUse).toHaveBeenCalledWith(true);
    expect(result.totalItems).toBe(1);
    expect(result.data[0]).toMatchObject({
      id: userId,
      email: user.email,
      roleCodes: ['MEMBER'],
    });
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('does not treat an organization-level role assignment as membership', async () => {
    const rolesModel = {
      find: jest
        .fn()
        .mockReturnValue(
          chain([{ userId: new Types.ObjectId(userId), roleCode: 'ADMIN' }]),
        ),
    };
    const usersModel = { findById: jest.fn() };
    const membershipsModel = { exists: jest.fn().mockResolvedValue(null) };
    const connection = {
      models: {
        continuum_iam_users: usersModel,
        continuum_iam_role_assignments: rolesModel,
        continuum_iam_organization_memberships: membershipsModel,
      },
    } as unknown as Connection;

    await expect(
      new MongoUserDirectoryRepository(connection).find(organizationId, userId),
    ).resolves.toBeNull();
    expect(usersModel.findById).not.toHaveBeenCalled();
    expect(rolesModel.find).not.toHaveBeenCalled();
  });

  it('returns an active member even without a role assignment', async () => {
    const membershipsModel = {
      exists: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    };
    const rolesModel = { find: jest.fn().mockReturnValue(chain([])) };
    const usersModel = { findById: jest.fn().mockReturnValue(chain(user)) };
    const connection = {
      models: {
        continuum_iam_users: usersModel,
        continuum_iam_role_assignments: rolesModel,
        continuum_iam_organization_memberships: membershipsModel,
      },
    } as unknown as Connection;
    const result = await new MongoUserDirectoryRepository(connection).find(
      organizationId,
      userId,
    );
    expect(result).toMatchObject({ id: userId, roleCodes: [] });
  });
});
