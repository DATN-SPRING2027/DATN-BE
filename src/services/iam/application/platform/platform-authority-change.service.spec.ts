import { BadRequestException } from '@nestjs/common';
import type { PlatformAuthorityChangeAuthorizationPolicy } from './platform-authority-change.authorization';
import { Types } from 'mongoose';
import { PlatformAuthorityChangeService } from './platform-authority-change.service';
import type { PlatformAuthorityChangeRepository } from './platform-authority-change.repository';
import type {
  PlatformAuthorityChangeCommand,
  PlatformAuthorityChangeResult,
} from './platform-authority-change.types';

describe('PlatformAuthorityChangeService', () => {
  let service: PlatformAuthorityChangeService;
  let mockExecute: jest.Mock;
  let mockRepository: PlatformAuthorityChangeRepository;
  let mockAuthorizationPolicy: PlatformAuthorityChangeAuthorizationPolicy;
  let mockAssertAuthorized: jest.Mock;

  const actorUserId = new Types.ObjectId().toHexString();
  const issuerUserId = new Types.ObjectId().toHexString();
  const targetUserId = new Types.ObjectId().toHexString();

  const validGrantCommand: PlatformAuthorityChangeCommand = {
    operationId: 'op-grant-01',
    operationType: 'GRANT',
    targetUserId,
    permission: 'organization.create',
    scope: 'PLATFORM',
    actorUserId,
    issuerUserId,
    reasonCode: 'APPROVED_PO_AUTH_01_BOOTSTRAP',
  };

  const sampleResult: PlatformAuthorityChangeResult = {
    operationId: 'op-grant-01',
    status: 'COMMITTED',
    httpStatus: 201,
    replayed: false,
    body: {
      operationId: 'op-grant-01',
      assignmentId: new Types.ObjectId().toHexString(),
      targetUserId,
      permission: 'organization.create',
      scope: 'PLATFORM',
      status: 'ACTIVE',
      grantedBy: issuerUserId,
      grantedAt: new Date().toISOString(),
      expiresAt: null,
    },
  };

  beforeEach(() => {
    mockExecute = jest.fn().mockResolvedValue(sampleResult);
    mockRepository = {
      execute: mockExecute,
    };
    mockAssertAuthorized = jest.fn().mockResolvedValue(undefined);
    mockAuthorizationPolicy = { assertAuthorized: mockAssertAuthorized };
    service = new PlatformAuthorityChangeService(
      mockRepository,
      mockAuthorizationPolicy,
    );
  });

  describe('Dual Control & Two-Person Separation (Gate 1)', () => {
    it('rejects when executor and issuer are the same principal', async () => {
      const samePrincipal = new Types.ObjectId().toHexString();
      await expect(
        service.executeChange({
          ...validGrantCommand,
          actorUserId: samePrincipal,
          issuerUserId: samePrincipal,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'TWO_PERSON_RULE_VIOLATION',
        },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rejects self-grant where target is the executor', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          targetUserId: actorUserId,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'SELF_GRANT_PROHIBITED',
        },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rejects self-grant where target is the authorizing issuer', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          targetUserId: issuerUserId,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'SELF_GRANT_PROHIBITED',
        },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('Runtime Permission Catalog Boundaries (Gate 3)', () => {
    it.each([
      'platform.configuration.read',
      'platform.configuration.write',
      'platform.admin',
      'system.admin',
      'organization.memberships.manage',
      'project.create',
      'random.unknown.permission',
    ])(
      'rejects non-V1 permission %s as NO_DOCUMENTED_PERMISSION',
      async (permission) => {
        await expect(
          service.executeChange({
            ...validGrantCommand,
            permission: permission as unknown as 'organization.create',
          }),
        ).rejects.toMatchObject({
          response: {
            code: 'NO_DOCUMENTED_PERMISSION',
          },
        });
        expect(mockExecute).not.toHaveBeenCalled();
      },
    );

    it.each([
      'organization.create',
      'platform.health.read',
      'platform.audit.read',
    ] as const)(
      'accepts canonical active V1 permission %s',
      async (permission) => {
        await expect(
          service.executeChange({
            ...validGrantCommand,
            permission,
          }),
        ).resolves.toEqual(sampleResult);
        expect(mockExecute).toHaveBeenCalled();
      },
    );
  });

  describe('Input Validation & Safety Constraints', () => {
    it('fails closed when no approved issuer and MFA policy is configured', async () => {
      const unconfiguredService = new PlatformAuthorityChangeService(
        mockRepository,
      );
      const callerSuppliedMfa = {
        ...validGrantCommand,
        mfaVerified: true,
      } as PlatformAuthorityChangeCommand;

      await expect(
        unconfiguredService.executeChange(callerSuppliedMfa),
      ).rejects.toMatchObject({
        status: 503,
        response: { code: 'PLATFORM_AUTHORITY_WORKFLOW_UNAVAILABLE' },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rejects invalid principal IDs', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          actorUserId: 'not-an-objectid',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing or empty operationId', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          operationId: '',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects non-PLATFORM scope', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          scope: 'ORGANIZATION' as unknown as 'PLATFORM',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects empty reasonCode', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          reasonCode: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delegates valid command to repository and returns result', async () => {
      const res = await service.executeChange(validGrantCommand);
      expect(res).toEqual(sampleResult);
      expect(mockAssertAuthorized).toHaveBeenCalledWith(validGrantCommand);
      expect(mockExecute).toHaveBeenCalledWith(validGrantCommand);
    });
  });
});
