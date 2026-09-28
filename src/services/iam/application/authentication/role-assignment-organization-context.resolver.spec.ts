import type { AuthenticationRepositoryPort } from './authentication.repository';
import { RoleAssignmentOrganizationContextResolver } from './role-assignment-organization-context.resolver';

describe('RoleAssignmentOrganizationContextResolver', () => {
  const userId = '651a2b3c4d5e6f7a8b9c0d1e';
  const orgA = '651a2b3c4d5e6f7a8b9c0d1f';
  const orgB = '651a2b3c4d5e6f7a8b9c0d20';
  let repository: jest.Mocked<AuthenticationRepositoryPort>;
  let resolver: RoleAssignmentOrganizationContextResolver;

  beforeEach(() => {
    repository = {
      findAccountByEmail: jest.fn(),
      findOrganizationRoleAssignments: jest.fn().mockResolvedValue([]),
      findOrganizationOptions: jest
        .fn()
        .mockImplementation((ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, name: id }))),
        ),
      findProfileById: jest.fn(),
      replacePasswordHashIfCurrent: jest.fn(),
      revokeRefreshSessionByHash: jest.fn(),
    };
    resolver = new RoleAssignmentOrganizationContextResolver(repository);
  });

  it('fails closed when there is no eligible organization-level assignment', async () => {
    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'NO_ELIGIBLE_ORGANIZATION',
    });
  });

  it('selects the only organization and emits stable roles', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'MEMBER' },
      { organizationId: orgA, roleCode: 'ADMIN' },
      { organizationId: orgA, roleCode: 'MEMBER' },
    ]);

    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: ['ADMIN', 'MEMBER'] },
    });
  });

  it('requires a selector when more than one organization is eligible', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgB, roleCode: 'MEMBER' },
      { organizationId: orgA, roleCode: 'ADMIN' },
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
    expect(repository.findOrganizationOptions.mock.calls[0]).toEqual([
      [orgA, orgB],
    ]);
  });

  it('resolves an explicit eligible organization only', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'ADMIN' },
      { organizationId: orgB, roleCode: 'MEMBER' },
    ]);

    await expect(resolver.resolveForUser(userId, orgB)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgB, roles: ['MEMBER'] },
    });
    await expect(resolver.resolveForUser(userId, orgA)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: ['ADMIN'] },
    });
  });

  it('rejects a selector not present in the server-side assignments', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'ADMIN' },
    ]);

    await expect(resolver.resolveForUser(userId, orgB)).resolves.toEqual({
      outcome: 'INVALID_ORGANIZATION_SELECTION',
    });
  });

  it('does not offer or accept organizations whose documents are missing', async () => {
    repository.findOrganizationRoleAssignments.mockResolvedValue([
      { organizationId: orgA, roleCode: 'ADMIN' },
      { organizationId: orgB, roleCode: 'MEMBER' },
    ]);
    repository.findOrganizationOptions.mockResolvedValue([
      { id: orgA, name: 'Alpha' },
    ]);

    await expect(resolver.resolveForUser(userId)).resolves.toEqual({
      outcome: 'RESOLVED',
      context: { orgId: orgA, roles: ['ADMIN'] },
    });
    await expect(resolver.resolveForUser(userId, orgB)).resolves.toEqual({
      outcome: 'INVALID_ORGANIZATION_SELECTION',
    });
  });
});
