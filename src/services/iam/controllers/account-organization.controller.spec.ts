import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import { AccountOrganizationController } from './account-organization.controller';
import type { AuthenticationApplicationService } from '../application/authentication/authentication.application.service';
import type { OrganizationProvisioningService } from '../application/organizations/organization-provisioning.service';

describe('AccountOrganizationController', () => {
  const actor = {
    id: '651a2b3c4d5e6f7a8b9c0d1e',
    email: 'member@example.test',
    name: 'Member User',
    context: 'ACCOUNT' as const,
  };
  const getCurrentSessionIdentity = jest.fn();
  const createSelfService = jest.fn();
  const auth = {
    getCurrentSessionIdentity,
  } as unknown as AuthenticationApplicationService;
  const organizations = {
    createSelfService,
  } as unknown as OrganizationProvisioningService;
  const controller = new AccountOrganizationController(auth, organizations);

  beforeEach(() => {
    jest.resetAllMocks();
    getCurrentSessionIdentity.mockResolvedValue(actor);
  });

  it('creates an Organization for the current authenticated user and sets Cache-Control', async () => {
    const setHeader = jest.fn();
    const response = { setHeader } as unknown as Response;
    createSelfService.mockResolvedValue({
      id: '651a2b3c4d5e6f7a8b9c0d1f',
      name: 'New Workspace',
      slug: 'new-workspace',
      plan: 'FREE',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    });

    const result = await controller.create(
      undefined,
      '__Host-csrf=csrf-token; continuum_access=session-token',
      'csrf-token',
      { name: '  New Workspace  ', slug: '  New-Workspace ' },
      response,
    );

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(getCurrentSessionIdentity).toHaveBeenCalledWith(
      undefined,
      '__Host-csrf=csrf-token; continuum_access=session-token',
    );
    expect(createSelfService).toHaveBeenCalledWith(actor, {
      name: 'New Workspace',
      slug: 'new-workspace',
    });
    expect(result).toMatchObject({
      id: '651a2b3c4d5e6f7a8b9c0d1f',
      name: 'New Workspace',
      slug: 'new-workspace',
      plan: 'FREE',
    });
  });

  it('rejects requests without a matching CSRF pair', async () => {
    const setHeader = jest.fn();
    const response = { setHeader } as unknown as Response;

    await expect(
      controller.create(
        undefined,
        '__Host-csrf=csrf-token',
        'wrong-token',
        { name: 'Workspace', slug: 'workspace' },
        response,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(createSelfService).not.toHaveBeenCalled();
  });

  it('rejects invalid organization slug or unexpected fields', async () => {
    const setHeader = jest.fn();
    const response = { setHeader } as unknown as Response;

    await expect(
      controller.create(
        undefined,
        '__Host-csrf=csrf-token',
        'csrf-token',
        { name: 'Workspace', slug: 'invalid_slug!' },
        response,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(createSelfService).not.toHaveBeenCalled();
  });
});
