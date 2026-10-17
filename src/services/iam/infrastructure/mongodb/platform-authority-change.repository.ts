import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  InternalServerErrorException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type { PlatformAuthorityChangeRepository } from '../../application/platform/platform-authority-change.repository';
import {
  PLATFORM_A04_PERMISSIONS,
  PLATFORM_V1_PERMISSIONS,
  type PlatformPermission,
} from '../../application/authorization/authorization.policy';
import {
  PLATFORM_AUTHORITY_BUNDLES,
  hashAssignmentSnapshot,
  hashPayload,
  type PlatformAuthorityBundleVersion,
  type PlatformAuthorityAssignmentResult,
  type PlatformAuthorityChangeCommand,
  type PlatformAuthorityChangeResult,
  type PlatformAuthorityChangeResultBody,
  type PlatformAuthorityOperationType,
} from '../../application/platform/platform-authority-change.types';
import { IAM_PERSISTENCE } from '../persistence';

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
}

interface PlatformAuthorityAssignmentDocument {
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
  provenanceOperationId?: string;
}

interface PlatformAuthorityOperationDocument {
  _id: Types.ObjectId;
  operationId: string;
  payloadHash: string;
  actorUserId: Types.ObjectId;
  issuerUserId: Types.ObjectId;
  operationType: PlatformAuthorityOperationType;
  bundleVersion?: PlatformAuthorityBundleVersion;
  sourceOperationId?: string;
  targetUserId: Types.ObjectId;
  permissions: PlatformPermission[];
  scope: 'PLATFORM';
  auditEventId: string;
  status: 'COMMITTED';
  httpStatus: 200 | 201;
  resultBody: PlatformAuthorityChangeResultBody;
  committedAt: Date;
}

interface PlatformAuthorityChangeLockDocument {
  _id: Types.ObjectId;
  permission: string;
  scope: 'PLATFORM';
  version: number;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

@Injectable()
export class MongoPlatformAuthorityChangeRepository implements PlatformAuthorityChangeRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async execute(
    command: PlatformAuthorityChangeCommand,
  ): Promise<PlatformAuthorityChangeResult> {
    const conn = this.connectionOrThrow();
    let session: ClientSession | undefined;
    let result: PlatformAuthorityChangeResult | undefined;

    const throwLegacyConflict = (): never => {
      throw new ConflictException({
        code: 'LEGACY_ASSIGNMENT_CONFLICT',
        message:
          'The complete authority bundle lacks matching PO-AUTH-01 provenance.',
      });
    };

    try {
      session = await conn.startSession();
      const activeSession = session;
      const executeInSession = async (transactionSession: ClientSession) => {
        const now = command.now ?? new Date();
        const payloadHash = hashPayload(command);
        const targetUserId = new Types.ObjectId(command.targetUserId);
        const actorUserId = new Types.ObjectId(command.actorUserId);
        const issuerUserId = new Types.ObjectId(command.issuerUserId);

        const prior = await this.operations()
          .findOne({ operationId: command.operationId })
          .session(transactionSession)
          .lean()
          .exec();

        if (prior) {
          if (prior.payloadHash !== payloadHash) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'The operationId was already committed with a different payload.',
            });
          }
          result = {
            operationId: prior.operationId,
            status: 'COMMITTED',
            httpStatus: prior.httpStatus,
            replayed: true,
            body: prior.resultBody,
          };
          return;
        }

        const lock = await this.locks()
          .findOneAndUpdate(
            {
              permission: 'PLATFORM_OPERATOR_LIFECYCLE',
              scope: 'PLATFORM',
            },
            { $inc: { version: 1 } },
            { new: true, session: transactionSession },
          )
          .lean()
          .exec();
        if (!lock) {
          throw new ServiceUnavailableException({
            code: 'PLATFORM_AUTHORITY_LOCKS_UNAVAILABLE',
            message:
              'Platform authority changes are disabled until the lifecycle lock is provisioned.',
          });
        }

        const actor = await this.users()
          .findOne({ _id: actorUserId }, { _id: 1, status: 1 })
          .session(transactionSession)
          .lean()
          .exec();
        if (!actor || actor.status !== 'ACTIVE') {
          throw new ForbiddenException({
            code: 'ACTOR_INACTIVE',
            message: 'Executing actor account is inactive or not found.',
          });
        }

