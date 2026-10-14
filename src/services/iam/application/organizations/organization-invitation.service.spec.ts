import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import type { AuthenticatedAccountIdentity } from '../authentication/authentication.application.service';
import type { OrganizationInvitationRepository } from './organization-invitation.repository';
import {
  normalizeInvitationEmail,
  OrganizationInvitationService,
} from './organization-invitation.service';

const account: AuthenticatedAccountIdentity = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: '  Invitee@Example.com ',
  name: 'Invitee',
  context: 'ACCOUNT',
};

describe('OrganizationInvitationService', () => {
  let repository: jest.Mocked<OrganizationInvitationRepository>;
  let service: OrganizationInvitationService;

  beforeEach(() => {
    repository = {
      listForRecipient: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      getForRecipient: jest.fn().mockResolvedValue(null),
    };
    service = new OrganizationInvitationService(repository);
  });

  it('binds a paged inbox lookup to the authenticated user and normalized exact email', async () => {
    await service.listMine(account, 2, 10);
    expect(repository.listForRecipient).toHaveBeenCalledWith(
      account.id,
      'invitee@example.com',
      expect.any(Date),
      2,
      10,
    );
  });

  it('rejects a malformed recipient email instead of widening the query', async () => {
    expect(() => normalizeInvitationEmail('not-an-email')).toThrow(
      UnprocessableEntityException,
    );
    await expect(
      service.listMine({ ...account, email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.listForRecipient).not.toHaveBeenCalled();
  });

  it('rejects invalid pagination before repository access', async () => {
    await expect(service.listMine(account, 1, 101)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(repository.listForRecipient).not.toHaveBeenCalled();
  });

  it('binds invitation detail to recipient identity and returns 404 for foreign or unknown IDs', async () => {
    const caught: unknown = await service.getMine(account, 'a'.repeat(24)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(HttpException);
    if (!(caught instanceof HttpException)) throw new Error('Expected 404');
    expect(caught.getStatus()).toBe(404);
    expect(caught.getResponse()).toEqual({ code: 'INVITATION_NOT_FOUND' });
    expect(repository.getForRecipient).toHaveBeenCalledWith(
      'a'.repeat(24),
      account.id,
      'invitee@example.com',
      expect.any(Date),
    );
  });
});
