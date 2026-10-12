import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrganizationInvitationService } from './organization-invitation.service';
import type {
  AcceptOrganizationInvitationInput,
  CreateOrganizationInvitationInput,
  OrganizationInvitationRepository,
} from './organization-invitation.repository';

const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const admin = {
  id: '651a2b3c4d5e6f7a8b9c0d1f',
  email: 'admin@example.com',
  name: 'Admin',
  organizationId,
  roles: ['ADMIN'],
};
const account = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: '  Invitee@Example.com ',
  name: 'Invitee',
  context: 'ACCOUNT' as const,
};

describe('OrganizationInvitationService', () => {
  let repository: jest.Mocked<OrganizationInvitationRepository>;
  let security: {
    consumeRateLimit: jest.Mock;
    clearRateLimit: jest.Mock;
    revokeToken: jest.Mock;
    isTokenRevoked: jest.Mock;
  };
  let service: OrganizationInvitationService;

  beforeEach(() => {
    repository = {
      isOrganizationAdmin: jest.fn().mockResolvedValue(true),
      create: jest.fn(),
      listForOrganization: jest.fn().mockResolvedValue([]),
      listForRecipient: jest.fn().mockResolvedValue([]),
      revoke: jest.fn(),
      accept: jest.fn(),
    };
    security = {
      consumeRateLimit: jest.fn().mockResolvedValue(true),
      clearRateLimit: jest.fn().mockResolvedValue(undefined),
      revokeToken: jest.fn().mockResolvedValue(undefined),
      isTokenRevoked: jest.fn().mockResolvedValue(false),
    };
    service = new OrganizationInvitationService(repository, security);
  });

  it('creates a time-limited invitation for the authenticated Organization admin', async () => {
    let createdInput: CreateOrganizationInvitationInput | undefined;
    repository.create.mockImplementation((input) => {
      createdInput = input;
      return Promise.resolve({ id: 'a'.repeat(24) } as never);
    });

    await service.create(admin, organizationId, {
      email: '  Invitee@Example.com ',
      roleCode: 'MEMBER',
    });

    expect(repository.isOrganizationAdmin).toHaveBeenCalledWith(
      organizationId,
      admin.id,
    );
    expect(createdInput).toMatchObject({
      organizationId,
      invitedBy: admin.id,
      email: 'invitee@example.com',
      roleCode: 'MEMBER',
    });
    expect(createdInput?.expiresAt).toBeInstanceOf(Date);
    expect(security.consumeRateLimit).toHaveBeenCalledWith(
      `organization:invite:${organizationId}:${admin.id}`,
      30,
      3600,
    );
  });

  it('rejects creation when the path Organization is not the active session context', async () => {
    await expect(
      service.create(admin, '851a2b3c4d5e6f7a8b9c0d1f', {
        email: 'invitee@example.com',
        roleCode: 'MEMBER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rechecks the current Organization ADMIN assignment before creating an invitation', async () => {
    repository.isOrganizationAdmin.mockResolvedValue(false);

    await expect(
      service.create(admin, organizationId, {
        email: 'invitee@example.com',
        roleCode: 'MEMBER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('limits invitation creation per Organization admin', async () => {
    security.consumeRateLimit.mockResolvedValue(false);

    await expect(
      service.create(admin, organizationId, {
        email: 'invitee@example.com',
        roleCode: 'MEMBER',
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('lists pending invitations only for the signed-in account email', async () => {
    await service.listMine(account);

    expect(repository.listForRecipient).toHaveBeenCalledWith(
      'invitee@example.com',
      expect.any(Date),
      50,
    );
  });

  it('requires current ADMIN authority to list and revoke Organization invitations', async () => {
    repository.isOrganizationAdmin.mockResolvedValue(false);

    await expect(
      service.listOrganization(admin, organizationId),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.revoke(admin, organizationId, 'b'.repeat(24)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.listForOrganization).not.toHaveBeenCalled();
    expect(repository.revoke).not.toHaveBeenCalled();
  });

  it('accepts only an invitation addressed to the authenticated email', async () => {
    let acceptedInput: AcceptOrganizationInvitationInput | undefined;
    repository.accept.mockImplementation((input) => {
      acceptedInput = input;
      return Promise.resolve({ organizationId, organizationName: 'Example' });
    });

    await service.accept(account, 'a'.repeat(24));

    expect(acceptedInput).toMatchObject({
      invitationId: 'a'.repeat(24),
      userId: account.id,
      email: 'invitee@example.com',
    });
    expect(acceptedInput?.now).toBeInstanceOf(Date);
  });

  it('does not reveal whether a missing, expired, revoked, or mismatched invitation exists', async () => {
    repository.accept.mockResolvedValue(null);

    await expect(service.accept(account, 'a'.repeat(24))).rejects.toMatchObject(
      {
        response: { code: 'INVITATION_NOT_ACCEPTABLE' },
      },
    );
  });

  it('reports duplicate pending invitations as a conflict', async () => {
    repository.create.mockRejectedValue(
      new ConflictException({ code: 'INVITATION_ALREADY_PENDING' }),
    );

    await expect(
      service.create(admin, organizationId, {
        email: 'invitee@example.com',
        roleCode: 'MEMBER',
      }),
    ).rejects.toMatchObject({
      response: { code: 'INVITATION_ALREADY_PENDING' },
    });
  });
});
