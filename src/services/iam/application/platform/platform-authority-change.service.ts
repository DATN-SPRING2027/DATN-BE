import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PLATFORM_AUTHORITY_REASON_CODES,
  type PlatformAuthorityChangeCommand,
  type PlatformAuthorityChangeResult,
  type PlatformAuthorityOperationType,
} from './platform-authority-change.types';
import {
  PLATFORM_AUTHORITY_CHANGE_AUTHORIZATION,
  type PlatformAuthorityChangeAuthorizationPolicy,
} from './platform-authority-change.authorization';
import {
  PLATFORM_AUTHORITY_CHANGE_REPOSITORY,
  type PlatformAuthorityChangeRepository,
} from './platform-authority-change.repository';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    input: PlatformAuthorityChangeCommand,
  ): Promise<PlatformAuthorityChangeResult> {
    if (
      typeof input.operationId !== 'string' ||
      !UUID_PATTERN.test(input.operationId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_ID',
        message: 'operationId must be a UUID.',
      });
    }

    const command = { ...input, operationId: input.operationId.toLowerCase() };
    const operationTypes = Object.keys(
      PLATFORM_AUTHORITY_REASON_CODES,
    ) as PlatformAuthorityOperationType[];
    if (!operationTypes.includes(command.operationType)) {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_TYPE',
        message: 'A supported PO-AUTH-01 operation type is required.',
      });
    }

    if (!['A04', 'V1', 'V2'].includes(command.bundleVersion)) {
      throw new BadRequestException({
        code: 'INVALID_BUNDLE_VERSION',
        message: 'A supported fixed Platform authority bundle is required.',
      });
    }

    if (
      (command.operationType === 'BOOTSTRAP' &&
        !['V1', 'V2'].includes(command.bundleVersion)) ||
      (command.operationType === 'V1_EXPAND' &&
        command.bundleVersion !== 'V1') ||
      (command.operationType === 'V2_EXPAND' && command.bundleVersion !== 'V2')
    ) {
      throw new BadRequestException({
        code: 'INVALID_BUNDLE_VERSION',
        message:
          'The selected authority operation requires its fixed versioned bundle.',
      });
    }

    const commandFields = command as unknown as Record<string, unknown>;
    if ('permission' in commandFields || 'permissions' in commandFields) {
      throw new BadRequestException({
        code: 'FIXED_PERMISSION_BUNDLE_REQUIRED',
        message:
          'Platform authority operations only accept a complete fixed permission bundle.',
      });
    }

    const acceptedFields = new Set([
      'operationId',
      'operationType',
      'bundleVersion',
      'targetUserId',
      'scope',
      'actorUserId',
      'issuerUserId',
      'expectedCurrentSnapshotHash',
      'expiresAt',
      'reasonCode',
      'now',
    ]);
    if (Object.keys(commandFields).some((key) => !acceptedFields.has(key))) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_AUTHORITY_FIELD',
        message: 'The PO-AUTH-01 command contains an unsupported field.',
      });
    }

    if (
      typeof command.expectedCurrentSnapshotHash !== 'string' ||
      !/^[a-f\d]{64}$/i.test(command.expectedCurrentSnapshotHash)
    ) {
      throw new BadRequestException({
        code: 'EXPECTED_SNAPSHOT_REQUIRED',
        message:
          'A SHA-256 hash of the full current assignment snapshot is required.',
      });
    }

    if (
      command.reasonCode !==
      PLATFORM_AUTHORITY_REASON_CODES[command.operationType]
    ) {
      throw new BadRequestException({
        code: 'INVALID_REASON_CODE',
        message: 'reasonCode must be the fixed code for the selected action.',
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

    if (actorId === issuerId) {
      throw new ForbiddenException({
        code: 'TWO_PERSON_RULE_VIOLATION',
        message:
          'The executing actor and authorizing issuer must be distinct principals.',
      });
    }

    if (
      command.operationType !== 'REVOKE' &&
      (targetId === actorId || targetId === issuerId)
    ) {
      throw new ForbiddenException({
        code: 'SELF_GRANT_PROHIBITED',
        message: 'The recipient must be distinct from the issuer and executor.',
      });
    }

    if (command.scope !== 'PLATFORM') {
      throw new BadRequestException({
        code: 'INVALID_SCOPE',
        message: "Platform authority mutations require exact 'PLATFORM' scope.",
      });
    }

    if (
      command.expiresAt != null &&
      (!Number.isFinite(Date.parse(command.expiresAt)) ||
        Date.parse(command.expiresAt) <= Date.now())
    ) {
      throw new BadRequestException({
        code: 'INVALID_EXPIRATION',
        message: 'expiresAt must be a valid future timestamp.',
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
