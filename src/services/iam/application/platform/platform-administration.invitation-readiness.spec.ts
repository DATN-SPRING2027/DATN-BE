import { ServiceUnavailableException } from '@nestjs/common';
import type { OrganizationMembershipCommandRepository } from '../organizations/organization-membership-command.repository';
import type {
  OrganizationInvitationReadiness,
  OrganizationInvitationReadinessGate,
} from '../organizations/organization-invitation-readiness';
import type { PlatformInvitationCommand } from '../organizations/organization-membership-command.repository';
import type { PlatformAdministrationRepository } from './platform-administration.repository';
import { PlatformAdministrationService } from './platform-administration.service';

const actorUserId = '751a2b3c4d5e6f7a8b9c0d1f';
const organizationId = '651a2b3c4d5e6f7a8b9c0d1f';

describe('PlatformAdministrationService invitation readiness', () => {
  const invitationCases: Array<{
    command: PlatformInvitationCommand;
    gates: OrganizationInvitationReadinessGate[];
  }> = [
    {
      command: {
        command: 'INVITE',
        email: 'Invitee@Example.test',
        reasonCode: 'ACCESS_REQUEST',
      },
      gates: ['A7_NOTIFICATION_CONTRACT_PROVIDER', 'A8_COORDINATED_CUTOVER'],
    },
    {
      command: {
        command: 'RESEND',
        invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'ACCESS_REVIEW',
      },
      gates: ['A7_NOTIFICATION_CONTRACT_PROVIDER', 'A8_COORDINATED_CUTOVER'],
    },
    {
      command: {
        command: 'CANCEL',
        invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
        expectedMembershipVersion: 0,
        expectedInvitationVersion: 2,
        reasonCode: 'INVITATION_CANCELLED',
      },
      gates: ['A8_COORDINATED_CUTOVER'],
    },
  ];
  let membershipCommands: jest.Mocked<
    Pick<
      OrganizationMembershipCommandRepository,
      'executePlatformInvitationCommand'
    >
  >;
  let readiness: jest.Mocked<OrganizationInvitationReadiness>;
  let service: PlatformAdministrationService;

  beforeEach(() => {
    membershipCommands = {
      executePlatformInvitationCommand: jest.fn().mockResolvedValue({
        httpStatus: 201,
        replayed: false,
        body: {
          operationId: '851a2b3c4d5e6f7a8b9c0d1f',
          invitation: {
            id: '951a2b3c4d5e6f7a8b9c0d1f',
            status: 'PENDING',
            version: 1,
            expiresAt: '2026-10-21T00:00:00.000Z',
          },
        },
      }),
    };
    readiness = { isReady: jest.fn().mockResolvedValue(true) };
    service = new PlatformAdministrationService(
      {} as PlatformAdministrationRepository,
      membershipCommands as unknown as OrganizationMembershipCommandRepository,
      readiness,
    );
  });

  it.each(invitationCases)(
    'checks the mapped gates for $command.command',
    async ({ command, gates }) => {
      await service.executePlatformInvitationCommand({
        actorUserId,
        organizationId,
        idempotencyKey: 'stable-idempotency-key',
        command,
      });

      expect(readiness.isReady.mock.calls.map(([gate]) => gate)).toEqual(gates);
      const repositoryInput =
        membershipCommands.executePlatformInvitationCommand.mock.calls[0]?.[0];
      expect(repositoryInput).toMatchObject({
        actorUserId,
        organizationId,
        invitationReadinessReady: true,
        command:
          command.command === 'INVITE'
            ? { ...command, email: 'invitee@example.test' }
            : command,
      });
    },
  );

  it('maps readiness-provider errors to NOT READY and preserves its 503 failure', async () => {
    readiness.isReady.mockRejectedValue(
      new Error('readiness provider unavailable'),
    );
    membershipCommands.executePlatformInvitationCommand.mockRejectedValueOnce(
      new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      }),
    );

    await expect(
      service.executePlatformInvitationCommand({
        actorUserId,
        organizationId,
        idempotencyKey: 'stable-idempotency-key',
        command: {
          command: 'CANCEL',
          invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
          expectedMembershipVersion: 0,
          expectedInvitationVersion: 2,
          reasonCode: 'INVITATION_CANCELLED',
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      membershipCommands.executePlatformInvitationCommand,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ invitationReadinessReady: false }),
    );
  });

  it('delegates exact idempotency replay when readiness-provider checks reject', async () => {
    readiness.isReady.mockRejectedValue(
      new Error('readiness provider unavailable'),
    );
    membershipCommands.executePlatformInvitationCommand.mockResolvedValueOnce({
      httpStatus: 201,
      replayed: true,
      body: {
        operationId: '851a2b3c4d5e6f7a8b9c0d1f',
        invitation: {
          id: '951a2b3c4d5e6f7a8b9c0d1f',
          status: 'CANCELLED',
          version: 2,
          expiresAt: '2026-10-21T00:00:00.000Z',
        },
      },
    });

    await expect(
      service.executePlatformInvitationCommand({
        actorUserId,
        organizationId,
        idempotencyKey: 'stable-idempotency-key',
        command: {
          command: 'CANCEL',
          invitationId: 'a51a2b3c4d5e6f7a8b9c0d1f',
          expectedMembershipVersion: 0,
          expectedInvitationVersion: 2,
          reasonCode: 'INVITATION_CANCELLED',
        },
      }),
    ).resolves.toMatchObject({ replayed: true });
    expect(
      membershipCommands.executePlatformInvitationCommand,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ invitationReadinessReady: false }),
    );
  });
});