        const issuer = await this.users()
          .findOne({ _id: issuerUserId }, { _id: 1, status: 1 })
          .session(transactionSession)
          .lean()
          .exec();
        if (!issuer || issuer.status !== 'ACTIVE') {
          throw new ForbiddenException({
            code: 'ISSUER_INACTIVE',
            message: 'Authorizing issuer account is inactive or not found.',
          });
        }

        const target = await this.users()
          .findOne({ _id: targetUserId }, { _id: 1, status: 1 })
          .session(transactionSession)
          .lean()
          .exec();
        if (!target) {
          throw new NotFoundException({
            code: 'TARGET_USER_NOT_FOUND',
            message: 'Target user account not found.',
          });
        }
        if (command.operationType !== 'REVOKE' && target.status !== 'ACTIVE') {
          throw new ConflictException({
            code: 'TARGET_USER_INACTIVE',
            message:
              'Target user account must be ACTIVE to receive platform authority.',
          });
        }

        const permissions = [
          ...PLATFORM_AUTHORITY_BUNDLES[command.bundleVersion],
        ];
        const rows = await this.assignments()
          .find({
            subjectUserId: targetUserId,
            scope: 'PLATFORM',
          })
          .session(transactionSession)
          .exec();
        const currentSnapshotHash = hashAssignmentSnapshot(
          rows.map((row) => ({
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
          })),
        );
        if (
          currentSnapshotHash !==
          command.expectedCurrentSnapshotHash.toLowerCase()
        ) {
          throw new ConflictException({
            code: 'PLATFORM_AUTHORITY_STALE',
            message:
              'The platform authority assignment snapshot changed before this operation.',
          });
        }

        const rowsForPermissions = (
          expectedPermissions: readonly PlatformPermission[],
        ) => {
          const byPermission = new Map<
            string,
            PlatformAuthorityAssignmentDocument[]
          >();
          for (const row of rows) {
            const permissionRows = byPermission.get(row.permission) ?? [];
            permissionRows.push(row);
            byPermission.set(row.permission, permissionRows);
          }
          return expectedPermissions.length === rows.length &&
            expectedPermissions.every(
              (permission) => byPermission.get(permission)?.length === 1,
            )
            ? expectedPermissions.map(
                (permission) => byPermission.get(permission)![0],
              )
            : null;
        };
        const expectedCurrentPermissions =
          command.operationType === 'V1_EXPAND'
            ? PLATFORM_A04_PERMISSIONS
            : command.operationType === 'V2_EXPAND'
              ? PLATFORM_V1_PERMISSIONS
              : permissions;
        const expectedCurrentRows = rowsForPermissions(
          expectedCurrentPermissions,
        );
        if (rows.length > 0 && !expectedCurrentRows) throwLegacyConflict();
        if (rows.length === 0 && command.operationType !== 'BOOTSTRAP')
          throwLegacyConflict();
        const isCurrent = (row: PlatformAuthorityAssignmentDocument) =>
          row.status === 'ACTIVE' &&
          (row.expiresAt == null || row.expiresAt.getTime() > now.getTime());
        const allCurrent =
          expectedCurrentRows !== null && expectedCurrentRows.every(isCurrent);
        const allInactive =
          expectedCurrentRows !== null &&
          expectedCurrentRows.every((row) => {
            return (
              row.status === 'REVOKED' ||
              (row.status === 'ACTIVE' &&
                row.expiresAt != null &&
                row.expiresAt.getTime() <= now.getTime())
            );
          });
        const currentState =
          rows.length === 0
            ? 'ABSENT'
            : allCurrent
              ? 'ACTIVE'
              : allInactive
                ? 'REVOKED'
                : null;

        if (currentState === null) throwLegacyConflict();

