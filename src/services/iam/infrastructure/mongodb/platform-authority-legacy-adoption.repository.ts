import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  PlatformAuthorityLegacyAdoptionCommand,
  PlatformAuthorityLegacyAdoptionPreflight,
  PlatformAuthorityLegacyAdoptionRepository,
} from '../../application/platform/platform-authority-legacy-adoption.repository';
import { isPlatformAuthorityLegacyAdoptionTestEnvironment } from '../../application/platform/platform-authority-legacy-adoption.policy';
import {
  PLATFORM_AUTHORITY_BUNDLES,
  hashAssignmentSnapshot,
  type PlatformAuthorityAssignmentResult,
  type PlatformAuthorityChangeResult,
  type PlatformAuthorityChangeResultBody,
  type PlatformAuthoritySnapshotRow,
} from '../../application/platform/platform-authority-change.types';
import {
  PLATFORM_V1_PERMISSIONS,
  type PlatformPermission,
} from '../../application/authorization/authorization.policy';
import { IAM_PERSISTENCE } from '../persistence';

export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL =
  'operator@continuum.test';
export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_ACTOR_EMAIL =
  'admin@datn-dev.example.test';
export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_ISSUER_EMAIL =
  'member@datn-dev.example.test';
export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE =
  'LEGACY_ADOPT_V2' as const;
export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_IAM_DATABASE =
  IAM_PERSISTENCE.databaseName;
export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_AUDIT_DATABASE =
  AUDIT_DATABASE_NAME;

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
}

interface AssignmentDocument {
  _id: Types.ObjectId;
  subjectUserId: Types.ObjectId;
  permission: string;
  scope: 'PLATFORM';
  status: 'ACTIVE' | 'REVOKED';
  grantedAt: Date;
  grantedBy: Types.ObjectId;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  revokedBy?: Types.ObjectId | null;
  provenanceOperationId?: string | null;
}

interface OperationDocument {
  operationId: string;
  payloadHash: string;
  actorUserId: Types.ObjectId;
  issuerUserId: Types.ObjectId;
  operationType: 'LEGACY_ADOPT_V2';
  bundleVersion: 'V2';
  targetUserId: Types.ObjectId;
  permissions: PlatformPermission[];
  scope: 'PLATFORM';
  auditEventId: string;
  status: 'COMMITTED';
  httpStatus: 200;
  resultBody: PlatformAuthorityChangeResultBody;
  committedAt: Date;
}

interface LockDocument {
  permission: string;
  scope: 'PLATFORM';
  version: number;
}

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

function toSnapshot(
  rows: readonly AssignmentDocument[],
): PlatformAuthoritySnapshotRow[] {
  return rows.map((row) => ({
    assignmentId: row._id.toHexString(),
    permission: row.permission,
    scope: row.scope,
    status: row.status,
    grantedAt: row.grantedAt,
    grantedBy: row.grantedBy.toHexString(),
    expiresAt: row.expiresAt ?? null,
    revokedAt: row.revokedAt ?? null,
    revokedBy: row.revokedBy?.toHexString() ?? null,
    provenanceOperationId: row.provenanceOperationId ?? null,
  }));
}

function hasExpectedLegacyV1Assignments(
  rows: readonly AssignmentDocument[],
  now: Date,
): boolean {
  if (
    rows.length !== PLATFORM_V1_PERMISSIONS.length ||
    new Set(rows.map((row) => row.permission)).size !==
      PLATFORM_V1_PERMISSIONS.length ||
    !PLATFORM_V1_PERMISSIONS.every((permission) =>
      rows.some((row) => row.permission === permission),
    )
  ) {
    return false;
  }

  const expiryValues = new Set<string>();
  for (const row of rows) {
    if (
      row.scope !== 'PLATFORM' ||
      row.status !== 'ACTIVE' ||
      row.provenanceOperationId != null ||
      !(row.grantedAt instanceof Date) ||
      !Number.isFinite(row.grantedAt.getTime()) ||
      !(row.grantedBy instanceof Types.ObjectId) ||
      row.revokedAt != null ||
      row.revokedBy != null ||
      (row.expiresAt != null &&
        (!(row.expiresAt instanceof Date) ||
          !Number.isFinite(row.expiresAt.getTime()) ||
          row.expiresAt.getTime() <= now.getTime()))
    ) {
      return false;
    }
    expiryValues.add(row.expiresAt?.toISOString() ?? 'NEVER');
  }
  return expiryValues.size === 1;
}

