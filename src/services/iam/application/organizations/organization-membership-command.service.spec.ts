import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { AuthenticatedIdentity } from '../authentication/authentication.application.service';
import type { OrganizationMembershipCommandRepository } from './organization-membership-command.repository';
import { OrganizationMembershipCommandService } from './organization-membership-command.service';

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
    };
    service = new OrganizationMembershipCommandService(repository);
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
      }),
    );
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
