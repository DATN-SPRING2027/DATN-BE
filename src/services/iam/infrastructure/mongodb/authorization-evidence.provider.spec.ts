import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { MongoAuthorizationEvidenceProvider } from './authorization-evidence.provider';

const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const orgId = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function query<T>(value: T) {
  const result = { lean: jest.fn(), exec: jest.fn().mockResolvedValue(value) };
  result.lean.mockReturnValue(result);
  return result;
}

describe('MongoAuthorizationEvidenceProvider for project.create', () => {
  it('loads only ACTIVE Organization Membership evidence', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(
        query({
          userId: new Types.ObjectId(userId),
          organizationId: new Types.ObjectId(orgId),
          status: 'ACTIVE',
        }),
      ),
    };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
      },
    } as unknown as Connection;

    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);

    expect(evidence).toEqual({
      membership: { userId, organizationId: orgId, status: 'ACTIVE' },
      explicitDeny: 'CLEAR',
    });
    expect(memberships.findOne).toHaveBeenCalledWith(
      {
        userId: new Types.ObjectId(userId),
        organizationId: new Types.ObjectId(orgId),
        status: 'ACTIVE',
      },
      { userId: 1, organizationId: 1, status: 1 },
    );
  });

  it('returns no eligible membership when the ACTIVE membership lookup misses', async () => {
    const memberships = {
      findOne: jest.fn().mockReturnValue(query(null)),
    };
    const connection = {
      models: {
        continuum_iam_organization_memberships: memberships,
      },
    } as unknown as Connection;

    const evidence = await new MongoAuthorizationEvidenceProvider(
      connection,
    ).loadProjectCreate(userId, orgId);

    expect(evidence).toEqual({ membership: null, explicitDeny: 'CLEAR' });
  });

  it('rejects malformed identifiers before querying persistence', async () => {
    const connection = { models: {} } as unknown as Connection;
    const provider = new MongoAuthorizationEvidenceProvider(connection);

    await expect(provider.loadProjectCreate('invalid', orgId)).resolves.toBe(
      null,
    );
    await expect(provider.loadProjectCreate(userId, 'invalid')).resolves.toBe(
      null,
    );
  });
});