function adoptionPayloadHash(
  command: PlatformAuthorityLegacyAdoptionCommand,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        actorUserId: command.actorUserId.toLowerCase(),
        bundleVersion: 'V2',
        expectedCurrentSnapshotHash:
          command.expectedCurrentSnapshotHash.toLowerCase(),
        issuerUserId: command.issuerUserId.toLowerCase(),
        operationType: PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE,
        permissions: [...PLATFORM_AUTHORITY_BUNDLES.V2],
        scope: 'PLATFORM',
        status: 'ACTIVE',
        targetEmail: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
      }),
    )
    .digest('hex');
}

@Injectable()
export class MongoPlatformAuthorityLegacyAdoptionRepository implements PlatformAuthorityLegacyAdoptionRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async inspect(): Promise<PlatformAuthorityLegacyAdoptionPreflight> {
    this.connectionOrThrow();
    await this.assertRequiredStorage();
    const now = new Date();
    const [targets, actors, issuers] = await Promise.all([
      this.users()
        .find({ email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL })
        .limit(2)
        .lean()
        .exec(),
      this.users()
        .find({ email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_ACTOR_EMAIL })
        .limit(2)
        .lean()
        .exec(),
      this.users()
        .find({ email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_ISSUER_EMAIL })
        .limit(2)
        .lean()
        .exec(),
    ]);
    const target = targets.length === 1 ? targets[0] : null;
    const actor = actors.length === 1 ? actors[0] : null;
    const issuer = issuers.length === 1 ? issuers[0] : null;
    const blockers: string[] = [];

    if (!target)
      blockers.push(targets.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND');
    if (!actor)
      blockers.push(actors.length ? 'ACTOR_AMBIGUOUS' : 'ACTOR_NOT_FOUND');
    if (!issuer)
      blockers.push(issuers.length ? 'ISSUER_AMBIGUOUS' : 'ISSUER_NOT_FOUND');
    if (target && target.status !== 'ACTIVE') blockers.push('TARGET_INACTIVE');
    if (actor && actor.status !== 'ACTIVE') blockers.push('ACTOR_INACTIVE');
    if (issuer && issuer.status !== 'ACTIVE') blockers.push('ISSUER_INACTIVE');
    if (
      target &&
      actor &&
      issuer &&
      (target._id.equals(actor._id) || target._id.equals(issuer._id))
    ) {
      blockers.push('SELF_GRANT_PROHIBITED');
    }
    if (actor && issuer && actor._id.equals(issuer._id)) {
      blockers.push('TWO_PERSON_RULE_VIOLATION');
    }

    const rows = target
      ? await this.assignments()
          .find({ subjectUserId: target._id, scope: 'PLATFORM' })
          .sort({ permission: 1, _id: 1 })
          .lean()
          .exec()
      : [];
    if (target && !hasExpectedLegacyV1Assignments(rows, now)) {
      blockers.push('LEGACY_V1_ASSIGNMENT_CONFLICT');
    }
    const priorOperations = target
      ? await this.operations()
          .countDocuments({ targetUserId: target._id })
          .exec()
      : 0;
    if (priorOperations > 0) blockers.push('TARGET_OPERATION_HISTORY_EXISTS');

    const lifecycleLock = await this.locks()
      .findOne({
        permission: 'PLATFORM_OPERATOR_LIFECYCLE',
        scope: 'PLATFORM',
      })
      .lean()
      .exec();
    if (!lifecycleLock) blockers.push('PLATFORM_AUTHORITY_LOCKS_UNAVAILABLE');

    return {
      targetEmail: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL,
      targetUserId: target?._id.toHexString() ?? null,
      targetStatus: target?.status ?? null,
      actorUserId: actor?._id.toHexString() ?? null,
      actorStatus: actor?.status ?? null,
      issuerUserId: issuer?._id.toHexString() ?? null,
      issuerStatus: issuer?.status ?? null,
      assignmentCount: rows.length,
      expectedCurrentSnapshotHash: target
        ? hashAssignmentSnapshot(toSnapshot(rows))
        : null,
      ready: blockers.length === 0,
      blockers,
    };
  }

