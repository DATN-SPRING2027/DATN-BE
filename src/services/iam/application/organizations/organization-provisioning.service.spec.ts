import { ConflictException } from '@nestjs/common';
import type { AuthenticatedPlatformSubject } from '../authentication/authentication.application.service';
import type { OrganizationProvisioningRepository } from './organization-provisioning.repository';
import { OrganizationProvisioningService } from './organization-provisioning.service';

const actor: AuthenticatedPlatformSubject = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'operator@example.test',
  name: 'Operator',
};

describe('OrganizationProvisioningService', () => {
  const repository: jest.Mocked<OrganizationProvisioningRepository> = {
    create: jest.fn(),
  };
  const service = new OrganizationProvisioningService(repository);

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
});
