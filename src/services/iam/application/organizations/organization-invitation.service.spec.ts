import { HttpException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
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
      resolveByTokenHash: jest.fn().mockResolvedValue(null),
      acceptForRecipient: jest.fn().mockResolvedValue({
        acknowledgement: { operationId: 'b'.repeat(24) },
        replayed: false,
      }),
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

  it('hashes the one-time token before resolving and returns no details for unknown tokens', async () => {
    const token = 't'.repeat(43);
    await expect(service.resolveToken(token)).rejects.toMatchObject({
      status: 404,
    });
    expect(repository.resolveByTokenHash).toHaveBeenCalledWith(
      createHash('sha256').update(token).digest('hex'),
      expect.any(Date),
    );
    await expect(service.resolveToken('short')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(repository.resolveByTokenHash).toHaveBeenCalledTimes(1);
  });

  it('accepts only with the authenticated account identity and invitation version', async () => {
    await service.accept(account, 'a'.repeat(24), 3, '0123456789abcdef');
    expect(repository.acceptForRecipient).toHaveBeenCalledTimes(1);
    const call = repository.acceptForRecipient.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      invitationId: 'a'.repeat(24),
      actorUserId: account.id,
      authenticatedEmail: 'invitee@example.com',
      expectedInvitationVersion: 3,
      idempotencyKey: '0123456789abcdef',
    });
    expect(call?.now).toBeInstanceOf(Date);
    await expect(
      service.accept(
        { ...account, email: 'bad-email' },
        'a'.repeat(24),
        3,
        '0123456789abcdef',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.acceptForRecipient).toHaveBeenCalledTimes(1);
  });
});
