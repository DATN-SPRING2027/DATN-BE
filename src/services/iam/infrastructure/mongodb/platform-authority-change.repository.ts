import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
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
  hashPayload,
  type PlatformAuthorityChangeCommand,
  type PlatformAuthorityChangeResult,
  type PlatformAuthorityChangeResultBody,
} from '../../application/platform/platform-authority-change.types';
import { IAM_PERSISTENCE } from '../persistence';

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
  twoFactorEnabled?: boolean;
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
}

interface PlatformAuthorityOperationDocument {
  _id: Types.ObjectId;
  operationId: string;
  payloadHash: string;
  actorUserId: Types.ObjectId;
  issuerUserId: Types.ObjectId;
  operationType: 'GRANT' | 'REVOKE';
  targetUserId: Types.ObjectId;
  permission: string;
  scope: 'PLATFORM';
  auditEventId: string;
  status: 'COMMITTED';
  httpStatus: 200 | 201;
  resultBody: PlatformAuthorityChangeResultBody;
  committedAt: Date;
  expiresAt: Date;
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
    callerSession?: ClientSession,
  ): Promise<PlatformAuthorityChangeResult> {
    const conn = this.connectionOrThrow();
    const session = callerSession ?? (await conn.startSession());
    const isOwnerSession = !callerSession;

    let result: PlatformAuthorityChangeResult | undefined;

    try {
      const executeInSession = async (activeSession: ClientSession) => {
        const now = command.now ?? new Date();
        const payloadHash = hashPayload(command);
        const targetUserId = new Types.ObjectId(command.targetUserId);
        const actorUserId = new Types.ObjectId(command.actorUserId);
        const issuerUserId = new Types.ObjectId(command.issuerUserId);

        // 1. Idempotency Check in Operation Ledger
        const prior = await this.operations()
          .findOne({ operationId: command.operationId })
          .session(activeSession)
          .lean()
          .exec();

        if (prior) {
          if (prior.payloadHash !== payloadHash) {
            throw new ConflictException({
              code: 'OPERATION_PAYLOAD_MISMATCH',
              message:
                'The operationId was already executed with a different payload.',
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

        // 2. Gate 1: Principal Verifications inside transaction boundary
        const actor = await this.users()
          .findOne(
            { _id: actorUserId },
            { _id: 1, status: 1, twoFactorEnabled: 1 },
          )
          .session(activeSession)
          .lean()
          .exec();
        if (!actor || actor.status !== 'ACTIVE') {
          throw new ForbiddenException({
            code: 'ACTOR_INACTIVE',
            message: 'Executing actor account is inactive or not found.',
          });
        }

        const issuer = await this.users()
          .findOne(
            { _id: issuerUserId },
            { _id: 1, status: 1, twoFactorEnabled: 1 },
          )
          .session(activeSession)
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
          .session(activeSession)
          .lean()
          .exec();
        if (!target) {
          throw new NotFoundException({
            code: 'TARGET_USER_NOT_FOUND',
            message: 'Target user account not found.',
          });
        }

        if (command.operationType === 'GRANT' && target.status !== 'ACTIVE') {
          throw new ConflictException({
            code: 'TARGET_USER_INACTIVE',
            message:
              'Target user account must be ACTIVE to receive platform authority.',
          });
        }

        const isMfaSatisfied =
          command.mfaVerified === true ||
          (actor.twoFactorEnabled === true && issuer.twoFactorEnabled === true);
        if (!isMfaSatisfied) {
          throw new ForbiddenException({
            code: 'MFA_REQUIRED',
            message:
              'Platform authority mutations require multi-factor authentication proof for executor and issuer.',
          });
        }

        // 3. Inspect Current Assignment State
        const existing = await this.assignments()
          .findOne({
            subjectUserId: targetUserId,
            permission: command.permission,
            scope: 'PLATFORM',
          })
          .session(activeSession)
          .exec();

        let assignmentId: Types.ObjectId;
        let previousStatus = 'ABSENT';
        let newStatus: 'ACTIVE' | 'REVOKED';
        const httpStatus: 200 | 201 =
          command.operationType === 'GRANT' ? 201 : 200;

        if (command.operationType === 'GRANT') {
          newStatus = 'ACTIVE';
          const newExpiresAt = command.expiresAt
            ? new Date(command.expiresAt)
            : null;

          if (existing) {
            previousStatus = existing.status;
            const isCurrentlyActive =
              existing.status === 'ACTIVE' &&
              (existing.expiresAt == null ||
                existing.expiresAt.getTime() > now.getTime());

            if (isCurrentlyActive) {
              if (
                command.expectedCurrentStatus &&
                command.expectedCurrentStatus !== 'ACTIVE'
              ) {
                throw new ConflictException({
                  code: 'CAS_STATUS_MISMATCH',
                  message: `Expected status '${command.expectedCurrentStatus}' but assignment is currently ACTIVE.`,
                });
              }
              throw new ConflictException({
                code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE',
                message:
                  'Target user already holds active platform authority for this permission.',
              });
            }

            // Existing is REVOKED or expired -> reactivate under controlled procedure
            if (
              command.expectedCurrentStatus &&
              command.expectedCurrentStatus !== 'REVOKED'
            ) {
              throw new ConflictException({
                code: 'CAS_STATUS_MISMATCH',
                message: `Expected status '${command.expectedCurrentStatus}' but assignment is REVOKED/EXPIRED.`,
              });
            }

            existing.status = 'ACTIVE';
            existing.grantedAt = now;
            existing.grantedBy = issuerUserId;
            existing.expiresAt = newExpiresAt;
            existing.revokedAt = null;
            existing.revokedBy = null;
            await existing.save({ session: activeSession });
            assignmentId = existing._id;
          } else {
            // No existing assignment row -> create new
            if (
              command.expectedCurrentStatus &&
              command.expectedCurrentStatus !== 'ABSENT'
            ) {
              throw new ConflictException({
                code: 'CAS_STATUS_MISMATCH',
                message: `Expected status '${command.expectedCurrentStatus}' but assignment is ABSENT.`,
              });
            }

            const [created] = await this.assignments().create(
              [
                {
                  subjectUserId: targetUserId,
                  permission: command.permission,
                  scope: 'PLATFORM',
                  status: 'ACTIVE',
                  grantedAt: now,
                  grantedBy: issuerUserId,
                  expiresAt: newExpiresAt,
                  revokedAt: null,
                  revokedBy: null,
                },
              ],
              { session: activeSession },
            );
            assignmentId = created._id;
          }
        } else {
          // REVOKE operation
          newStatus = 'REVOKED';

          if (!existing) {
            if (
              command.expectedCurrentStatus &&
              command.expectedCurrentStatus !== 'ABSENT'
            ) {
              throw new ConflictException({
                code: 'CAS_STATUS_MISMATCH',
                message: `Expected status '${command.expectedCurrentStatus}' but assignment is ABSENT.`,
              });
            }
            throw new NotFoundException({
              code: 'PLATFORM_AUTHORITY_NOT_FOUND',
              message:
                'No platform authority assignment found for this target and permission.',
            });
          }

          previousStatus = existing.status;

          if (existing.status === 'REVOKED') {
            if (
              command.expectedCurrentStatus &&
              command.expectedCurrentStatus !== 'REVOKED'
            ) {
              throw new ConflictException({
                code: 'CAS_STATUS_MISMATCH',
                message: `Expected status '${command.expectedCurrentStatus}' but assignment is REVOKED.`,
              });
            }
            throw new ConflictException({
              code: 'PLATFORM_AUTHORITY_ALREADY_REVOKED',
              message: 'Platform authority assignment is already revoked.',
            });
          }

          if (
            command.expectedCurrentStatus &&
            command.expectedCurrentStatus !== 'ACTIVE'
          ) {
            throw new ConflictException({
              code: 'CAS_STATUS_MISMATCH',
              message: `Expected status '${command.expectedCurrentStatus}' but assignment is ACTIVE.`,
            });
          }

          // Gate 1: Last-operator protection invariant
          const activeOperatorsCount = await this.assignments()
            .countDocuments({
              permission: command.permission,
              scope: 'PLATFORM',
              status: 'ACTIVE',
              $or: [
                { expiresAt: { $exists: false } },
                { expiresAt: null },
                { expiresAt: { $gt: now } },
              ],
            })
            .session(activeSession);

          if (activeOperatorsCount <= 1 && !command.breakGlass) {
            throw new ConflictException({
              code: 'LAST_OPERATOR_REVOCATION_BLOCKED',
              message: `Cannot revoke last active operator for permission '${command.permission}' without emergency recovery authorization.`,
            });
          }

          existing.status = 'REVOKED';
          existing.revokedAt = now;
          existing.revokedBy = actorUserId;
          await existing.save({ session: activeSession });
          assignmentId = existing._id;
        }

        // 4. Result Body
        const body: PlatformAuthorityChangeResultBody = {
          operationId: command.operationId,
          assignmentId: assignmentId.toHexString(),
          targetUserId: command.targetUserId,
          permission: command.permission,
          scope: 'PLATFORM',
          status: newStatus,
          ...(command.operationType === 'GRANT'
            ? {
                grantedBy: command.issuerUserId,
                grantedAt: now.toISOString(),
                expiresAt: command.expiresAt ?? null,
              }
            : {
                revokedBy: command.actorUserId,
                revokedAt: now.toISOString(),
              }),
        };

        // 5. Operation Ledger Commit (Gate 1 & Gate 2)
        const auditEventId = randomUUID();
        const ledgerExpiry = new Date(
          now.getTime() + 365 * 24 * 60 * 60 * 1000,
        );

        await this.operations().create(
          [
            {
              operationId: command.operationId,
              payloadHash,
              actorUserId,
              issuerUserId,
              operationType: command.operationType,
              targetUserId,
              permission: command.permission,
              scope: 'PLATFORM',
              auditEventId,
              status: 'COMMITTED',
              httpStatus,
              resultBody: body,
              committedAt: now,
              expiresAt: ledgerExpiry,
            },
          ],
          { session: activeSession },
        );

        // 6. Audit Event Commit (Gate 2: Atomic cross-database commit)
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
                command.operationType === 'GRANT'
                  ? 'platform.authority.granted'
                  : 'platform.authority.revoked',
              targetResource: 'PLATFORM_AUTHORITY',
              targetResourceId: assignmentId.toHexString(),
              targetUserId: command.targetUserId,
              permission: command.permission,
              scope: 'PLATFORM',
              metadata: {
                before: { status: previousStatus },
                after: { status: newStatus },
                reasonCode: command.reasonCode,
                ...(command.breakGlass ? { breakGlass: true } : {}),
              },
              occurredAt: now,
            },
            { session: activeSession },
          );

        result = {
          operationId: command.operationId,
          status: 'COMMITTED',
          httpStatus,
          replayed: false,
          body,
        };
      };

      if (isOwnerSession) {
        await session.withTransaction(async () => {
          await executeInSession(session);
        });
      } else {
        await executeInSession(session);
      }
    } catch (error) {
      if (isDuplicateKey(error)) {
        const payloadHash = hashPayload(command);
        const prior = await this.operations()
          .findOne({ operationId: command.operationId })
          .lean()
          .exec();
        if (prior) {
          if (prior.payloadHash !== payloadHash) {
            throw new ConflictException({
              code: 'OPERATION_PAYLOAD_MISMATCH',
              message:
                'The operationId was already executed with a different payload.',
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
          code: 'PLATFORM_AUTHORITY_ALREADY_ACTIVE',
          message:
            'A concurrent platform authority assignment was committed for this target.',
        });
      }
      if (error instanceof HttpException) throw error;
      throw new ConflictException({
        code: 'PLATFORM_AUTHORITY_MUTATION_FAILED',
        message:
          error instanceof Error
            ? error.message
            : 'Platform authority mutation failed.',
      });
    } finally {
      if (isOwnerSession) {
        await session.endSession();
      }
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