  async adopt(
    command: PlatformAuthorityLegacyAdoptionCommand,
  ): Promise<PlatformAuthorityChangeResult> {
    const conn = this.connectionOrThrow();
    await this.assertRequiredStorage();
    let session: ClientSession | undefined;
    let result: PlatformAuthorityChangeResult | undefined;
    const payloadHash = adoptionPayloadHash(command);

    try {
      session = await conn.startSession();
      const activeSession = session;
      await activeSession.withTransaction(
        async () => {
          const now = command.now ?? new Date();
          const actorUserId = new Types.ObjectId(command.actorUserId);
          const issuerUserId = new Types.ObjectId(command.issuerUserId);
          const prior = await this.operations()
            .findOne({ operationId: command.operationId })
            .session(activeSession)
            .lean()
            .exec();
          if (prior) {
            if (
              prior.operationType !==
                PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE ||
              prior.payloadHash !== payloadHash
            ) {
              throw conflict(
                'IDEMPOTENCY_KEY_REUSED',
                'The operationId was already committed with a different payload.',
              );
            }
            result = {
              operationId: prior.operationId,
              status: 'COMMITTED',
              httpStatus: 200,
              replayed: true,
              body: prior.resultBody,
            };
            return;
          }

          const lifecycleLock = await this.locks()
            .findOneAndUpdate(
              {
                permission: 'PLATFORM_OPERATOR_LIFECYCLE',
                scope: 'PLATFORM',
              },
              { $inc: { version: 1 } },
              { new: true, session: activeSession },
            )
            .lean()
            .exec();
          if (!lifecycleLock) {
            throw new ServiceUnavailableException({
              code: 'PLATFORM_AUTHORITY_LOCKS_UNAVAILABLE',
              message:
                'Platform authority changes are disabled until the lifecycle lock is provisioned.',
            });
          }

          const target = await this.users()
            .findOne({ email: PLATFORM_AUTHORITY_LEGACY_ADOPTION_TARGET_EMAIL })
            .session(activeSession)
            .lean()
            .exec();
          if (!target) {
            throw new NotFoundException({
              code: 'TARGET_USER_NOT_FOUND',
              message: 'The fixed test operator target does not exist.',
            });
          }
          if (target.status !== 'ACTIVE') {
            throw conflict(
              'TARGET_USER_INACTIVE',
              'The fixed test operator target must be ACTIVE.',
            );
          }
          if (
            target._id.equals(actorUserId) ||
            target._id.equals(issuerUserId)
          ) {
            throw new ForbiddenException({
              code: 'SELF_GRANT_PROHIBITED',
              message: 'The target must be distinct from actor and issuer.',
            });
          }

          const actor = await this.users()
            .findOne({ _id: actorUserId })
            .session(activeSession)
            .lean()
            .exec();
          if (
            !actor ||
            actor.email !== PLATFORM_AUTHORITY_LEGACY_ADOPTION_ACTOR_EMAIL ||
            actor.status !== 'ACTIVE'
          ) {
            throw new ForbiddenException({
              code: 'ACTOR_INACTIVE',
              message: 'The fixed test actor fixture is missing or inactive.',
            });
          }
          const issuer = await this.users()
            .findOne({ _id: issuerUserId })
            .session(activeSession)
            .lean()
            .exec();
          if (
            !issuer ||
            issuer.email !== PLATFORM_AUTHORITY_LEGACY_ADOPTION_ISSUER_EMAIL ||
            issuer.status !== 'ACTIVE'
          ) {
            throw new ForbiddenException({
              code: 'ISSUER_INACTIVE',
              message: 'The fixed test issuer fixture is missing or inactive.',
            });
          }
          if (actor._id.equals(issuer._id)) {
            throw new ForbiddenException({
              code: 'TWO_PERSON_RULE_VIOLATION',
              message: 'The executing actor and issuer must be distinct.',
            });
          }

          const existingOperation = await this.operations()
            .findOne({ targetUserId: target._id })
            .session(activeSession)
            .lean()
            .exec();
          if (existingOperation) {
            throw conflict(
              'TARGET_OPERATION_HISTORY_EXISTS',
              'Legacy adoption requires an explicit target with no existing authority operation history.',
            );
          }

          const rows = await this.assignments()
            .find({ subjectUserId: target._id, scope: 'PLATFORM' })
            .session(activeSession)
            .exec();
          const currentHash = hashAssignmentSnapshot(toSnapshot(rows));
          if (
            currentHash !== command.expectedCurrentSnapshotHash.toLowerCase()
          ) {
            throw conflict(
              'PLATFORM_AUTHORITY_STALE',
              'The platform authority assignment snapshot changed before adoption.',
            );
          }
          if (!hasExpectedLegacyV1Assignments(rows, now)) {
            throw conflict(
              'LEGACY_ASSIGNMENT_CONFLICT',
              'Adoption requires one complete, active V1 bundle with no provenance.',
            );
          }

          const legacyAssignmentIds = rows.map((row) => row._id);
          const stamped = await this.assignments()
            .updateMany(
              {
                _id: { $in: legacyAssignmentIds },
                subjectUserId: target._id,
                scope: 'PLATFORM',
                status: 'ACTIVE',
                $or: [
                  { provenanceOperationId: { $exists: false } },
                  { provenanceOperationId: null },
                ],
              },
              { $set: { provenanceOperationId: command.operationId } },
              { session: activeSession },
            )
            .exec();
          if (stamped.modifiedCount !== PLATFORM_V1_PERMISSIONS.length) {
            throw conflict(
              'PLATFORM_AUTHORITY_STALE',
              'The legacy V1 rows changed while adoption was being applied.',
            );
          }

          const expiry = rows[0].expiresAt ?? null;
          const v2OnlyPermissions = PLATFORM_AUTHORITY_BUNDLES.V2.filter(
            (permission) =>
              !PLATFORM_V1_PERMISSIONS.includes(permission as never),
          );
          const created = await this.assignments().create(
            v2OnlyPermissions.map((permission) => ({
              subjectUserId: target._id,
              permission,
              scope: 'PLATFORM' as const,
              status: 'ACTIVE' as const,
              grantedAt: now,
              grantedBy: issuerUserId,
              expiresAt: expiry,
              revokedAt: null,
              revokedBy: null,
              provenanceOperationId: command.operationId,
            })),
            { session: activeSession, ordered: true },
          );

          const existingRowsAfterAdoption = rows.map((row) => ({
            ...row.toObject(),
            provenanceOperationId: command.operationId,
          }));
          const allAssignments = [...existingRowsAfterAdoption, ...created];
          const assignmentResults: PlatformAuthorityAssignmentResult[] =
            allAssignments
              .map((row) => ({
                assignmentId: row._id.toHexString(),
                permission: row.permission as PlatformPermission,
                status: 'ACTIVE' as const,
                grantedBy: row.grantedBy.toHexString(),
                grantedAt: row.grantedAt.toISOString(),
                expiresAt: row.expiresAt?.toISOString() ?? null,
              }))
              .sort((left, right) =>
                left.permission.localeCompare(right.permission),
              );
          const body: PlatformAuthorityChangeResultBody = {
            operationId: command.operationId,
            targetUserId: target._id.toHexString(),
            scope: 'PLATFORM',
            status: 'ACTIVE',
            assignments: assignmentResults,
          };
          const auditEventId = randomUUID();
          const permissions = [...PLATFORM_AUTHORITY_BUNDLES.V2];

          await this.operations().create(
            [
              {
                operationId: command.operationId,
                payloadHash,
                actorUserId,
                issuerUserId,
                operationType:
                  PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE,
                bundleVersion: 'V2',
                targetUserId: target._id,
                permissions,
                scope: 'PLATFORM',
                auditEventId,
                status: 'COMMITTED',
                httpStatus: 200,
                resultBody: body,
                committedAt: now,
              },
            ],
            { session: activeSession, ordered: true },
          );

          await conn
            .useDb(PLATFORM_AUTHORITY_LEGACY_ADOPTION_AUDIT_DATABASE, {
              useCache: true,
            })
            .collection(IAM_AUDIT_COLLECTION_NAME)
            .insertOne(
              {
                eventId: auditEventId,
                schemaVersion: 2,
                operationId: command.operationId,
                actorUserId: actorUserId.toHexString(),
                issuerUserId: issuerUserId.toHexString(),
                action: 'platform.authority.legacy-adopted',
                targetResource: 'PLATFORM_AUTHORITY',
                targetResourceId: target._id.toHexString(),
                targetUserId: target._id.toHexString(),
                permissions,
                assignmentIds: assignmentResults.map(
                  (assignment) => assignment.assignmentId,
                ),
                scope: 'PLATFORM',
                metadata: {
                  adoptionType: 'LEGACY_V1_TO_V2',
                  reasonCode: 'TEST_ONLY_LEGACY_V1_ADOPTION',
                  adoptedLegacyAssignmentIds: rows.map((row) =>
                    row._id.toHexString(),
                  ),
                  createdV2AssignmentIds: created.map((row) =>
                    row._id.toHexString(),
                  ),
                  before: rows.map((row) => ({
                    assignmentId: row._id.toHexString(),
                    permission: row.permission,
                    status: row.status,
                    provenanceOperationId: row.provenanceOperationId ?? null,
                  })),
                  after: assignmentResults.map((assignment) => ({
                    assignmentId: assignment.assignmentId,
                    permission: assignment.permission,
                    status: assignment.status,
                    provenanceOperationId: command.operationId,
                  })),
                },
                occurredAt: now,
              },
              { session: activeSession },
            );

          result = {
            operationId: command.operationId,
            status: 'COMMITTED',
            httpStatus: 200,
            replayed: false,
            body,
          };
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        const prior = await this.operations()
          .findOne({ operationId: command.operationId })
          .lean()
          .exec();
        if (prior) {
          if (
            prior.operationType !==
              PLATFORM_AUTHORITY_LEGACY_ADOPTION_OPERATION_TYPE ||
            prior.payloadHash !== payloadHash
          ) {
            throw conflict(
              'IDEMPOTENCY_KEY_REUSED',
              'The operationId was already committed with a different payload.',
            );
          }
          return {
            operationId: prior.operationId,
            status: 'COMMITTED',
            httpStatus: 200,
            replayed: true,
            body: prior.resultBody,
          };
        }
        throw conflict(
          'AUTHORITY_STATE_CONFLICT',
          'A conflicting platform authority lifecycle operation was committed.',
        );
      }
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_AUTHORITY_MUTATION_FAILED',
        message: 'Platform authority adoption failed.',
      });
    } finally {
      if (session) await session.endSession();
    }

