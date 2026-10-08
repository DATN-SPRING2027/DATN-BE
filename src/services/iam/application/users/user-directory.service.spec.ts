import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UserDirectoryService } from './user-directory.service';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import type { UserDirectoryRepository } from './user-directory.repository';

const actor: AuthenticatedIdentity = {
  id: '651a2b3c4d5e6f7a8b9c0d1e',
  email: 'admin@example.com',
  name: 'Admin',
  organizationId: '651a2b3c4d5e6f7a8b9c0d1f',
  roles: ['ADMIN'],
};
const user = {
  id: '651a2b3c4d5e6f7a8b9c0d20',
  email: 'member@example.com',
  fullName: 'Member',
  avatarUrl: null,
  status: 'ACTIVE' as const,
  roleCodes: ['MEMBER'],
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('UserDirectoryService', () => {
  let repository: jest.Mocked<UserDirectoryRepository>;
  let service: UserDirectoryService;

  beforeEach(() => {
    repository = {
      isAdmin: jest.fn().mockResolvedValue(true),
      list: jest.fn().mockResolvedValue({ data: [user], totalItems: 1 }),
      find: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({ ...user, fullName: 'Renamed' }),
      countActiveAdmins: jest.fn().mockResolvedValue(2),
    };
    service = new UserDirectoryService(repository);
  });

  it('lists only the selected organization scope with contract pagination', async () => {
    await expect(
      service.list(actor, { page: 2, pageSize: 20 }),
    ).resolves.toEqual({
      data: [user],
      pagination: { page: 2, pageSize: 20, totalItems: 1, totalPages: 1 },
    });
    expect(repository.list.mock.calls).toEqual([
      [actor.organizationId, { page: 2, pageSize: 20 }],
    ]);
  });

  it('rejects a non-admin directory read even if token role claims say ADMIN', async () => {
    repository.isAdmin.mockResolvedValue(false);
    await expect(
      service.list(actor, { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.list.mock.calls).toHaveLength(0);
  });

  it('does not let Platform Operator display state manage Organization users', async () => {
    const platformOperator = { ...actor, roles: ['PLATFORM_OPERATOR'] };
    repository.isAdmin.mockResolvedValue(false);

    await expect(
      service.list(platformOperator, { page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.update(platformOperator, user.id, { status: 'SUSPENDED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.list.mock.calls).toHaveLength(0);
    expect(repository.update.mock.calls).toHaveLength(0);
  });

  it('allows self profile changes but rejects self status changes', async () => {
    repository.isAdmin.mockResolvedValue(false);
    repository.find.mockResolvedValue({ ...user, id: actor.id });
    await service.update(actor, actor.id, { fullName: 'Renamed' });
    expect(repository.update.mock.calls).toEqual([
      [actor.organizationId, actor.id, { fullName: 'Renamed' }],
    ]);
    await expect(
      service.update(actor, actor.id, { status: 'SUSPENDED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not expose a user outside the actor organization', async () => {
    repository.find.mockResolvedValue(null);
    await expect(service.get(actor, user.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(actor, user.id, { fullName: 'No' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('prevents suspending the final active organization admin', async () => {
    repository.find.mockResolvedValue({ ...user, roleCodes: ['ADMIN'] });
    repository.countActiveAdmins.mockResolvedValue(1);
    await expect(
      service.update(actor, user.id, { status: 'SUSPENDED' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.update.mock.calls).toHaveLength(0);
  });
});
