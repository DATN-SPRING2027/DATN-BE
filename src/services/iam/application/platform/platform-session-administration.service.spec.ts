import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OrganizationMembershipCommandRepository } from '../organizations/organization-membership-command.repository';
import type {
  PlatformAdministrationRepository,
  PlatformRevokeSessionsInput,
  PlatformSessionMutationInput,
  PlatformSessionVersionInput,
} from './platform-administration.repository';
import { PlatformAdministrationService } from './platform-administration.service';

const actorUserId = '651a2b3c4d5e6f7a8b9c0d21';
const userId = '651a2b3c4d5e6f7a8b9c0d22';
const sessionId = '751a2b3c4d5e6f7a8b9c0d23';
const now = new Date('2026-10-26T00:00:00.000Z');
const input: PlatformSessionMutationInput & PlatformSessionVersionInput = {
  actorUserId,
  userId,
  sessionId,
  reasonCode: 'ACCESS_REVIEW',
  now,
  expectedUpdatedAt: now,
};

describe('Platform session application boundary', () => {
  const repository = {
    listUserSessions: jest.fn(),
    findUserSession: jest.fn(),
    revokeUserSession: jest.fn(),
    revokeUserSessions: jest.fn(),
    revokeAllUserSessions: jest.fn(),
  };
  const service = new PlatformAdministrationService(
    repository as unknown as PlatformAdministrationRepository,
    {} as OrganizationMembershipCommandRepository,
    { isReady: () => Promise.resolve(false) },
  );
  beforeEach(() => jest.resetAllMocks());

  it.each([undefined, null, '2026-10-26T00:00:00.000Z', new Date('invalid')])(
    'rejects invalid single-session CAS %p before persistence',
    async (expectedUpdatedAt) => {
      await expect(
        service.revokeUserSession({
          ...input,
          expectedUpdatedAt,
        } as typeof input),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.revokeUserSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    undefined,
    {},
    { sessionId },
    { sessionId, expectedUpdatedAt: new Date('invalid') },
  ])(
    'rejects malformed bulk entries %p without a partial write',
    async (entry) => {
      await expect(
        service.revokeUserSessions({
          ...input,
          sessions: [entry],
        } as PlatformRevokeSessionsInput),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repository.revokeUserSessions).not.toHaveBeenCalled();
    },
  );

  it('rejects duplicate families and batches above the contract bound', async () => {
    for (const sessions of [
      [input, input],
      Array.from({ length: 101 }, () => input),
    ]) {
      await expect(
        service.revokeUserSessions({ ...input, sessions }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    }
    expect(repository.revokeUserSessions).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0, pageSize: 10 },
    { page: 1, pageSize: 101 },
    { page: 1.5, pageSize: 10 },
  ])('validates bounded pagination %p', async (page) => {
    await expect(
      service.listUserSessions({ userId, ...page }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.listUserSessions).not.toHaveBeenCalled();
  });

  it('conceals a session outside the target user with SESSION_NOT_FOUND', async () => {
    repository.findUserSession.mockResolvedValue(null);
    await expect(
      service.findUserSession(userId, sessionId),
    ).rejects.toMatchObject({ response: { code: 'SESSION_NOT_FOUND' } });
    expect(repository.findUserSession).toHaveBeenCalledWith(userId, sessionId);
  });

  it('preserves the accepted mutation inputs and returns the safe result', async () => {
    const result = { id: sessionId, status: 'REVOKED' };
    repository.revokeUserSession.mockResolvedValue(result);
    await expect(service.revokeUserSession(input)).resolves.toBe(result);
    expect(repository.revokeUserSession).toHaveBeenCalledWith(input);
  });

  it('returns USER_NOT_FOUND for a missing session-list owner', async () => {
    repository.listUserSessions.mockResolvedValue(null);
    await expect(
      service.listUserSessions({ userId, page: 1, pageSize: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
