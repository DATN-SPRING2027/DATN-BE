import { BadRequestException } from '@nestjs/common';
import type { PlatformAuthorityChangeAuthorizationPolicy } from './platform-authority-change.authorization';
import { Types } from 'mongoose';
import { PlatformAuthorityChangeService } from './platform-authority-change.service';
import type { PlatformAuthorityChangeRepository } from './platform-authority-change.repository';
import type {
  PlatformAuthorityChangeCommand,
  PlatformAuthorityChangeResult,
} from './platform-authority-change.types';
import { hashAssignmentSnapshot } from './platform-authority-change.types';

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
    operationId: '00000000-0000-4000-8000-000000000001',
    operationType: 'BOOTSTRAP',
    bundleVersion: 'V1',
    targetUserId,
    scope: 'PLATFORM',
    actorUserId,
    issuerUserId,
    expectedCurrentSnapshotHash: hashAssignmentSnapshot([]),
    reasonCode: 'PO_AUTH_01_BOOTSTRAP',
  };

  const sampleResult: PlatformAuthorityChangeResult = {
    operationId: '00000000-0000-4000-8000-000000000001',
    status: 'COMMITTED',
    httpStatus: 201,
    replayed: false,
    body: {
      operationId: '00000000-0000-4000-8000-000000000001',
      targetUserId,
      scope: 'PLATFORM',
      status: 'ACTIVE',
      assignments: [
        'organization.create',
        'platform.health.read',
        'platform.audit.read',
        'platform.organizations.organization.read',
        'platform.users.account.read',
        'platform.memberships.membership.read',
        'platform.memberships.lifecycle.manage',
      ].map((permission) => ({
        assignmentId: new Types.ObjectId().toHexString(),
        permission:
          permission as PlatformAuthorityChangeResult['body']['assignments'][number]['permission'],
        status: 'ACTIVE' as const,
        grantedBy: issuerUserId,
        grantedAt: new Date().toISOString(),
        expiresAt: null,
      })),
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

  describe('Fixed versioned permission bundles and CAS', () => {
    it('rejects a caller-selected single permission', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          permission: 'organization.create',
        } as unknown as PlatformAuthorityChangeCommand),
      ).rejects.toMatchObject({
        response: { code: 'FIXED_PERMISSION_BUNDLE_REQUIRED' },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('requires a full assignment snapshot hash', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          expectedCurrentSnapshotHash: '',
        }),
      ).rejects.toMatchObject({
        response: { code: 'EXPECTED_SNAPSHOT_REQUIRED' },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rejects privilege-escalation flags rather than trusting caller fields', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          breakGlass: true,
        } as PlatformAuthorityChangeCommand),
      ).rejects.toMatchObject({
        response: { code: 'UNSUPPORTED_AUTHORITY_FIELD' },
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('Input Validation & Safety Constraints', () => {
    it('fails closed when no approved issuer and MFA policy is configured', async () => {
      const unconfiguredService = new PlatformAuthorityChangeService(
        mockRepository,
      );

      await expect(
        unconfiguredService.executeChange(validGrantCommand),
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

    it('rejects a free-form reasonCode', async () => {
      await expect(
        service.executeChange({
          ...validGrantCommand,
          reasonCode: 'FREEFORM_REASON',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('delegates valid command to repository and returns result', async () => {
      const res = await service.executeChange(validGrantCommand);
      expect(res).toEqual(sampleResult);
      expect(mockAssertAuthorized).toHaveBeenCalledWith(validGrantCommand);
      expect(mockExecute).toHaveBeenCalledWith(validGrantCommand);
    });

    it('accepts only the fixed V2 expansion command when the issuer gate is configured', async () => {
      const command: PlatformAuthorityChangeCommand = {
        ...validGrantCommand,
        operationId: '00000000-0000-4000-8000-000000000002',
        operationType: 'V2_EXPAND',
        bundleVersion: 'V2',
        reasonCode: 'PO_AUTH_01_V2_EXPAND',
      };
      await service.executeChange(command);
      expect(mockAssertAuthorized).toHaveBeenCalledWith(command);
      expect(mockExecute).toHaveBeenCalledWith(command);
    });
  });
});
