import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { OrganizationInvitationService } from '../application/organizations/organization-invitation.service';
import { AccountInvitationController } from './organization-invitation.controller';

const account = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: 'invitee@example.com',
  name: 'Invitee',
  context: 'ACCOUNT' as const,
};

describe('AccountInvitationController', () => {
  let auth: jest.Mocked<
    Pick<AuthenticationApplicationService, 'getCurrentSessionIdentity'>
  >;
  let invitations: jest.Mocked<
    Pick<
      OrganizationInvitationService,
      'listMine' | 'getMine' | 'resolveToken' | 'accept'
    >
  >;
  let setHeader: jest.MockedFunction<Response['setHeader']>;
  let response: Response;
  let controller: AccountInvitationController;

  beforeEach(() => {
    auth = {
      getCurrentSessionIdentity: jest.fn().mockResolvedValue(account),
    };
    invitations = {
      listMine: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      getMine: jest.fn().mockResolvedValue({}),
      resolveToken: jest.fn().mockResolvedValue({
        invitation: { id: 'a'.repeat(24), status: 'PENDING' },
        organization: { name: 'Test organization' },
      }),
      accept: jest.fn().mockResolvedValue({
        acknowledgement: { operationId: 'b'.repeat(24) },
        replayed: false,
      }),
    };
    setHeader = jest.fn();
    response = { setHeader } as unknown as Response;
    controller = new AccountInvitationController(
      auth as never,
      invitations as never,
    );
  });

  it('uses the authenticated account and paginated query for the recipient inbox', async () => {
    await controller.list(
      'Bearer access',
      'continuum_access=access',
      { page: '2', pageSize: '10' },
      response,
    );
    expect(auth.getCurrentSessionIdentity).toHaveBeenCalledWith(
      'Bearer access',
      'continuum_access=access',
    );
    expect(invitations.listMine.mock.calls).toContainEqual([account, 2, 10]);
    expect(setHeader.mock.calls).toContainEqual(['Cache-Control', 'no-store']);
  });

  it('rejects unknown or non-integer list query values', async () => {
    await expect(
      controller.list(undefined, undefined, { page: '1.2' }, response),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.list(undefined, undefined, { status: 'PENDING' }, response),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(invitations.listMine).not.toHaveBeenCalled();
  });

  it('reads recipient detail only through the authenticated account service', async () => {
    await controller.get(
      'Bearer access',
      'continuum_access=access',
      'a'.repeat(24),
      response,
    );
    expect(invitations.getMine.mock.calls).toContainEqual([
      account,
      'a'.repeat(24),
    ]);
    expect(setHeader.mock.calls).toContainEqual(['Cache-Control', 'no-store']);
  });

  it('resolves an invitation token without authenticating and never caches the response', async () => {
    await controller.resolve({ token: 't'.repeat(43) }, response);
    expect(invitations.resolveToken).toHaveBeenCalledWith('t'.repeat(43));
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    await expect(
      controller.resolve(
        { token: 't'.repeat(43), email: 'forged@example.com' },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('accepts with an authenticated account and only the invitation version', async () => {
    const body = { expectedInvitationVersion: 1 };
    await expect(
      controller.accept(
        'Bearer access',
        '__Host-csrf=csrf',
        'csrf',
        '0123456789abcdef',
        'a'.repeat(24),
        body,
        response,
      ),
    ).resolves.toEqual({ operationId: 'b'.repeat(24) });
    expect(invitations.accept).toHaveBeenCalledWith(
      account,
      'a'.repeat(24),
      1,
      '0123456789abcdef',
    );
    await expect(
      controller.accept(
        'Bearer access',
        '__Host-csrf=csrf',
        'wrong',
        '0123456789abcdef',
        'a'.repeat(24),
        body,
        response,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.accept(
        'Bearer access',
        '__Host-csrf=csrf',
        'csrf',
        undefined,
        'a'.repeat(24),
        body,
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.accept(
        'Bearer access',
        '__Host-csrf=csrf',
        'csrf',
        '0123456789abcdef',
        'a'.repeat(24),
        { ...body, unexpected: true },
        response,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