        const assertSourceOperation = async (
          operationId: string,
          expectedVersion: PlatformAuthorityBundleVersion,
          sourcePermissions: readonly PlatformPermission[],
          allowedTypes: readonly PlatformAuthorityOperationType[],
        ): Promise<PlatformAuthorityOperationDocument> => {
          const source = await this.operations()
            .findOne({ operationId, targetUserId })
            .session(transactionSession)
            .lean()
            .exec();
          const sourceBody = source?.resultBody as
            Partial<PlatformAuthorityChangeResultBody> | undefined;
          const storedPermissions = source?.permissions ?? [];
          const storedVersion =
            source?.bundleVersion ??
            (storedPermissions.length === PLATFORM_A04_PERMISSIONS.length
              ? 'A04'
              : undefined);
          if (!source) {
            throw new ConflictException({
              code: 'LEGACY_ASSIGNMENT_CONFLICT',
              message:
                'The complete authority bundle lacks matching PO-AUTH-01 provenance.',
            });
          }
          if (!sourceBody) {
            throw new ConflictException({
              code: 'LEGACY_ASSIGNMENT_CONFLICT',
              message:
                'The complete authority bundle lacks matching PO-AUTH-01 provenance.',
            });
          }
          if (
            !allowedTypes.includes(source.operationType) ||
            source.status !== 'COMMITTED' ||
            source.scope !== 'PLATFORM' ||
            !source.auditEventId ||
            storedVersion !== expectedVersion ||
            storedPermissions.length !== sourcePermissions.length ||
            !sourcePermissions.every((permission) =>
              storedPermissions.includes(permission),
            ) ||
            sourceBody.operationId !== operationId ||
            sourceBody.targetUserId?.toLowerCase() !==
              targetUserId.toHexString() ||
            sourceBody.scope !== 'PLATFORM' ||
            sourceBody.status !== 'ACTIVE' ||
            !Array.isArray(sourceBody.assignments) ||
            sourceBody.assignments.length !== sourcePermissions.length ||
            sourceBody.assignments.some(
              (assignment) =>
                !assignment ||
                typeof assignment.assignmentId !== 'string' ||
                typeof assignment.permission !== 'string' ||
                assignment.status !== 'ACTIVE',
            )
          )
            throwLegacyConflict();
          return source;
        };