    if (!result) {
      throw new Error('Platform authority adoption completed with no result');
    }
    return result;
  }

  private users(): Model<UserDocument> {
    return this.model<UserDocument>('users');
  }

  private assignments(): Model<AssignmentDocument> {
    return this.model<AssignmentDocument>('platform_authority_assignments');
  }

  private operations(): Model<OperationDocument> {
    return this.model<OperationDocument>(
      'platform_authority_change_operations',
    );
  }

  private locks(): Model<LockDocument> {
    return this.model<LockDocument>('platform_authority_change_locks');
  }

  private async assertRequiredStorage(): Promise<void> {
    const conn = this.connectionOrThrow();
    const iamDatabase = conn.db;
    const auditDatabase = conn.useDb(
      PLATFORM_AUTHORITY_LEGACY_ADOPTION_AUDIT_DATABASE,
      { useCache: true },
    ).db;
    if (!iamDatabase || !auditDatabase) {
      throw new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_STORAGE_UNAVAILABLE',
        message: 'The fixed IAM and audit database handles are unavailable.',
      });
    }
    const requiredIamCollections = [
      'users',
      'platform_authority_assignments',
      'platform_authority_change_operations',
      'platform_authority_change_locks',
    ];
    const iamCollectionsValue: unknown = await iamDatabase
      .listCollections({}, { nameOnly: true })
      .toArray();
    const iamCollectionList = iamCollectionsValue as Array<{ name: string }>;
    const iamCollections = new Set(
      iamCollectionList.map((collection) => collection.name),
    );
    const auditCollectionsValue: unknown = await auditDatabase
      .listCollections({}, { nameOnly: true })
      .toArray();
    const auditCollectionList = auditCollectionsValue as Array<{
      name: string;
    }>;
    const auditCollections = new Set(
      auditCollectionList.map((collection) => collection.name),
    );
    if (
      requiredIamCollections.some((name) => !iamCollections.has(name)) ||
      !auditCollections.has(IAM_AUDIT_COLLECTION_NAME)
    ) {
      throw new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_STORAGE_UNAVAILABLE',
        message:
          'The required fixed IAM and audit collections must already exist.',
      });
    }

    const requiredUniqueIndexes: Array<{
      collectionName: string;
      fields: Record<string, 1 | -1>;
    }> = [
      {
        collectionName: 'users',
        fields: { email: 1 },
      },
      {
        collectionName: 'platform_authority_assignments',
        fields: { subjectUserId: 1, permission: 1, scope: 1 },
      },
      {
        collectionName: 'platform_authority_change_operations',
        fields: { operationId: 1 },
      },
      {
        collectionName: 'platform_authority_change_locks',
        fields: { permission: 1, scope: 1 },
      },
    ];
    for (const required of requiredUniqueIndexes) {
      const indexesValue: unknown = await iamDatabase
        .collection(required.collectionName)
        .listIndexes()
        .toArray();
      const indexes = indexesValue as Array<{
        unique?: boolean;
        key: Record<string, 1 | -1>;
      }>;
      const hasUniqueIndex = indexes.some(
        (index) =>
          index.unique === true &&
          JSON.stringify(Object.entries(index.key)) ===
            JSON.stringify(Object.entries(required.fields)),
      );
      if (!hasUniqueIndex) {
        throw new ServiceUnavailableException({
          code: 'PLATFORM_AUTHORITY_STORAGE_UNAVAILABLE',
          message: 'A required unique IAM authority index is not provisioned.',
        });
      }
    }
  }

  private model<T>(name: string): Model<T> {
    const model = this.connectionOrThrow().models[modelName(name)] as
      Model<T> | undefined;
    if (!model) {
      throw new ServiceUnavailableException({
        code: 'IAM_PERSISTENCE_UNAVAILABLE',
        message: `Model ${name} is unavailable.`,
      });
    }
    return model;
  }

  private connectionOrThrow(): Connection {
    if (!isPlatformAuthorityLegacyAdoptionTestEnvironment(process.env)) {
      throw new ForbiddenException({
        code: 'TEST_ONLY_ADOPTION_DISABLED',
        message:
          'Legacy adoption is restricted to an explicitly marked development/test environment.',
      });
    }
    if (!this.connection) {
      throw new ServiceUnavailableException({
        code: 'IAM_PERSISTENCE_UNAVAILABLE',
        message: 'Mongoose connection is unavailable.',
      });
    }
    if (
      this.connection.db?.databaseName !==
        PLATFORM_AUTHORITY_LEGACY_ADOPTION_IAM_DATABASE ||
      this.auditDatabaseName !==
        PLATFORM_AUTHORITY_LEGACY_ADOPTION_AUDIT_DATABASE ||
      IAM_PERSISTENCE.databaseName !==
        PLATFORM_AUTHORITY_LEGACY_ADOPTION_IAM_DATABASE
    ) {
      throw new ForbiddenException({
        code: 'UNAPPROVED_DATABASE',
        message:
          'Platform authority adoption is restricted to the fixed IAM and audit databases.',
      });
    }
    return this.connection;
  }
}
