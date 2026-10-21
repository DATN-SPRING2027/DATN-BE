import {
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import type { OrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { OrganizationMembershipCommandService } from './organization-membership-command.service';
import type { OrganizationInvitationReadiness } from './organization-invitation-readiness';

const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';
const actor: AuthenticatedIdentity = {
  id: '751a2b3c4d5e6f7a8b9c0d1f',
  email: 'admin@example.test',
  name: 'Admin',
  organizationId,
  roles: ['ADMIN'],
};

describe('OrganizationMembershipCommandService', () => {
  let repository: jest.Mocked<OrganizationMembershipCommandRepository>;
  let readiness: jest.Mocked<OrganizationInvitationReadiness>;
  let service: OrganizationMembershipCommandService;

  beforeEach(() => {
    repository = {
      hasPermission: jest.fn().mockResolvedValue(true),
      listInvitations: jest.fn().mockResolvedValue({
        data: [],
        pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      }),
      execute: jest.fn().mockResolvedValue({
        httpStatus: 201,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          membership: {
            id: '951a2b3c4d5e6f7a8b9c0d1f',
            organizationId,
            userId: 'a51a2b3c4d5e6f7a8b9c0d1f',
            status: 'PENDING_INVITE',
            version: 1,
          },
        },
      }),
      executePlatformSuspend: jest.fn().mockResolvedValue({
        httpStatus: 200,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          membership: {
            id: '951a2b3c4d5e6f7a8b9c0d1f',
            organizationId,
            userId: 'a51a2b3c4d5e6f7a8b9c0d1f',
            status: 'SUSPENDED',
            version: 2,
          },
        },
      }),
      executePlatformInvitationCommand: jest.fn().mockRejectedValue({
        response: { code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE' },
        status: 503,
      }),
    };
    readiness = { isReady: jest.fn().mockResolvedValue(true) };
    service = new OrganizationMembershipCommandService(repository, readiness);
  });

  it('requires the path organization to match authenticated Organization context', async () => {
    await expect(
      service.execute(
        actor,
        '851a2b3c4d5e6f7a8b9c0d1f',
        'stable-idempotency-key',
        {
          command: 'INVITE',
          email: 'member@example.test',
          reasonCode: 'ACCESS_REQUEST',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.execute).not.toHaveBeenCalled();
  });

  it('normalizes the email and passes the idempotency key to the transactional repository', async () => {
    await service.execute(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'INVITE',
        email: '  Member@Example.test ',
        reasonCode: 'ACCESS_REQUEST',
      },
      'request-correlation-id',
    );

    expect(repository.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: actor.id,
        organizationId,
        idempotencyKey: 'stable-idempotency-key',
        command: {
          command: 'INVITE',
          email: 'member@example.test',
          reasonCode: 'ACCESS_REQUEST',
        },
        correlationId: 'request-correlation-id',
        invitationReadinessReady: true,
      }),
    );
    expect(readiness.isReady.mock.calls[0]?.[0]).toBe(
      'A7_NOTIFICATION_CONTRACT_PROVIDER',
    );
    expect(readiness.isReady.mock.calls[1]?.[0]).toBe('A8_COORDINATED_CUTOVER');
  });

  it('checks only A8 for CANCEL and passes the fail-closed result to persistence', async () => {
    readiness.isReady.mockImplementation((gate) =>
      Promise.resolve(gate !== 'A8_COORDINATED_CUTOVER'),
    );
    repository.execute.mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      }),
    );
    await expect(
      service.execute(actor, organizationId, 'stable-idempotency-key', {
        command: 'CANCEL',
        invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'INVITATION_CANCELLED',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(readiness.isReady.mock.calls).toHaveLength(1);
    expect(readiness.isReady.mock.calls[0]?.[0]).toBe('A8_COORDINATED_CUTOVER');
    expect(repository.execute).toHaveBeenCalledWith(
      expect.objectContaining({ invitationReadinessReady: false }),
    );
  });

  it('normalizes the role-change reason and passes both expected versions to persistence', async () => {
    const membershipId = '951a2b3c4d5e6f7a8b9c0d1f';
    await service.execute(
      actor,
      organizationId,
      'stable-idempotency-key',
      {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId,
        expectedMembershipVersion: 3,
        expectedRoleVersion: 0,
        roleCode: 'MEMBER',
        reason: '  Access review completed  ',
      },
      'request-correlation-id',
    );

    expect(repository.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: actor.id,
        organizationId,
        idempotencyKey: 'stable-idempotency-key',
        correlationId: 'request-correlation-id',
        command: {
          command: 'SET_ORGANIZATION_ROLE',
          membershipId,
          expectedMembershipVersion: 3,
          expectedRoleVersion: 0,
          roleCode: 'MEMBER',
          reason: 'Access review completed',
        },
      }),
    );
  });

  it.each([
    { roleCode: 'TEAM_LEADER', expectedRoleVersion: 0, reason: 'review' },
    { roleCode: 'ADMIN', expectedRoleVersion: -1, reason: 'review' },
    { roleCode: 'MEMBER', expectedRoleVersion: 0, reason: '   ' },
    {
      roleCode: 'MEMBER',
      expectedRoleVersion: 0,
      reason: 'review',
      extra: true,
    },
  ])('rejects invalid Organization role command values: %o', async (fields) => {
    await expect(
      service.execute(actor, organizationId, 'stable-idempotency-key', {
        command: 'SET_ORGANIZATION_ROLE',
        membershipId: '951a2b3c4d5e6f7a8b9c0d1f',
        expectedMembershipVersion: 3,
        ...fields,
      } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.execute).not.toHaveBeenCalled();
  });

  it('rejects malformed and reused-short idempotency keys before persistence', async () => {
    await expect(
      service.execute(actor, organizationId, 'short', {
        command: 'INVITE',
        email: 'member@example.test',
        reasonCode: 'ACCESS_REQUEST',
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.execute).not.toHaveBeenCalled();
  });

  it('rejects unknown command properties instead of dropping them', async () => {
    await expect(
      service.execute(actor, organizationId, 'stable-idempotency-key', {
        command: 'SUSPEND',
        membershipId: '951a2b3c4d5e6f7a8b9c0d1f',
        expectedMembershipVersion: 1,
        reasonCode: 'ACCESS_REVIEW',
        roleCode: 'ADMIN',
      } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(repository.execute).not.toHaveBeenCalled();
  });

  it('requires the backend read permission for invitation lists', async () => {
    repository.hasPermission.mockResolvedValue(false);
    await expect(
      service.listInvitations(actor, organizationId, 1, 20),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.hasPermission).toHaveBeenCalledWith(
      organizationId,
      actor.id,
      'organization.memberships.read',
    );
    expect(repository.listInvitations).not.toHaveBeenCalled();
  });
});
