import type { AuthenticationRepositoryPort } from './authentication.repository';
import { MembershipOrganizationContextResolver } from './membership-organization-context.resolver';

describe('MembershipOrganizationContextResolver', () => {
  const userId = '651a2b3c4d5e6f7a8b9c0d1e';
  const orgA = '651a2b3c4d5e6f7a8b9c0d1f';
  const orgB = '651a2b3c4d5e6f7a8b9c0d20';
  let repository: jest.Mocked<AuthenticationRepositoryPort>;
  let resolver: MembershipOrganizationContextResolver;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn(),
      findActiveOrganizationMembershipIds: jest.fn().mockResolvedValue([]),
      findOrganizationRoleAssignments: jest.fn().mockResolvedValue([]),
      findOrganizationOptions: jest
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, name: id }))),
        ),
      findProfileById: jest.fn(),
      replacePasswordHashIfCurrent: jest.fn(),
      revokeRefreshSessionByHash: jest.fn(),
      rotateRefreshSession: jest.fn(),
      findAccountById: jest.fn(),
      createRefreshSession: jest.fn(),
    };
    resolver = new MembershipOrganizationContextResolver(repository);
  });

  it('does not treat a role assignment as membership', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'ADMIN' },
    ]);
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
    expect(repository.findOrganizationRoleAssignments.mock.calls).toHaveLength(
      0,
    );
  });

  it('automatically selects the sole active membership and attaches its roles', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([orgA]);
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'MEMBER' },
      { organizationId: orgA, roleCode: 'ADMIN' },
      { organizationId: orgA, roleCode: 'MEMBER' },
      { organizationId: orgB, roleCode: 'ADMIN' },
    ]);
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: ['ADMIN', 'MEMBER'] },
    });
  });

  it('allows an active membership without a role assignment', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([orgA]);
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: [] },
    });
  });

  it('requires explicit selection for multiple active memberships', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([
      orgB,
      orgA,
    ]);
    repository.findOrganizationOptions.mockResolvedValue([
      { id: orgA, name: 'Alpha' },
      { id: orgB, name: 'Beta' },
    ]);
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'ORGANIZATION_SELECTION_REQUIRED',
      organizations: [
        { id: orgA, name: 'Alpha' },
        { id: orgB, name: 'Beta' },
      ],
    });
    expect(repository.findOrganizationRoleAssignments.mock.calls).toHaveLength(
      0,
    );
  });

  it('validates client selection against active membership', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([orgA]);
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgB, roleCode: 'ADMIN' },
    ]);
    await expect(resolver.resolveForUser(userId, orgB)).resolves.toEqual({
      outcome: 'INVALID_ORGANIZATION_SELECTION',
    });
    expect(repository.findOrganizationRoleAssignments.mock.calls).toHaveLength(
      0,
    );
  });

  it('excludes a missing organization document', async () => {
    repository.findActiveOrganizationMembershipIds.mockResolvedValue([
      orgA,
      orgB,
    ]);
    repository.findOrganizationOptions.mockResolvedValue([
      { id: orgA, name: 'Alpha' },
    ]);
    await expect(resolver.resolveForUser(userId, orgB)).resolves.toEqual({
      outcome: 'INVALID_ORGANIZATION_SELECTION',
    });
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: [] },
    });
  });
});
