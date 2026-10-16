import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PLATFORM_PERMISSIONS } from '../authorization/authorization.policy';
import {
  PLATFORM_AUTHORITY_CHANGE_AUTHORIZATION,
  type PlatformAuthorityChangeAuthorizationPolicy,
} from './platform-authority-change.authorization';
import {
  PLATFORM_AUTHORITY_CHANGE_REPOSITORY,
  type PlatformAuthorityChangeRepository,
} from './platform-authority-change.repository';
import type {
  PlatformAuthorityChangeCommand,
  PlatformAuthorityChangeResult,
} from './platform-authority-change.types';

@Injectable()
export class PlatformAuthorityChangeService {
  constructor(
    @Inject(PLATFORM_AUTHORITY_CHANGE_REPOSITORY)
    private readonly repository: PlatformAuthorityChangeRepository,
    @Optional()
    @Inject(PLATFORM_AUTHORITY_CHANGE_AUTHORIZATION)
    private readonly authorizationPolicy?: PlatformAuthorityChangeAuthorizationPolicy,
  ) {}

  async executeChange(
    command: PlatformAuthorityChangeCommand,
  ): Promise<PlatformAuthorityChangeResult> {
    if (!command.operationId || typeof command.operationId !== 'string') {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_ID',
        message: 'A valid non-empty operationId is required.',
      });
    }

    if (
      !Types.ObjectId.isValid(command.actorUserId) ||
      !Types.ObjectId.isValid(command.issuerUserId) ||
      !Types.ObjectId.isValid(command.targetUserId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_PRINCIPAL_ID',
        message:
          'Principal IDs must be valid 24-character hexadecimal ObjectIds.',
      });
    }

    const actorId = command.actorUserId.toLowerCase();
    const issuerId = command.issuerUserId.toLowerCase();
    const targetId = command.targetUserId.toLowerCase();

    // Gate 1: Two-person rule (Executor and Authorizing Issuer must be distinct)
    if (actorId === issuerId) {
      throw new ForbiddenException({
        code: 'TWO_PERSON_RULE_VIOLATION',
        message:
          'Dual control violation: Executor and authorizing issuer must be distinct principals.',
      });
    }

    // Gate 1: Anti-self-grant invariant
    if (command.operationType === 'GRANT') {
      if (targetId === actorId || targetId === issuerId) {
        throw new ForbiddenException({
          code: 'SELF_GRANT_PROHIBITED',
          message:
            'Self-grant or operator self-delegation of platform authority is strictly prohibited.',
        });
      }
    }

    // Gate 1 & 3: Runtime permission catalog constraint (only active V1 A-04 permissions)
    if (!PLATFORM_PERMISSIONS.includes(command.permission)) {
      throw new ForbiddenException({
        code: 'NO_DOCUMENTED_PERMISSION',
        message: `Permission '${command.permission}' is outside canonical V1 active catalog.`,
      });
    }

    if (command.scope !== 'PLATFORM') {
      throw new BadRequestException({
        code: 'INVALID_SCOPE',
        message: "Platform authority mutations require exact 'PLATFORM' scope.",
      });
    }

    if (
      !command.reasonCode ||
      typeof command.reasonCode !== 'string' ||
      command.reasonCode.trim().length === 0
    ) {
      throw new BadRequestException({
        code: 'REASON_CODE_REQUIRED',
        message: 'A non-empty reason code is required for audit traceability.',
      });
    }

    if (!this.authorizationPolicy) {
      throw new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_WORKFLOW_UNAVAILABLE',
        message:
          'Platform authority changes are disabled until an approved issuer and MFA workflow is configured.',
      });
    }

    await this.authorizationPolicy.assertAuthorized(command);
    return this.repository.execute(command);
  }
}
