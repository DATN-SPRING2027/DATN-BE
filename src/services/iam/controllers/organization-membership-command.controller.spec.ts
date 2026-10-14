import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AuthenticationApplicationService,
  AuthenticatedIdentity,
} from '../application/authentication/authentication.application.service';
import type { OrganizationMembershipCommandService } from '../application/organizations/organization-membership-command.service';
import { OrganizationMembershipCommandController } from './organization-membership-command.controller';

const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const actor: AuthenticatedIdentity = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: 'admin@example.test',
  name: 'Admin',
  organizationId,
  roles: ['ADMIN'],
};

describe('OrganizationMembershipCommandController', () => {
  const auth = {
    getCurrentIdentity: jest.fn().mockResolvedValue(actor),
  };
  const commands = {
    execute: jest.fn().mockResolvedValue({
      httpStatus: 201,
      replayed: true,
      body: { operationId: '851a2b3c4d5e6f7a8b9c0d1f' },
    }),
    listInvitations: jest.fn().mockResolvedValue({ data: [], pagination: {} }),
  };
  let controller: OrganizationMembershipCommandController;
  let response: { setHeader: jest.Mock; status: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new OrganizationMembershipCommandController(
      auth as unknown as AuthenticationApplicationService,
      commands as unknown as OrganizationMembershipCommandService,
    );
    response = { setHeader: jest.fn(), status: jest.fn() };
  });

  it('accepts only the exact invite request and propagates replay acknowledgement', async () => {
    const result = await controller.invite(
      'Bearer token',
      '__Host-csrf=csrf-token',
      'csrf-token',
      'stable-idempotency-key',
      'request-id',
      organizationId,
      { email: 'member@example.test', reasonCode: 'ACCESS_REQUEST' },
      response as never,
    );
    expect(commands.execute).toHaveBeenCalledWith(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'INVITE',
        email: 'member@example.test',
        reasonCode: 'ACCESS_REQUEST',
      },
      'request-id',
    );
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.setHeader).toHaveBeenCalledWith(
      'Idempotency-Replayed',
      'true',
    );
    expect(result).toEqual({ operationId: '851a2b3c4d5e6f7a8b9c0d1f' });
  });

  it('rejects the legacy roleCode payload and any unknown field', async () => {
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        { email: 'member@example.test', roleCode: 'ADMIN' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'csrf-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        {
          email: 'member@example.test',
          reasonCode: 'ACCESS_REQUEST',
          roleCode: 'ADMIN',
        },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('requires matching CSRF cookie and header before sending a command', async () => {
    await expect(
      controller.invite(
        'Bearer token',
        '__Host-csrf=csrf-token',
        'other-token',
        'stable-idempotency-key',
        undefined,
        organizationId,
        { email: 'member@example.test', reasonCode: 'ACCESS_REQUEST' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('authenticates before parsing membership command details', async () => {
    const authenticationError = new ForbiddenException({
      code: 'AUTH_SESSION_INVALID',
    });
    auth.getCurrentIdentity.mockRejectedValueOnce(authenticationError);
    await expect(
      controller.suspend(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        organizationId,
        'invalid-membership-id',
        {},
        response as never,
      ),
    ).rejects.toBe(authenticationError);
    expect(commands.execute).not.toHaveBeenCalled();
  });

  it('rejects unknown list query fields', async () => {
    await expect(
      controller.listInvitations(
        'Bearer token',
        undefined,
        organizationId,
        { page: '1', roleCode: 'ADMIN' },
        response as never,
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(commands.listInvitations).not.toHaveBeenCalled();
  });
});