        const assertOwnedBundle = async (
          bundleRows: PlatformAuthorityAssignmentDocument[],
          bundleVersion: PlatformAuthorityBundleVersion,
        ) => {
          const bundlePermissions = PLATFORM_AUTHORITY_BUNDLES[bundleVersion];
          if (
            bundleRows.length !== bundlePermissions.length ||
            bundleRows.some((row) => !row.provenanceOperationId)
          )
            throwLegacyConflict();

          const provenanceIds = new Set(
            bundleRows.map((row) => row.provenanceOperationId!),
          );
          if (provenanceIds.size === 1) {
            const provenanceOperationId = [...provenanceIds][0];
            const source = await assertSourceOperation(
              provenanceOperationId,
              bundleVersion,
              bundlePermissions,
              ['BOOTSTRAP', 'REGRANT'],
            );
            const sourceAssignments = new Set(
              source.resultBody.assignments.map(
                (assignment) =>
                  `${assignment.permission}:${assignment.assignmentId.toLowerCase()}`,
              ),
            );
            if (
              bundleRows.some(
                (row) =>
                  !sourceAssignments.has(
                    `${row.permission}:${row._id.toHexString()}`,
                  ),
              )
            )
              throwLegacyConflict();
            return;
          }

          if (bundleVersion === 'V2') {
            const v1Rows = bundleRows.filter((row) =>
              PLATFORM_V1_PERMISSIONS.includes(row.permission as never),
            );
            const v2Rows = bundleRows.filter(
              (row) =>
                !PLATFORM_V1_PERMISSIONS.includes(row.permission as never),
            );
            if (
              v1Rows.length !== PLATFORM_V1_PERMISSIONS.length ||
              v2Rows.length !==
                bundlePermissions.length - PLATFORM_V1_PERMISSIONS.length ||
              new Set(v2Rows.map((row) => row.provenanceOperationId)).size !== 1
            )
              throwLegacyConflict();
            await assertOwnedBundle(v1Rows, 'V1');
            const sourceOperationId = v2Rows[0].provenanceOperationId!;
            const v1AnchorOperationId =
              v1Rows.find(
                (row) =>
                  !PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
              )?.provenanceOperationId ?? v1Rows[0].provenanceOperationId;
            if (!v1AnchorOperationId) throwLegacyConflict();
            const expansion = await assertSourceOperation(
              sourceOperationId,
              'V2',
              bundlePermissions,
              ['V2_EXPAND'],
            );
            if (
              expansion.sourceOperationId !== v1AnchorOperationId ||
              bundleRows.some(
                (row) =>
                  !expansion.resultBody.assignments.some(
                    (assignment) =>
                      assignment.assignmentId.toLowerCase() ===
                        row._id.toHexString() &&
                      assignment.permission === row.permission,
                  ),
              )
            )
              throwLegacyConflict();
            return;
          }

          if (bundleVersion !== 'V1' || provenanceIds.size !== 2)
            throwLegacyConflict();
          const expansionId = bundleRows.find(
            (row) =>
              row.provenanceOperationId &&
              !PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
          )?.provenanceOperationId;
          const legacyId = bundleRows.find((row) =>
            PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
          )?.provenanceOperationId;
          if (!expansionId || !legacyId || expansionId === legacyId)
            throwLegacyConflict();
          const validExpansionId = expansionId as string;
          const validLegacyId = legacyId as string;
          const legacyRows = bundleRows.filter((row) =>
            PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
          );
          const expandedRows = bundleRows.filter(
            (row) =>
              !PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
          );
          if (
            legacyRows.length !== PLATFORM_A04_PERMISSIONS.length ||
            expandedRows.length !==
              bundlePermissions.length - PLATFORM_A04_PERMISSIONS.length ||
            legacyRows.some((row) => row.provenanceOperationId !== legacyId) ||
            expandedRows.some(
              (row) => row.provenanceOperationId !== expansionId,
            )
          )
            throwLegacyConflict();
          await assertSourceOperation(
            validLegacyId,
            'A04',
            PLATFORM_A04_PERMISSIONS,
            ['BOOTSTRAP', 'REGRANT'],
          );
          const expansion = await assertSourceOperation(
            validExpansionId,
            'V1',
            bundlePermissions,
            ['V1_EXPAND'],
          );
          if (
            expansion.sourceOperationId !== validLegacyId ||
            bundleRows.some(
              (row) =>
                !expansion.resultBody.assignments.some(
                  (assignment) =>
                    assignment.assignmentId.toLowerCase() ===
                      row._id.toHexString() &&
                    assignment.permission === row.permission,
                ),
            )
          )
            throwLegacyConflict();
        };

        const httpStatus: 200 | 201 =
          command.operationType === 'BOOTSTRAP' ? 201 : 200;
        const committedStatus: PlatformAuthorityAssignmentResult['status'] =
          command.operationType === 'REVOKE' ? 'REVOKED' : 'ACTIVE';
        const previousStatuses = rows.map((row) => ({
          assignmentId: row._id.toHexString(),
          permission: row.permission,
          status: row.status,
        }));
        let assignments: PlatformAuthorityAssignmentDocument[];
        let sourceOperationId: string | undefined;

