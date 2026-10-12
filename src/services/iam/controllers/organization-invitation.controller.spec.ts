import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { OrganizationInvitationService } from '../application/organizations/organization-invitation.service';
import {
  AccountInvitationController,
  OrganizationInvitationController,
} from './organization-invitation.controller';

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
  email: 'invitee@example.com',
  name: 'Invitee',
  context: 'ACCOUNT' as const,
};

describe('OrganizationInvitationController', () => {
  let auth: jest.Mocked<
    Pick<
      AuthenticationApplicationService,
      'getCurrentIdentity' | 'getCurrentSessionIdentity'
    >
  >;
  let invitations: jest.Mocked<
    Pick<
      OrganizationInvitationService,
      'create' | 'listOrganization' | 'listMine' | 'revoke' | 'accept'
    >
  >;
  let response: Response;

  beforeEach(() => {
    auth = {
      getCurrentIdentity: jest.fn().mockResolvedValue(admin),
      getCurrentSessionIdentity: jest.fn().mockResolvedValue(account),
    };
    invitations = {
      create: jest.fn().mockResolvedValue({ id: 'a'.repeat(24) }),
      listOrganization: jest.fn().mockResolvedValue([]),
      listMine: jest.fn().mockResolvedValue([]),
      revoke: jest.fn().mockResolvedValue(undefined),
      accept: jest
        .fn()
        .mockResolvedValue({ organizationId, organizationName: 'Example' }),
    };
    response = { setHeader: jest.fn() } as unknown as Response;
  });

  it('requires a matching CSRF cookie/header before creating an invitation', async () => {
    const controller = new OrganizationInvitationController(
      auth as never,
      invitations as never,
    );

    await expect(
      controller.create(
        'Bearer access',
        '__Host-csrf=expected',
        'other',
        organizationId,
        { email: 'person@example.com', roleCode: 'MEMBER' },
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitations.create).not.toHaveBeenCalled();
  });

  it('rejects extra or unsupported invitation body fields at the HTTP boundary', async () => {
    const controller = new OrganizationInvitationController(
      auth as never,
      invitations as never,
    );

    await expect(
      controller.create(
        'Bearer access',
        '__Host-csrf=csrf',
        'csrf',
        organizationId,
        {
          email: 'person@example.com',
          roleCode: 'PLATFORM_OPERATOR',
          organizationId,
        },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(invitations.create).not.toHaveBeenCalled();
  });

  it('uses authenticated session identity for the email-scoped invitation inbox', async () => {
    const controller = new AccountInvitationController(
      auth as never,
      invitations as never,
    );

    await controller.list('Bearer access', 'continuum_access=access', response);

    expect(auth.getCurrentSessionIdentity).toHaveBeenCalledWith(
      'Bearer access',
      'continuum_access=access',
    );
    expect(invitations.listMine).toHaveBeenCalledWith(account);
  });

  it('requires CSRF on acceptance and forwards no user id or role from the client', async () => {
    const controller = new AccountInvitationController(
      auth as never,
      invitations as never,
    );

    await expect(
      controller.accept(
        'Bearer access',
        '__Host-csrf=csrf',
        'wrong',
        'a'.repeat(24),
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(invitations.accept).not.toHaveBeenCalled();

    await controller.accept(
      'Bearer access',
      '__Host-csrf=csrf',
      'csrf',
      'a'.repeat(24),
      response,
    );
    expect(invitations.accept).toHaveBeenCalledWith(account, 'a'.repeat(24));
  });
});
