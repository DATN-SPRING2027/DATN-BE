import { ConflictException } from '@nestjs/common';
import type { AuthenticatedPlatformSubject } from '../authentication/authentication.application.service';
import type { OrganizationProvisioningRepository } from './organization-provisioning.repository';
import { OrganizationProvisioningService } from './organization-provisioning.service';
import type { AuthSecurityStore } from '../authentication/auth-security.store';

const actor: AuthenticatedPlatformSubject = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'operator@example.test',
  name: 'Operator',
};

describe('OrganizationProvisioningService', () => {
  const repository: jest.Mocked<OrganizationProvisioningRepository> = {
    create: jest.fn(),
  };
  const security = {
    consumeRateLimit: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<AuthSecurityStore>;
  const service = new OrganizationProvisioningService(repository, security);

  beforeEach(() => jest.clearAllMocks());

  it('does not make the Platform Operator the first Organization ADMIN', () => {
    for (const firstAdminUserId of [actor.id, actor.id.toUpperCase()]) {
      expect(() =>
        service.create(actor, {
          name: 'New Organization',
          slug: 'new-organization',
          plan: 'FREE',
          firstAdminUserId,
        }),
      ).toThrow(ConflictException);
    }
    expect(repository.create.mock.calls).toHaveLength(0);
  });

  it('delegates bootstrap only for a separate first ADMIN user', async () => {
    const firstAdminUserId = 'cccccccccccccccccccccccc';
    const input = {
      name: 'New Organization',
      slug: 'new-organization',
      plan: 'FREE' as const,
      firstAdminUserId,
    };
    repository.create.mockResolvedValue({
      id: 'dddddddddddddddddddddddd',
      name: input.name,
      slug: input.slug,
      plan: input.plan,
      createdAt: '2026-10-05T12:00:00.000Z',
      updatedAt: '2026-10-05T12:00:00.000Z',
    });

    await service.create(actor, input);

    expect(repository.create.mock.calls).toEqual([[actor.id, input]]);
  });

  it('allows an authenticated account to bootstrap only itself on the FREE plan', async () => {
    await service.createSelfService(actor, {
      name: 'My Organization',
      slug: 'my-organization',
    });
    expect(repository.create).toHaveBeenCalledWith(actor.id, {
      name: 'My Organization',
      slug: 'my-organization',
      plan: 'FREE',
      firstAdminUserId: actor.id,
    });
    expect(security.consumeRateLimit).toHaveBeenCalledWith(
      `organization:create:${actor.id}`,
      3,
      3600,
    );
  });
});
