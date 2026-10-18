import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PLATFORM_AUTHORITY_LEGACY_ADOPTION_REPOSITORY,
  type PlatformAuthorityLegacyAdoptionCommand,
  type PlatformAuthorityLegacyAdoptionPreflight,
  type PlatformAuthorityLegacyAdoptionRepository,
} from './platform-authority-legacy-adoption.repository';
import type { PlatformAuthorityChangeResult } from './platform-authority-change.types';
import { isPlatformAuthorityLegacyAdoptionTestEnvironment } from './platform-authority-legacy-adoption.policy';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

@Injectable()
export class PlatformAuthorityLegacyAdoptionService {
  constructor(
    @Inject(PLATFORM_AUTHORITY_LEGACY_ADOPTION_REPOSITORY)
    private readonly repository: PlatformAuthorityLegacyAdoptionRepository,
  ) {}

  async inspect(): Promise<PlatformAuthorityLegacyAdoptionPreflight> {
    this.assertTestOnlyEnvironment();
    return this.repository.inspect();
  }

  async adopt(
    input: PlatformAuthorityLegacyAdoptionCommand,
  ): Promise<PlatformAuthorityChangeResult> {
    this.assertTestOnlyEnvironment();
    const fields = input as unknown as Record<string, unknown>;
    const acceptedFields = new Set([
      'operationId',
      'actorUserId',
      'issuerUserId',
      'expectedCurrentSnapshotHash',
      'now',
    ]);
    if (Object.keys(fields).some((field) => !acceptedFields.has(field))) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_AUTHORITY_FIELD',
        message:
          'Legacy adoption accepts only a fixed operation, fixture principals, and a snapshot hash.',
      });
    }

    if (
      typeof input.operationId !== 'string' ||
      !UUID_PATTERN.test(input.operationId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_ID',
        message: 'operationId must be a UUID.',
      });
    }
    if (
      typeof input.expectedCurrentSnapshotHash !== 'string' ||
      !/^[a-f\d]{64}$/i.test(input.expectedCurrentSnapshotHash)
    ) {
      throw new BadRequestException({
        code: 'EXPECTED_SNAPSHOT_REQUIRED',
        message: 'A SHA-256 hash of the full current snapshot is required.',
      });
    }
    if (
      !OBJECT_ID_PATTERN.test(input.actorUserId) ||
      !OBJECT_ID_PATTERN.test(input.issuerUserId)
    ) {
      throw new BadRequestException({
        code: 'INVALID_PRINCIPAL_ID',
        message: 'Actor and issuer must be valid ObjectIds.',
      });
    }
    if (input.actorUserId.toLowerCase() === input.issuerUserId.toLowerCase()) {
      throw new ForbiddenException({
        code: 'TWO_PERSON_RULE_VIOLATION',
        message: 'The fixed actor and issuer fixtures must be distinct.',
      });
    }
    if (
      input.now !== undefined &&
      (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
    ) {
      throw new BadRequestException({
        code: 'INVALID_OPERATION_TIME',
        message: 'now must be a valid Date.',
      });
    }

    return this.repository.adopt({
      operationId: input.operationId.toLowerCase(),
      actorUserId: new Types.ObjectId(input.actorUserId).toHexString(),
      issuerUserId: new Types.ObjectId(input.issuerUserId).toHexString(),
      expectedCurrentSnapshotHash:
        input.expectedCurrentSnapshotHash.toLowerCase(),
      ...(input.now ? { now: input.now } : {}),
    });
  }

  private assertTestOnlyEnvironment(): void {
    if (!isPlatformAuthorityLegacyAdoptionTestEnvironment(process.env)) {
      throw new ForbiddenException({
        code: 'TEST_ONLY_ADOPTION_DISABLED',
        message:
          'Legacy adoption is restricted to an explicitly marked development/test environment.',
      });
    }
  }
}