        if (command.operationType === 'V1_EXPAND') {
          if (currentState !== 'ACTIVE' || !expectedCurrentRows)
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message:
                'V1 expansion requires one complete active A-04 permission bundle.',
            });
          const activeLegacyRows = expectedCurrentRows;
          await assertOwnedBundle([...activeLegacyRows], 'A04');
          sourceOperationId = activeLegacyRows[0].provenanceOperationId;
          const v1OnlyPermissions = permissions.filter(
            (permission) =>
              !PLATFORM_A04_PERMISSIONS.includes(permission as never),
          );
          const newExpiresAt = command.expiresAt
            ? new Date(command.expiresAt)
            : null;
          const expandedAssignments = await this.assignments().create(
            v1OnlyPermissions.map((permission) => ({
              subjectUserId: targetUserId,
              permission,
              scope: 'PLATFORM' as const,
              status: 'ACTIVE' as const,
              grantedAt: now,
              grantedBy: issuerUserId,
              expiresAt: newExpiresAt,
              revokedAt: null,
              revokedBy: null,
              provenanceOperationId: command.operationId,
            })),
            { session: transactionSession, ordered: true },
          );
          assignments = [...activeLegacyRows, ...expandedAssignments];
        } else if (command.operationType === 'V2_EXPAND') {
          if (currentState !== 'ACTIVE' || !expectedCurrentRows)
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message:
                'V2 expansion requires one complete active V1 permission bundle.',
            });
          const activeV1Rows = expectedCurrentRows;
          await assertOwnedBundle([...activeV1Rows], 'V1');
          sourceOperationId =
            activeV1Rows.find(
              (row) =>
                !PLATFORM_A04_PERMISSIONS.includes(row.permission as never),
            )?.provenanceOperationId ?? activeV1Rows[0].provenanceOperationId;
          if (!sourceOperationId) throwLegacyConflict();
          const v2OnlyPermissions = permissions.filter(
            (permission) =>
              !PLATFORM_V1_PERMISSIONS.includes(permission as never),
          );
          const newExpiresAt = command.expiresAt
            ? new Date(command.expiresAt)
            : null;
          const expandedAssignments = await this.assignments().create(
            v2OnlyPermissions.map((permission) => ({
              subjectUserId: targetUserId,
              permission,
              scope: 'PLATFORM' as const,
              status: 'ACTIVE' as const,
              grantedAt: now,
              grantedBy: issuerUserId,
              expiresAt: newExpiresAt,
              revokedAt: null,
              revokedBy: null,
              provenanceOperationId: command.operationId,
            })),
            { session: transactionSession, ordered: true },
          );
          assignments = [...activeV1Rows, ...expandedAssignments];
        } else if (command.operationType === 'BOOTSTRAP') {
          if (rows.length > 0) {
            await assertOwnedBundle(rows, command.bundleVersion);
            if (currentState === 'ACTIVE') {
              throw new ConflictException({
                code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE',
                message:
                  'The complete platform authority bundle is already active.',
              });
            }
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message: 'Use REGRANT for an existing procedure-owned bundle.',
            });
          }
          const newExpiresAt = command.expiresAt
            ? new Date(command.expiresAt)
            : null;
          assignments = await this.assignments().create(
            permissions.map((permission) => ({
              subjectUserId: targetUserId,
              permission,
              scope: 'PLATFORM' as const,
              status: 'ACTIVE' as const,
              grantedAt: now,
              grantedBy: issuerUserId,
              expiresAt: newExpiresAt,
              revokedAt: null,
              revokedBy: null,
              provenanceOperationId: command.operationId,
            })),
            { session: transactionSession, ordered: true },
          );
        } else if (command.operationType === 'REGRANT') {
          if (!expectedCurrentRows) throwLegacyConflict();
          await assertOwnedBundle(
            expectedCurrentRows as PlatformAuthorityAssignmentDocument[],
            command.bundleVersion,
          );
          if (currentState === 'ACTIVE') {
            throw new ConflictException({
              code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE',
              message:
                'The complete platform authority bundle is already active.',
            });
          }
          const newExpiresAt = command.expiresAt
            ? new Date(command.expiresAt)
            : null;
          assignments = rows;
          const update = await this.assignments().updateMany(
            {
              _id: { $in: rows.map((assignment) => assignment._id) },
              subjectUserId: targetUserId,
              scope: 'PLATFORM',
              $or: [
                { status: 'REVOKED' },
                { status: 'ACTIVE', expiresAt: { $lte: now } },
              ],
            },
            {
              $set: {
                status: 'ACTIVE',
                grantedAt: now,
                grantedBy: issuerUserId,
                expiresAt: newExpiresAt,
                revokedAt: null,
                revokedBy: null,
                provenanceOperationId: command.operationId,
              },
            },
            { session: transactionSession },
          );
          if (update.modifiedCount !== rows.length) {
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message:
                'The complete permission bundle changed before it could be regranted.',
            });
          }
          for (const assignment of assignments) {
            assignment.status = 'ACTIVE';
            assignment.grantedAt = now;
            assignment.grantedBy = issuerUserId;
            assignment.expiresAt = newExpiresAt;
            assignment.revokedAt = null;
            assignment.revokedBy = null;
            assignment.provenanceOperationId = command.operationId;
          }
        } else {
          if (!expectedCurrentRows) throwLegacyConflict();
          await assertOwnedBundle(
            expectedCurrentRows as PlatformAuthorityAssignmentDocument[],
            command.bundleVersion,
          );
          if (rows.every((row) => row.status === 'REVOKED')) {
            throw new ConflictException({
              code: 'PLATFORM_AUTHORITY_ALREADY_REVOKED',
              message:
                'The complete platform authority bundle is already revoked.',
            });
          }
          if (rows.some((row) => row.status === 'REVOKED')) {
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message:
                'The complete platform authority bundle is partially revoked.',
            });
          }

          const activeAssignments = await this.assignments()
            .find({
              permission: { $in: permissions },
              scope: 'PLATFORM',
              status: 'ACTIVE',
              $or: [
                { expiresAt: { $exists: false } },
                { expiresAt: null },
                { expiresAt: { $gt: now } },
              ],
            })
            .select({ subjectUserId: 1, permission: 1 })
            .session(transactionSession)
            .lean()
            .exec();
          const permissionsBySubject = new Map<string, Set<string>>();
          for (const assignment of activeAssignments) {
            const subjectId = assignment.subjectUserId.toHexString();
            const subjectPermissions =
              permissionsBySubject.get(subjectId) ?? new Set<string>();
            subjectPermissions.add(assignment.permission);
            permissionsBySubject.set(subjectId, subjectPermissions);
          }
          const otherBundleIds = [...permissionsBySubject.entries()]
            .filter(
              ([subjectId, subjectPermissions]) =>
                subjectId !== targetUserId.toHexString() &&
                permissions.every((permission) =>
                  subjectPermissions.has(permission),
                ),
            )
            .map(([subjectId]) => new Types.ObjectId(subjectId));
          const otherActiveOperators = otherBundleIds.length
            ? await this.users()
                .countDocuments({
                  _id: { $in: otherBundleIds },
                  status: 'ACTIVE',
                })
                .session(transactionSession)
            : 0;
          if (otherActiveOperators < 1) {
            throw new ConflictException({
              code: 'LAST_OPERATOR_REQUIRED',
              message:
                'Revocation must leave another ACTIVE user with the complete current, unexpired permission bundle.',
            });
          }

          assignments = rows;
          const update = await this.assignments().updateMany(
            {
              _id: { $in: rows.map((assignment) => assignment._id) },
              subjectUserId: targetUserId,
              scope: 'PLATFORM',
              status: 'ACTIVE',
              $or: [
                { expiresAt: { $exists: false } },
                { expiresAt: null },
                { expiresAt: { $gt: now } },
              ],
            },
            {
              $set: {
                status: 'REVOKED',
                revokedAt: now,
                revokedBy: actorUserId,
              },
            },
            { session: transactionSession },
          );
          if (update.modifiedCount !== rows.length) {
            throw new ConflictException({
              code: 'AUTHORITY_STATE_CONFLICT',
              message:
                'The complete permission bundle changed before it could be revoked.',
            });
          }
          for (const assignment of assignments) {
            assignment.status = 'REVOKED';
            assignment.revokedAt = now;
            assignment.revokedBy = actorUserId;
          }
        }

        const assignmentResults = assignments
          .map((assignment) => ({
            assignmentId: assignment._id.toHexString(),
            permission: assignment.permission as PlatformPermission,
            status: committedStatus,
            ...(committedStatus === 'ACTIVE'
              ? {
                  grantedBy: command.issuerUserId,
                  grantedAt: now.toISOString(),
                  expiresAt: command.expiresAt ?? null,
                }
              : {
                  revokedBy: command.actorUserId,
                  revokedAt: now.toISOString(),
                }),
          }))
          .sort((left, right) =>
            left.permission.localeCompare(right.permission),
          );
        const body: PlatformAuthorityChangeResultBody = {
          operationId: command.operationId,
          targetUserId: command.targetUserId,
          scope: 'PLATFORM',
          status: committedStatus,
          assignments: assignmentResults,
        };

        const auditEventId = randomUUID();
        await this.operations().create(
          [
            {
              operationId: command.operationId,
              payloadHash,
              actorUserId,
              issuerUserId,
              operationType: command.operationType,
              bundleVersion: command.bundleVersion,
              ...(sourceOperationId ? { sourceOperationId } : {}),
              targetUserId,
              permissions,
              scope: 'PLATFORM',
              auditEventId,
              status: 'COMMITTED',
              httpStatus,
              resultBody: body,
              committedAt: now,
            },
          ],
          { session: transactionSession, ordered: true },
        );

        await conn
          .useDb(this.auditDatabaseName, { useCache: true })
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .insertOne(
            {
              eventId: auditEventId,
              schemaVersion: 2,
              operationId: command.operationId,
              actorUserId: command.actorUserId,
              issuerUserId: command.issuerUserId,
              action:
                command.operationType === 'REVOKE'
                  ? 'platform.authority.revoked'
                  : 'platform.authority.granted',
              targetResource: 'PLATFORM_AUTHORITY',
              targetResourceId: command.targetUserId,
              targetUserId: command.targetUserId,
              permissions,
              assignmentIds: assignmentResults.map(
                (assignment) => assignment.assignmentId,
              ),
              scope: 'PLATFORM',
              metadata: {
                before: previousStatuses,
                after: assignmentResults.map((assignment) => ({
                  assignmentId: assignment.assignmentId,
                  permission: assignment.permission,
                  status: assignment.status,
                })),
                reasonCode: command.reasonCode,
              },
              occurredAt: now,
            },
            { session: transactionSession },
          );

        result = {
          operationId: command.operationId,
          status: 'COMMITTED',
          httpStatus,
          replayed: false,
          body,
        };
      };

      await activeSession.withTransaction(
        async () => executeInSession(activeSession),
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } catch (error) {
      if (isDuplicateKey(error)) {
        const payloadHash = hashPayload(command);
        let prior: PlatformAuthorityOperationDocument | null;
        try {
          prior = await this.operations()
            .findOne({ operationId: command.operationId })
            .lean()
            .exec();
        } catch (lookupError) {
          if (lookupError instanceof HttpException) throw lookupError;
          throw new InternalServerErrorException({
            code: 'PLATFORM_AUTHORITY_MUTATION_FAILED',
            message: 'Platform authority mutation failed.',
          });
        }
        if (prior) {
          if (prior.payloadHash !== payloadHash) {
            throw new ConflictException({
              code: 'IDEMPOTENCY_KEY_REUSED',
              message:
                'The operationId was already committed with a different payload.',
            });
          }
          return {
            operationId: prior.operationId,
            status: 'COMMITTED',
            httpStatus: prior.httpStatus,
            replayed: true,
            body: prior.resultBody,
          };
        }
        throw new ConflictException({
          code: 'AUTHORITY_STATE_CONFLICT',
          message:
            'A conflicting platform authority lifecycle operation was committed.',
        });
      }
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_AUTHORITY_MUTATION_FAILED',
        message: 'Platform authority mutation failed.',
      });
    } finally {
      if (session) await session.endSession();
    }

    if (!result) {
      throw new Error(
        'Platform authority change transaction completed with no result',
      );
    }
    return result;
  }

  private users(): Model<UserDocument> {
    return this.model<UserDocument>('users');
  }

  private assignments(): Model<PlatformAuthorityAssignmentDocument> {
    return this.model<PlatformAuthorityAssignmentDocument>(
      'platform_authority_assignments',
    );
  }

  private operations(): Model<PlatformAuthorityOperationDocument> {
    return this.model<PlatformAuthorityOperationDocument>(
      'platform_authority_change_operations',
    );
  }

  private locks(): Model<PlatformAuthorityChangeLockDocument> {
    return this.model<PlatformAuthorityChangeLockDocument>(
      'platform_authority_change_locks',
    );
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
    if (!this.connection) {
      throw new ServiceUnavailableException({
        code: 'IAM_PERSISTENCE_UNAVAILABLE',
        message: 'Mongoose connection is unavailable.',
      });
    }
    return this.connection;
  }
}
