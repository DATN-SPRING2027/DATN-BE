import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  AdminInvitationPage,
  AdminInvitationSummary,
  InvitationMutationAcknowledgement,
  MembershipMutationAcknowledgement,
  MembershipMutationResult,
  OrganizationMembershipCommand,
  OrganizationMembershipCommandRepository as OrganizationMembershipCommandRepositoryPort,
  PlatformInvitationCommandInput,
  PlatformMembershipSuspendInput,
} from '../../application/organizations/organization-membership-command.repository';
import { OrganizationInvitationPayloadCipher } from '../email/organization-invitation-payload.cipher';
import { IAM_PERSISTENCE } from '../persistence';

const organizationMembershipManagePermission =
  'organization.memberships.manage';
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const invitationQuota = 30;
const invitationQuotaWindowMs = 60 * 60 * 1000;
const platformMembershipPermission = 'platform.memberships.lifecycle.manage';
const platformInvitationPermission = 'platform.memberships.invitation.manage';

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const organizationLevel = { projectId: null };

type InvitationCommandChange = {
  membership?: MembershipMutationAcknowledgement['membership'];
  invitation?: InvitationMutationAcknowledgement['invitation'];
  role?: MembershipMutationAcknowledgement['role'];
  audit: Omit<
    AuditRecord,
    | 'eventId'
    | 'schemaVersion'
    | 'operationId'
    | 'organizationId'
    | 'actorUserId'
    | 'occurredAt'
    | 'reasonCode'
    | 'correlationId'
  >;
  outbox?: {
    eventName: string;
    invitationId: string;
    payload: Record<string, unknown>;
  };
};

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: string;
}
interface PlatformAuthorityAssignmentDocument {
  subjectUserId: Types.ObjectId;
  permission: string;
  scope: string;
  status: string;
  grantedAt: Date;
  grantedBy: Types.ObjectId;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}
interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: 'PENDING_INVITE' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  version: number;
}
interface InvitationDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  membershipId?: Types.ObjectId;
  targetUserId?: Types.ObjectId;
  email: string;
  tokenHash?: string;
  contractVersion: number;
  version: number;
  status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  supersedesInvitationId?: Types.ObjectId;
}
interface LegacyInvitationDocument extends InvitationDocument {
  membershipId: Types.ObjectId;
  targetUserId: Types.ObjectId;
}
interface AdminInvitationRow {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: AdminInvitationSummary['status'];
  version: number;
  expiresAt: Date;
  createdAt: Date;
  email: string;
}
interface AdminInvitationFacet {
  data: AdminInvitationRow[];
  total: Array<{ count: number }>;
}
interface RoleAssignmentDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  mutationFence?: number;
  assignedBy?: Types.ObjectId;
  projectId?: Types.ObjectId | null;
}
interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}
interface OperationDocument {
  _id: Types.ObjectId;
  actorUserId: Types.ObjectId;
  organizationId: Types.ObjectId;
  membershipId?: Types.ObjectId;
  targetUserId?: Types.ObjectId;
  invitationId?: Types.ObjectId;
  keyHash: string;
  fingerprintHash: string;
  command: OrganizationMembershipCommand['command'];
  status: 'COMMITTED';
  httpStatus: 200 | 201;
  resultBody: MembershipMutationResult['body'];
  committedAt: Date;
  expiresAt: Date;
}

type AuditRecord = {
  eventId: string;
  schemaVersion: 2;
  operationId: string;
  organizationId: string;
  actorUserId: string;
  action: string;
  scope?: 'PLATFORM' | 'ORGANIZATION';
  result?: 'SUCCESS';
  occurredAt: Date;
  reasonCode: string;
  reason?: string;
  correlationId?: string;
  membershipId?: string;
  targetResource?: 'ORGANIZATION_MEMBERSHIP' | 'ORGANIZATION_INVITATION';
  targetResourceId?: string;
  invitationIds?: string[];
  before: Record<string, string | number>;
  after: Record<string, string | number>;
};

@Injectable()
export class MongoOrganizationMembershipCommandRepository implements OrganizationMembershipCommandRepositoryPort {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    private readonly invitationCipher?: OrganizationInvitationPayloadCipher,
  ) {}

  async hasPermission(
    organizationId: string,
    actorUserId: string,
    permission:
      'organization.memberships.read' | 'organization.memberships.manage',
  ): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(actorUserId)
    )
      return false;
    return this.hasPermissionAt(
      new Types.ObjectId(organizationId),
      new Types.ObjectId(actorUserId),
      permission,
    );
  }

  async listInvitations(
    organizationId: string,
    page: number,
    pageSize: number,
    now: Date,
  ): Promise<AdminInvitationPage> {
    const scope = new Types.ObjectId(organizationId);
    const [facet] = await this.invitations()
      .aggregate<AdminInvitationFacet>([
        {
          $match: {
            organizationId: scope,
            contractVersion: 3,
            status: 'PENDING',
            expiresAt: { $gt: now },
          },
        },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              {
                $project: {
                  _id: 1,
                  organizationId: 1,
                  status: 1,
                  version: 1,
                  expiresAt: 1,
                  createdAt: 1,
                  email: 1,
                },
              },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map((row) => ({
        id: row._id.toHexString(),
        organizationId: row.organizationId.toHexString(),
        status: row.status,
        version: row.version,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        invitedEmail: row.email,
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async execute(input: {
    actorUserId: string;
    organizationId: string;
    idempotencyKey: string;
    command: OrganizationMembershipCommand;
    now: Date;
    correlationId?: string;
  }): Promise<MembershipMutationResult> {
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const organizationId = new Types.ObjectId(input.organizationId);
    const session = await this.connectionOrThrow().startSession();
    let result: MembershipMutationResult | undefined;
    try {
      await session.withTransaction(async () => {
        if (
          !(await this.hasPermissionAt(
            organizationId,
            actorUserId,
            organizationMembershipManagePermission,
            session,
          ))
        )
          throw new ForbiddenException({
            code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
          });

        const keyHash = sha256(input.idempotencyKey);
        const fingerprintHash = this.fingerprint(
          input.organizationId,
          input.command,
        );
        const prior = await this.operations()
          .findOne({ actorUserId, organizationId, keyHash })
          .session(session)
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (prior.fingerprintHash !== fingerprintHash)
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          result = {
            httpStatus: prior.httpStatus,
            body: prior.resultBody,
            replayed: true,
          };
          return;
        }
        if (prior)
          await this.operations()
            .deleteOne(
              { _id: prior._id, expiresAt: { $lte: input.now } },
              { session },
            )
            .exec();

        await this.acquireOrganizationAdminFence(organizationId, session);
        // Re-read the actor's current account, membership, ADMIN assignment,
        // and exact permission after the shared fence. withTransaction reruns
        // this callback on transient conflicts, so each attempt checks again.
        if (
          !(await this.hasPermissionAt(
            organizationId,
            actorUserId,
            organizationMembershipManagePermission,
            session,
          ))
        )
          throw new ForbiddenException({
            code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
          });

        if (
          input.command.command === 'INVITE' ||
          input.command.command === 'RESEND'
        )
          await this.enforceInvitationQuota(
            organizationId,
            actorUserId,
            input.now,
            session,
          );

        const operationId = new Types.ObjectId();
        const change = await this.applyCommand(
          input.organizationId,
          actorUserId,
          input.command,
          input.now,
          session,
        );
        const body: MembershipMutationResult['body'] = change.membership
          ? {
              operationId: operationId.toHexString(),
              membership: change.membership,
              ...(change.invitation ? { invitation: change.invitation } : {}),
              ...(change.role ? { role: change.role } : {}),
            }
          : {
              operationId: operationId.toHexString(),
              invitation: change.invitation!,
            };
        const committedAt = input.now;
        const httpStatus = input.command.command === 'INVITE' ? 201 : 200;
        const invitationCommand = ['INVITE', 'RESEND', 'CANCEL'].includes(
          input.command.command,
        );
        const operationBinding = invitationCommand
          ? {
              contractVersion: 3,
              ...(input.command.command === 'RESEND' ||
              input.command.command === 'CANCEL'
                ? {
                    invitationId: new Types.ObjectId(
                      input.command.invitationId,
                    ),
                  }
                : {}),
            }
          : {
              contractVersion: 2,
              membershipId: new Types.ObjectId(change.membership!.id),
              targetUserId: new Types.ObjectId(change.membership!.userId),
            };
        await this.operations().create(
          [
            {
              _id: operationId,
              actorUserId,
              organizationId,
              ...operationBinding,
              keyHash,
              fingerprintHash,
              command: input.command.command,
              status: 'COMMITTED',
              httpStatus,
              resultBody: body,
              committedAt,
              expiresAt: new Date(committedAt.getTime() + 24 * 60 * 60 * 1000),
            },
          ],
          { session },
        );
        await this.writeAudit(
          {
            ...change.audit,
            eventId: randomUUID(),
            schemaVersion: 2,
            operationId: operationId.toHexString(),
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            scope: 'ORGANIZATION',
            result: 'SUCCESS',
            occurredAt: input.now,
            reasonCode:
              input.command.command === 'SET_ORGANIZATION_ROLE'
                ? 'ORGANIZATION_ROLE_CHANGED'
                : input.command.reasonCode,
            ...(input.command.command === 'SET_ORGANIZATION_ROLE'
              ? { reason: input.command.reason }
              : {}),
            ...(input.correlationId ||
            input.command.command === 'SET_ORGANIZATION_ROLE'
              ? {
                  correlationId:
                    input.correlationId ?? operationId.toHexString(),
                }
              : {}),
          },
          session,
        );
        if (change.outbox) {
          await this.outbox().create(
            [
              {
                eventName: change.outbox.eventName,
                aggregateType: 'ORGANIZATION_INVITATION',
                aggregateId: change.outbox.invitationId,
                payload: change.outbox.payload,
                status: 'PENDING',
                occurredAt: input.now,
              },
            ],
            { session },
          );
        }
        result = { httpStatus, body, replayed: false };
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        const duplicateResult = await this.resolveDuplicateKey(input);
        if (duplicateResult) result = duplicateResult;
        else throw await this.mapDuplicateKeyConflict(input, error);
      } else if (error instanceof HttpException) {
        throw error;
      } else {
        throw new InternalServerErrorException({
          code: 'IAM_MEMBERSHIP_MUTATION_FAILED',
        });
      }
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new Error('Membership command transaction returned no result');
    return result;
  }

  async executePlatformSuspend(
    input: PlatformMembershipSuspendInput,
  ): Promise<MembershipMutationResult> {
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const organizationId = new Types.ObjectId(input.organizationId);
    const command: OrganizationMembershipCommand = {
      command: 'SUSPEND',
      membershipId: input.membershipId,
      expectedMembershipVersion: input.expectedMembershipVersion,
      reasonCode: input.reasonCode,
    };
    const session = await this.connectionOrThrow().startSession();
    let result: MembershipMutationResult | undefined;
    const keyHash = sha256(input.idempotencyKey);
    const fingerprintHash = this.fingerprint(
      input.organizationId,
      command,
      'PLATFORM',
    );
    try {
      await session.withTransaction(async () => {
        await this.acquirePlatformAuthorityFence(session);
        if (
          !(await this.hasPlatformPermissionAt(actorUserId, input.now, session))
        )
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Insufficient authorization.',
          });

        const prior = await this.operations()
          .findOne({ actorUserId, organizationId, keyHash })
          .session(session)
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (prior.fingerprintHash !== fingerprintHash)
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          result = {
            httpStatus: prior.httpStatus,
            body: prior.resultBody,
            replayed: true,
          };
          return;
        }
        if (prior)
          await this.operations()
            .deleteOne(
              { _id: prior._id, expiresAt: { $lte: input.now } },
              { session },
            )
            .exec();

        await this.acquireOrganizationAdminFence(organizationId, session);
        if (
          !(await this.hasPlatformPermissionAt(actorUserId, input.now, session))
        )
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Insufficient authorization.',
          });

        const operationId = new Types.ObjectId();
        const change = await this.suspend(
          input.organizationId,
          actorUserId,
          command,
          input.now,
          session,
        );
        const body: MembershipMutationAcknowledgement = {
          operationId: operationId.toHexString(),
          membership: change.membership,
        };
        await this.operations().create(
          [
            {
              _id: operationId,
              actorUserId,
              organizationId,
              membershipId: new Types.ObjectId(body.membership.id),
              targetUserId: new Types.ObjectId(body.membership.userId),
              keyHash,
              fingerprintHash,
              command: 'SUSPEND',
              status: 'COMMITTED',
              httpStatus: 200,
              resultBody: body,
              committedAt: input.now,
              expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
            },
          ],
          { session },
        );
        await this.writeAudit(
          {
            ...change.audit,
            eventId: randomUUID(),
            schemaVersion: 2,
            operationId: operationId.toHexString(),
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            occurredAt: input.now,
            reasonCode: input.reasonCode,
            targetResource: 'ORGANIZATION_MEMBERSHIP',
            targetResourceId: change.audit.membershipId,
            ...(input.correlationId
              ? { correlationId: input.correlationId }
              : {}),
          },
          session,
        );
        result = { httpStatus: 200, body, replayed: false };
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        const prior = await this.operations()
          .findOne({ actorUserId, organizationId, keyHash })
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (prior.fingerprintHash !== fingerprintHash)
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          return {
            httpStatus: prior.httpStatus,
            body: prior.resultBody,
            replayed: true,
          };
        }
        throw new ConflictException({ code: 'MEMBERSHIP_INVALID_TRANSITION' });
      }
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'IAM_MEMBERSHIP_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new Error(
        'Platform membership command transaction returned no result',
      );
    return result;
  }

  async executePlatformInvitationCommand(
    input: PlatformInvitationCommandInput,
  ): Promise<MembershipMutationResult> {
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const organizationId = new Types.ObjectId(input.organizationId);
    const session = await this.connectionOrThrow().startSession();
    let result: MembershipMutationResult | undefined;
    const keyHash = sha256(input.idempotencyKey);
    const fingerprintHash = this.fingerprint(
      input.organizationId,
      input.command,
      'PLATFORM',
    );
    try {
      await session.withTransaction(async () => {
        await this.acquirePlatformAuthorityFence(session);
        if (
          !(await this.hasPlatformPermissionAt(
            actorUserId,
            input.now,
            session,
            platformInvitationPermission,
          ))
        )
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Insufficient authorization.',
          });

        const prior = await this.operations()
          .findOne({ actorUserId, organizationId, keyHash })
          .session(session)
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (prior.fingerprintHash !== fingerprintHash)
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          result = {
            httpStatus: prior.httpStatus,
            body: prior.resultBody,
            replayed: true,
          };
          return;
        }

        await this.acquireOrganizationAdminFence(organizationId, session);
        if (
          !(await this.hasPlatformPermissionAt(
            actorUserId,
            input.now,
            session,
            platformInvitationPermission,
          ))
        )
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: 'Insufficient authorization.',
          });
        if (
          input.command.command === 'INVITE' ||
          input.command.command === 'RESEND'
        )
          await this.enforceInvitationQuota(
            organizationId,
            actorUserId,
            input.now,
            session,
          );
        const operationId = new Types.ObjectId();
        const change = await this.applyCommand(
          input.organizationId,
          actorUserId,
          input.command,
          input.now,
          session,
        );
        const body: MembershipMutationResult['body'] = change.membership
          ? {
              operationId: operationId.toHexString(),
              membership: change.membership,
              ...(change.invitation ? { invitation: change.invitation } : {}),
            }
          : {
              operationId: operationId.toHexString(),
              invitation: change.invitation!,
            };
        await this.operations().create(
          [
            {
              _id: operationId,
              actorUserId,
              organizationId,
              contractVersion: 3,
              ...(input.command.command !== 'INVITE'
                ? {
                    invitationId: new Types.ObjectId(
                      input.command.invitationId,
                    ),
                  }
                : {}),
              keyHash,
              fingerprintHash,
              command: input.command.command,
              status: 'COMMITTED',
              httpStatus: input.command.command === 'INVITE' ? 201 : 200,
              resultBody: body,
              committedAt: input.now,
              expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000),
            },
          ],
          { session },
        );
        await this.writeAudit(
          {
            ...change.audit,
            eventId: randomUUID(),
            schemaVersion: 2,
            operationId: operationId.toHexString(),
            organizationId: input.organizationId,
            actorUserId: input.actorUserId,
            scope: 'PLATFORM',
            result: 'SUCCESS',
            occurredAt: input.now,
            reasonCode: input.command.reasonCode,
            ...(input.correlationId
              ? { correlationId: input.correlationId }
              : {}),
          },
          session,
        );
        if (change.outbox)
          await this.outbox().create(
            [
              {
                eventName: change.outbox.eventName,
                aggregateType: 'ORGANIZATION_INVITATION',
                aggregateId: change.outbox.invitationId,
                payload: change.outbox.payload,
                status: 'PENDING',
                occurredAt: input.now,
              },
            ],
            { session },
          );
        result = {
          httpStatus: input.command.command === 'INVITE' ? 201 : 200,
          body,
          replayed: false,
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'IAM_MEMBERSHIP_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    if (!result)
      throw new Error(
        'Platform invitation command transaction returned no result',
      );
    return result;
  }

  private async applyCommand(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: OrganizationMembershipCommand,
    now: Date,
    session: ClientSession,
  ): Promise<InvitationCommandChange> {
    if (command.command === 'INVITE')
      return this.inviteV3(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    if (command.command === 'RESEND')
      return this.resendV3(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    if (command.command === 'CANCEL')
      return this.cancelV3(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    if (command.command === 'SET_ORGANIZATION_ROLE')
      return this.setOrganizationRole(
        organizationIdText,
        actorUserId,
        command,
        session,
      );
    return this.suspend(organizationIdText, actorUserId, command, now, session);
  }

  private async inviteV3(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'INVITE' }>,
    now: Date,
    session: ClientSession,
  ): Promise<InvitationCommandChange> {
    const organizationId = new Types.ObjectId(organizationIdText);
    const existingUser = await this.users()
      .findOne({ email: command.email })
      .session(session)
      .lean()
      .exec();
    if (existingUser && existingUser.status !== 'ACTIVE')
      throw new HttpException({ code: 'INVITATION_TARGET_NOT_ELIGIBLE' }, 422);
    if (existingUser) {
      const existingMembership = await this.memberships()
        .findOne({ organizationId, userId: existingUser._id })
        .session(session)
        .lean()
        .exec();
      if (existingMembership?.status === 'ACTIVE')
        throw new ConflictException({ code: 'TARGET_ALREADY_MEMBER' });
      if (existingMembership?.status === 'SUSPENDED')
        throw new ConflictException({ code: 'USE_RESUME' });
      if (existingMembership?.status === 'REMOVED')
        throw new ConflictException({ code: 'USE_REINVITE' });
    }

    const pending = await this.invitations()
      .findOne({ organizationId, email: command.email, status: 'PENDING' })
      .session(session)
      .lean()
      .exec();
    if (pending && pending.expiresAt.getTime() > now.getTime())
      throw new ConflictException({ code: 'ALREADY_PENDING' });
    if (pending)
      await this.invitations()
        .updateOne(
          { _id: pending._id, status: 'PENDING', version: pending.version },
          { $set: { status: 'EXPIRED' }, $inc: { version: 1 } },
          { session },
        )
        .exec();

    const invitationId = new Types.ObjectId();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
    const binding = {
      invitationId: invitationId.toHexString(),
      organizationId: organizationIdText,
      recipientEmail: command.email,
      tokenHash,
    };
    const encryptedToken = this.cipherOrThrow().encryptToken(token, binding);
    await this.invitations().create(
      [
        {
          _id: invitationId,
          organizationId,
          email: command.email,
          contractVersion: 3,
          tokenHash,
          version: 1,
          status: 'PENDING',
          invitedBy: actorUserId,
          expiresAt,
        },
      ],
      { session },
    );
    const invitation = {
      id: invitationId.toHexString(),
      status: 'PENDING' as const,
      version: 1,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      invitation,
      audit: {
        action: 'ORGANIZATION_INVITATION_CREATED',
        invitationIds: [invitation.id],
        targetResource: 'ORGANIZATION_INVITATION',
        targetResourceId: invitation.id,
        before: { invitationStatus: 'ABSENT', invitationVersion: 0 },
        after: {
          invitationStatus: 'PENDING',
          invitationVersion: 1,
          invitationExpiresAt: expiresAt.toISOString(),
        },
      },
      outbox: {
        eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
        invitationId: invitation.id,
        payload: {
          invitationId: invitation.id,
          organizationId: organizationIdText,
          recipientEmail: command.email,
          tokenHash,
          encryptedToken,
        },
      },
    };
  }

  private async resendV3(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'RESEND' }>,
    now: Date,
    session: ClientSession,
  ): Promise<InvitationCommandChange> {
    const organizationId = new Types.ObjectId(organizationIdText);
    const oldInvitation = await this.findInvitationV3(
      organizationId,
      command.invitationId,
      session,
    );
    if (oldInvitation.version !== command.expectedInvitationVersion)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    if (oldInvitation.status !== 'PENDING')
      throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });

    const supersededStatus =
      oldInvitation.expiresAt.getTime() <= now.getTime()
        ? 'EXPIRED'
        : 'SUPERSEDED';
    const changed = await this.invitations()
      .findOneAndUpdate(
        {
          _id: oldInvitation._id,
          organizationId,
          contractVersion: 3,
          status: 'PENDING',
          version: command.expectedInvitationVersion,
        },
        { $set: { status: supersededStatus }, $inc: { version: 1 } },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!changed)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    await this.cancelPendingDelivery(oldInvitation._id.toHexString(), session);

    const invitationId = new Types.ObjectId();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
    const binding = {
      invitationId: invitationId.toHexString(),
      organizationId: organizationIdText,
      recipientEmail: oldInvitation.email,
      tokenHash,
    };
    const encryptedToken = this.cipherOrThrow().encryptToken(token, binding);
    await this.invitations().create(
      [
        {
          _id: invitationId,
          organizationId,
          email: oldInvitation.email,
          contractVersion: 3,
          tokenHash,
          version: 1,
          status: 'PENDING',
          invitedBy: actorUserId,
          expiresAt,
          supersedesInvitationId: oldInvitation._id,
        },
      ],
      { session },
    );
    return {
      invitation: {
        id: invitationId.toHexString(),
        status: 'PENDING',
        version: 1,
        expiresAt: expiresAt.toISOString(),
      },
      audit: {
        action: 'ORGANIZATION_INVITATION_RESENT',
        invitationIds: [
          oldInvitation._id.toHexString(),
          invitationId.toHexString(),
        ],
        targetResource: 'ORGANIZATION_INVITATION',
        targetResourceId: invitationId.toHexString(),
        before: {
          invitationStatus: oldInvitation.status,
          invitationVersion: oldInvitation.version,
          priorInvitationStatus: supersededStatus,
        },
        after: {
          invitationStatus: 'PENDING',
          invitationVersion: 1,
          invitationExpiresAt: expiresAt.toISOString(),
        },
      },
      outbox: {
        eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
        invitationId: invitationId.toHexString(),
        payload: {
          invitationId: invitationId.toHexString(),
          organizationId: organizationIdText,
          recipientEmail: oldInvitation.email,
          tokenHash,
          encryptedToken,
        },
      },
    };
  }

  private async cancelV3(
    organizationIdText: string,
    _actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'CANCEL' }>,
    now: Date,
    session: ClientSession,
  ): Promise<InvitationCommandChange> {
    const organizationId = new Types.ObjectId(organizationIdText);
    const invitation = await this.findInvitationV3(
      organizationId,
      command.invitationId,
      session,
    );
    if (invitation.version !== command.expectedInvitationVersion)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    if (invitation.status !== 'PENDING')
      throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
    if (invitation.expiresAt.getTime() <= now.getTime())
      throw new HttpException({ code: 'INVITATION_EXPIRED' }, 410);
    const updated = await this.invitations()
      .findOneAndUpdate(
        {
          _id: invitation._id,
          organizationId,
          contractVersion: 3,
          status: 'PENDING',
          version: command.expectedInvitationVersion,
          expiresAt: { $gt: now },
        },
        { $set: { status: 'CANCELLED' }, $inc: { version: 1 } },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!updated)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    await this.cancelPendingDelivery(invitation._id.toHexString(), session);
    return {
      invitation: {
        id: updated._id.toHexString(),
        status: 'CANCELLED',
        version: updated.version,
        expiresAt: updated.expiresAt.toISOString(),
      },
      audit: {
        action: 'ORGANIZATION_INVITATION_CANCELLED',
        invitationIds: [invitation._id.toHexString()],
        targetResource: 'ORGANIZATION_INVITATION',
        targetResourceId: invitation._id.toHexString(),
        before: {
          invitationStatus: invitation.status,
          invitationVersion: invitation.version,
        },
        after: {
          invitationStatus: 'CANCELLED',
          invitationVersion: updated.version,
          invitationExpiresAt: updated.expiresAt.toISOString(),
        },
      },
    };
  }

  private async findInvitationV3(
    organizationId: Types.ObjectId,
    invitationIdText: string,
    session: ClientSession,
  ): Promise<InvitationDocument> {
    const invitation = await this.invitations()
      .findOne({
        _id: new Types.ObjectId(invitationIdText),
        organizationId,
        contractVersion: 3,
      })
      .session(session)
      .lean()
      .exec();
    if (!invitation)
      throw new HttpException({ code: 'INVITATION_NOT_FOUND' }, 404);
    return invitation;
  }

  private async cancelPendingDelivery(
    invitationId: string,
    session: ClientSession,
  ): Promise<void> {
    await this.outbox()
      .updateMany(
        {
          eventName: 'ORGANIZATION_INVITATION_EMAIL_REQUESTED',
          aggregateType: 'ORGANIZATION_INVITATION',
          aggregateId: invitationId,
          status: 'PENDING',
        },
        {
          $set: { status: 'FAILED', lastError: 'INVITATION_NO_LONGER_PENDING' },
          $unset: { 'payload.encryptedToken': '' },
        },
        { session },
      )
      .exec();
  }

  private cipherOrThrow(): OrganizationInvitationPayloadCipher {
    if (!this.invitationCipher)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return this.invitationCipher;
  }

  private async invite(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'INVITE' }>,
    now: Date,
    session: ClientSession,
  ) {
    const organizationId = new Types.ObjectId(organizationIdText);
    const user = await this.users()
      .findOne({ email: command.email, status: 'ACTIVE' })
      .session(session)
      .lean()
      .exec();
    if (!user)
      throw new HttpException({ code: 'INVITATION_TARGET_NOT_ELIGIBLE' }, 422);
    const existingMembership = await this.memberships()
      .findOne({ organizationId, userId: user._id })
      .session(session)
      .lean()
      .exec();
    if (existingMembership) {
      if (existingMembership.status === 'ACTIVE')
        throw new ConflictException({ code: 'TARGET_ALREADY_MEMBER' });
      if (existingMembership.status === 'PENDING_INVITE')
        throw new ConflictException({ code: 'ALREADY_PENDING' });
      if (existingMembership.status === 'SUSPENDED')
        throw new ConflictException({ code: 'USE_RESUME' });
      throw new ConflictException({ code: 'USE_REINVITE' });
    }
    const membershipId = new Types.ObjectId();
    const invitationId = new Types.ObjectId();
    const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
    await this.memberships().create(
      [
        {
          _id: membershipId,
          organizationId,
          userId: user._id,
          status: 'PENDING_INVITE',
          version: 1,
          mutationFence: 0,
        },
      ],
      { session },
    );
    await this.invitations().create(
      [
        {
          _id: invitationId,
          organizationId,
          membershipId,
          targetUserId: user._id,
          email: command.email,
          contractVersion: 2,
          version: 1,
          status: 'PENDING',
          invitedBy: actorUserId,
          expiresAt,
        },
      ],
      { session },
    );
    const membership = {
      id: membershipId.toHexString(),
      organizationId: organizationIdText,
      userId: user._id.toHexString(),
      status: 'PENDING_INVITE' as const,
      version: 1,
    };
    const invitation = {
      id: invitationId.toHexString(),
      status: 'PENDING' as const,
      version: 1,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      membership,
      invitation,
      audit: {
        action: 'ORGANIZATION_MEMBERSHIP_INVITED',
        membershipId: membership.id,
        invitationIds: [invitation.id],
        before: { membershipStatus: 'ABSENT', membershipVersion: 0 },
        after: {
          membershipStatus: 'PENDING_INVITE',
          membershipVersion: 1,
          invitationStatus: 'PENDING',
          invitationVersion: 1,
          invitationExpiresAt: expiresAt.toISOString(),
        },
      },
      outbox: {
        eventName: 'ORGANIZATION_INVITATION_CREATED',
        invitationId: invitation.id,
      },
    };
  }

  private async resend(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'RESEND' }>,
    now: Date,
    session: ClientSession,
  ) {
    const organizationId = new Types.ObjectId(organizationIdText);
    const invitation = await this.findInvitation(
      organizationId,
      command.invitationId,
      session,
    );
    const membership = await this.findMembership(
      organizationId,
      invitation.membershipId,
      session,
    );
    this.assertPendingVersions(
      membership,
      invitation,
      command.expectedMembershipVersion!,
      command.expectedInvitationVersion,
    );
    const previousInvitationStatus =
      invitation.expiresAt.getTime() <= now.getTime()
        ? 'EXPIRED'
        : 'SUPERSEDED';
    const superseded = await this.invitations()
      .findOneAndUpdate(
        {
          _id: invitation._id,
          organizationId,
          contractVersion: 2,
          status: 'PENDING',
          version: command.expectedInvitationVersion,
        },
        {
          $set: { status: previousInvitationStatus },
          $inc: { version: 1 },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!superseded)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    const updatedMembership = await this.memberships()
      .findOneAndUpdate(
        {
          _id: membership._id,
          organizationId,
          status: 'PENDING_INVITE',
          version: command.expectedMembershipVersion,
        },
        { $inc: { mutationFence: 1 } },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!updatedMembership)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    const newInvitationId = new Types.ObjectId();
    const expiresAt = new Date(now.getTime() + invitationLifetimeMs);
    await this.invitations().create(
      [
        {
          _id: newInvitationId,
          organizationId,
          membershipId: membership._id,
          targetUserId: membership.userId,
          email: invitation.email,
          contractVersion: 2,
          version: 1,
          status: 'PENDING',
          invitedBy: actorUserId,
          expiresAt,
          supersedesInvitationId: invitation._id,
        },
      ],
      { session },
    );
    const mappedMembership = this.mapMembership(
      organizationIdText,
      updatedMembership,
    );
    const mappedInvitation = {
      id: newInvitationId.toHexString(),
      status: 'PENDING' as const,
      version: 1,
      expiresAt: expiresAt.toISOString(),
    };
    return {
      membership: mappedMembership,
      invitation: mappedInvitation,
      audit: {
        action: 'ORGANIZATION_INVITATION_RESENT',
        membershipId: membership._id.toHexString(),
        invitationIds: [
          invitation._id.toHexString(),
          newInvitationId.toHexString(),
        ],
        before: {
          membershipStatus: membership.status,
          membershipVersion: membership.version,
          invitationStatus: invitation.status,
          invitationVersion: invitation.version,
          invitationExpiresAt: invitation.expiresAt.toISOString(),
        },
        after: {
          membershipStatus: 'PENDING_INVITE',
          membershipVersion: updatedMembership.version,
          invitationStatus: 'PENDING',
          invitationVersion: 1,
          invitationExpiresAt: expiresAt.toISOString(),
        },
      },
      outbox: {
        eventName: 'ORGANIZATION_INVITATION_RESENT',
        invitationId: newInvitationId.toHexString(),
      },
    };
  }

  private async cancel(
    organizationIdText: string,
    _actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'CANCEL' }>,
    now: Date,
    session: ClientSession,
  ) {
    const organizationId = new Types.ObjectId(organizationIdText);
    const invitation = await this.findInvitation(
      organizationId,
      command.invitationId,
      session,
    );
    const membership = await this.findMembership(
      organizationId,
      invitation.membershipId,
      session,
    );
    this.assertPendingVersions(
      membership,
      invitation,
      command.expectedMembershipVersion!,
      command.expectedInvitationVersion,
    );
    const expired = invitation.expiresAt.getTime() <= now.getTime();
    const updatedInvitation = await this.invitations()
      .findOneAndUpdate(
        {
          _id: invitation._id,
          organizationId,
          contractVersion: 2,
          status: 'PENDING',
          version: command.expectedInvitationVersion,
        },
        {
          $set: { status: expired ? 'EXPIRED' : 'CANCELLED' },
          $inc: { version: 1 },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!updatedInvitation)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    const updatedMembership = await this.memberships()
      .findOneAndUpdate(
        {
          _id: membership._id,
          organizationId,
          status: 'PENDING_INVITE',
          version: command.expectedMembershipVersion,
        },
        {
          $set: { status: 'REMOVED' },
          $inc: { version: 1, mutationFence: 1 },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!updatedMembership)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    const mappedMembership = this.mapMembership(
      organizationIdText,
      updatedMembership,
    );
    return {
      membership: mappedMembership,
      invitation: {
        id: updatedInvitation._id.toHexString(),
        status: expired ? ('EXPIRED' as const) : ('CANCELLED' as const),
        version: updatedInvitation.version,
        expiresAt: updatedInvitation.expiresAt.toISOString(),
      },
      audit: {
        action: 'ORGANIZATION_INVITATION_CANCELLED',
        membershipId: membership._id.toHexString(),
        invitationIds: [invitation._id.toHexString()],
        before: {
          membershipStatus: membership.status,
          membershipVersion: membership.version,
          invitationStatus: invitation.status,
          invitationVersion: invitation.version,
          invitationExpiresAt: invitation.expiresAt.toISOString(),
        },
        after: {
          membershipStatus: 'REMOVED',
          membershipVersion: updatedMembership.version,
          invitationStatus: expired ? 'EXPIRED' : 'CANCELLED',
          invitationVersion: updatedInvitation.version,
          invitationExpiresAt: updatedInvitation.expiresAt.toISOString(),
        },
      },
    };
  }

  private async setOrganizationRole(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<
      OrganizationMembershipCommand,
      { command: 'SET_ORGANIZATION_ROLE' }
    >,
    session: ClientSession,
  ) {
    const organizationId = new Types.ObjectId(organizationIdText);
    const membership = await this.findMembership(
      organizationId,
      new Types.ObjectId(command.membershipId),
      session,
    );
    if (membership.userId.equals(actorUserId))
      throw new ForbiddenException({ code: 'ROLE_SELF_CHANGE_FORBIDDEN' });
    if (membership.status !== 'ACTIVE')
      throw new ConflictException({ code: 'MEMBERSHIP_INVALID_TRANSITION' });
    if (membership.version !== command.expectedMembershipVersion)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    const assignments = await this.assignments()
      .find({
        organizationId,
        userId: membership.userId,
        ...organizationLevel,
      })
      .session(session)
      .lean()
      .exec();
    if (assignments.length > 1)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    const assignment = assignments[0];
    const currentRole = assignment?.roleCode;
    if (assignment && currentRole !== 'ADMIN' && currentRole !== 'MEMBER')
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    const currentRoleVersion = assignment?.mutationFence;
    if (
      assignment &&
      (!Number.isSafeInteger(currentRoleVersion) ||
        Number(currentRoleVersion) < 0)
    )
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    const actualRoleVersion = currentRoleVersion ?? 0;
    if (actualRoleVersion !== command.expectedRoleVersion)
      throw new ConflictException({ code: 'ROLE_VERSION_CONFLICT' });
    if (currentRole === command.roleCode)
      throw new ConflictException({ code: 'ROLE_ALREADY_ASSIGNED' });
    if (currentRole === 'ADMIN' && command.roleCode === 'MEMBER') {
      const eligibleAdmins = await this.eligibleAdminIds(
        organizationId,
        session,
      );
      if (
        eligibleAdmins.some((id) => id.equals(membership.userId)) &&
        eligibleAdmins.length <= 1
      )
        throw new ConflictException({ code: 'LAST_ELIGIBLE_ADMIN' });
    }

    const role = await this.roles()
      .findOne({
        code: command.roleCode,
        isSystem: true,
        ...(command.roleCode === 'ADMIN'
          ? { permissions: organizationMembershipManagePermission }
          : {}),
      })
      .session(session)
      .lean()
      .exec();
    if (!role)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });

    const nextRoleVersion = actualRoleVersion + 1;
    if (assignment) {
      const updated = await this.assignments()
        .findOneAndUpdate(
          {
            _id: assignment._id,
            organizationId,
            userId: membership.userId,
            ...organizationLevel,
            roleCode: currentRole,
            mutationFence: actualRoleVersion,
          },
          {
            $set: {
              roleId: role._id,
              roleCode: command.roleCode,
              assignedBy: actorUserId,
            },
            $inc: { mutationFence: 1 },
          },
          { new: true, session },
        )
        .lean()
        .exec();
      if (!updated)
        throw new ConflictException({ code: 'ROLE_VERSION_CONFLICT' });
    } else {
      await this.assignments().create(
        [
          {
            organizationId,
            userId: membership.userId,
            roleId: role._id,
            roleCode: command.roleCode,
            assignedBy: actorUserId,
            mutationFence: nextRoleVersion,
          },
        ],
        { session },
      );
    }

    return {
      membership: this.mapMembership(organizationIdText, membership),
      role: { roleCode: command.roleCode, version: nextRoleVersion },
      audit: {
        action: 'ORGANIZATION_MEMBER_ROLE_CHANGED',
        membershipId: membership._id.toHexString(),
        targetResource: 'ORGANIZATION_MEMBERSHIP' as const,
        targetResourceId: membership._id.toHexString(),
        before: {
          roleCode: currentRole ?? 'UNASSIGNED',
          roleVersion: actualRoleVersion,
        },
        after: { roleCode: command.roleCode, roleVersion: nextRoleVersion },
      },
      reason: command.reason,
    };
  }

  private async suspend(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: Extract<OrganizationMembershipCommand, { command: 'SUSPEND' }>,
    now: Date,
    session: ClientSession,
  ) {
    const organizationId = new Types.ObjectId(organizationIdText);
    const membership = await this.findMembership(
      organizationId,
      new Types.ObjectId(command.membershipId),
      session,
    );
    if (membership.userId.equals(actorUserId))
      throw new ForbiddenException({
        code: 'MEMBERSHIP_SELF_ACTION_FORBIDDEN',
      });
    if (membership.version !== command.expectedMembershipVersion)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    if (membership.status !== 'ACTIVE')
      throw new ConflictException({ code: 'MEMBERSHIP_INVALID_TRANSITION' });
    const eligibleAdminIds = await this.eligibleAdminIds(
      organizationId,
      session,
    );
    if (
      eligibleAdminIds.some((id) => id.equals(membership.userId)) &&
      eligibleAdminIds.length <= 1
    )
      throw new ConflictException({ code: 'LAST_ELIGIBLE_ADMIN' });
    const updated = await this.memberships()
      .findOneAndUpdate(
        {
          _id: membership._id,
          organizationId,
          status: 'ACTIVE',
          version: command.expectedMembershipVersion,
        },
        {
          $set: { status: 'SUSPENDED' },
          $inc: { version: 1, mutationFence: 1 },
          $currentDate: { updatedAt: true },
        },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!updated)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    const mappedMembership = this.mapMembership(organizationIdText, updated);
    return {
      membership: mappedMembership,
      audit: {
        action: 'ORGANIZATION_MEMBERSHIP_SUSPENDED',
        membershipId: membership._id.toHexString(),
        before: {
          membershipStatus: 'ACTIVE',
          membershipVersion: membership.version,
        },
        after: {
          membershipStatus: 'SUSPENDED',
          membershipVersion: updated.version,
        },
      },
    };
  }

  private async findInvitation(
    organizationId: Types.ObjectId,
    invitationIdText: string,
    session: ClientSession,
  ): Promise<LegacyInvitationDocument> {
    const invitation = await this.invitations()
      .findOne({
        _id: new Types.ObjectId(invitationIdText),
        organizationId,
        contractVersion: 2,
      })
      .session(session)
      .lean()
      .exec();
    if (!invitation)
      throw new HttpException({ code: 'INVITATION_NOT_FOUND' }, 404);
    return invitation as LegacyInvitationDocument;
  }

  private async findMembership(
    organizationId: Types.ObjectId,
    membershipId: Types.ObjectId,
    session: ClientSession,
  ): Promise<MembershipDocument> {
    const membership = await this.memberships()
      .findOne({ _id: membershipId, organizationId })
      .session(session)
      .lean()
      .exec();
    if (!membership)
      throw new HttpException(
        { code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND' },
        404,
      );
    return membership;
  }

  private assertPendingVersions(
    membership: MembershipDocument,
    invitation: InvitationDocument,
    expectedMembershipVersion: number,
    expectedInvitationVersion: number,
  ): void {
    if (membership.version !== expectedMembershipVersion)
      throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
    if (invitation.version !== expectedInvitationVersion)
      throw new ConflictException({ code: 'INVITATION_VERSION_CONFLICT' });
    if (
      membership.status !== 'PENDING_INVITE' ||
      invitation.status !== 'PENDING'
    )
      throw new ConflictException({ code: 'MEMBERSHIP_INVALID_TRANSITION' });
  }

  private async hasPermissionAt(
    organizationId: Types.ObjectId,
    actorUserId: Types.ObjectId,
    permission:
      | 'organization.memberships.read'
      | typeof organizationMembershipManagePermission,
    session?: ClientSession,
  ): Promise<boolean> {
    const actor = await this.users()
      .findOne({ _id: actorUserId, status: 'ACTIVE' }, { _id: 1 })
      .session(session ?? null)
      .lean()
      .exec();
    if (!actor) return false;
    const activeMembership = await this.memberships()
      .exists({ organizationId, userId: actorUserId, status: 'ACTIVE' })
      .session(session ?? null);
    if (!activeMembership) return false;
    const assignments = await this.assignments()
      .find(
        {
          organizationId,
          userId: actorUserId,
          roleCode: 'ADMIN',
          ...organizationLevel,
        },
        { roleId: 1 },
      )
      .session(session ?? null)
      .lean()
      .exec();
    if (assignments.length === 0) return false;
    const roles = await this.roles()
      .find(
        {
          _id: { $in: assignments.map((assignment) => assignment.roleId) },
          code: 'ADMIN',
          permissions: permission,
        },
        { _id: 1 },
      )
      .session(session ?? null)
      .lean()
      .exec();
    return roles.length > 0;
  }

  private async hasPlatformPermissionAt(
    actorUserId: Types.ObjectId,
    now: Date,
    session: ClientSession,
    permission = platformMembershipPermission,
  ): Promise<boolean> {
    const actor = await this.users()
      .findOne({ _id: actorUserId, status: 'ACTIVE' }, { _id: 1 })
      .session(session)
      .lean()
      .exec();
    if (!actor) return false;
    const assignments = await this.model<PlatformAuthorityAssignmentDocument>(
      'platform_authority_assignments',
    )
      .find({
        subjectUserId: actorUserId,
        permission,
        scope: 'PLATFORM',
      })
      .session(session)
      .lean()
      .exec();
    const validAssignments = assignments.filter(
      (assignment) =>
        assignment.subjectUserId.equals(actorUserId) &&
        assignment.scope === 'PLATFORM' &&
        assignment.permission === permission &&
        assignment.status === 'ACTIVE' &&
        assignment.revokedAt == null &&
        assignment.grantedBy instanceof Types.ObjectId &&
        !assignment.grantedBy.equals(actorUserId) &&
        assignment.grantedAt instanceof Date &&
        Number.isFinite(assignment.grantedAt.getTime()) &&
        assignment.grantedAt.getTime() <= now.getTime() &&
        (assignment.expiresAt == null ||
          (assignment.expiresAt instanceof Date &&
            Number.isFinite(assignment.expiresAt.getTime()) &&
            assignment.expiresAt.getTime() > now.getTime())),
    );
    return validAssignments.length === 1;
  }

  private async acquirePlatformAuthorityFence(
    session: ClientSession,
  ): Promise<void> {
    const fence = await this.model<{ _id: Types.ObjectId }>(
      'platform_authority_change_locks',
    )
      .updateOne(
        {
          permission: 'PLATFORM_OPERATOR_LIFECYCLE',
          scope: 'PLATFORM',
        },
        { $inc: { version: 1 } },
        { session },
      )
      .exec();
    if (fence.matchedCount !== 1)
      throw new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_LOCKS_UNAVAILABLE',
      });
  }

  private async eligibleAdminIds(
    organizationId: Types.ObjectId,
    session: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const assignments = await this.assignments()
      .find(
        { organizationId, roleCode: 'ADMIN', ...organizationLevel },
        { userId: 1, roleId: 1 },
      )
      .session(session)
      .lean()
      .exec();
    if (assignments.length === 0) return [];
    const roles = await this.roles()
      .find(
        {
          _id: { $in: assignments.map((assignment) => assignment.roleId) },
          code: 'ADMIN',
          permissions: organizationMembershipManagePermission,
        },
        { _id: 1 },
      )
      .session(session)
      .lean()
      .exec();
    const eligibleRoleIds = new Set(
      roles.map((role) => role._id.toHexString()),
    );
    const assignedUserIds = [
      ...new Map(
        assignments
          .filter((assignment) =>
            eligibleRoleIds.has(assignment.roleId.toHexString()),
          )
          .map((assignment) => [
            assignment.userId.toHexString(),
            assignment.userId,
          ]),
      ).values(),
    ];
    if (assignedUserIds.length === 0) return [];
    const activeMemberships = await this.memberships()
      .find(
        {
          organizationId,
          userId: { $in: assignedUserIds },
          status: 'ACTIVE',
        },
        { userId: 1 },
      )
      .session(session)
      .lean()
      .exec();
    const activeMembershipUserIds = activeMemberships.map((row) => row.userId);
    const activeUsers = await this.users()
      .find(
        { _id: { $in: activeMembershipUserIds }, status: 'ACTIVE' },
        { _id: 1 },
      )
      .session(session)
      .lean()
      .exec();
    return activeUsers.map((user) => user._id);
  }

  private async acquireOrganizationAdminFence(
    organizationId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const fenced = await this.organizations()
      .updateOne(
        { _id: organizationId },
        {
          $inc: { membershipAdminRevision: 1 },
          $currentDate: { updatedAt: true },
        },
        { session },
      )
      .exec();
    if (fenced.matchedCount !== 1)
      throw new HttpException(
        { code: 'ORGANIZATION_MEMBERSHIP_NOT_FOUND' },
        404,
      );
  }

  private async enforceInvitationQuota(
    organizationId: Types.ObjectId,
    actorUserId: Types.ObjectId,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const start = new Date(now.getTime() - invitationQuotaWindowMs);
    const filter = {
      organizationId,
      actorUserId,
      command: { $in: ['INVITE', 'RESEND', 'REINVITE'] },
      status: 'COMMITTED',
      committedAt: { $gt: start },
    };
    const count = await this.operations()
      .countDocuments(filter)
      .session(session)
      .exec();
    if (count < invitationQuota) return;
    const oldest = await this.operations()
      .findOne(filter, { committedAt: 1 })
      .sort({ committedAt: 1, _id: 1 })
      .session(session)
      .lean()
      .exec();
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(
        ((oldest?.committedAt.getTime() ?? now.getTime()) +
          invitationQuotaWindowMs -
          now.getTime()) /
          1000,
      ),
    );
    throw new HttpException(
      {
        code: 'ORGANIZATION_INVITATION_RATE_LIMITED',
        retryAfterSeconds,
      },
      429,
    );
  }

  private async writeAudit(
    record: AuditRecord,
    session: ClientSession,
  ): Promise<void> {
    await this.connectionOrThrow()
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(record, { session });
  }

  private async resolveDuplicateKey(
    input: Parameters<
      OrganizationMembershipCommandRepositoryPort['execute']
    >[0],
  ): Promise<MembershipMutationResult | undefined> {
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const organizationId = new Types.ObjectId(input.organizationId);
    if (
      !(await this.hasPermissionAt(
        organizationId,
        actorUserId,
        organizationMembershipManagePermission,
      ))
    )
      throw new ForbiddenException({
        code: 'ORGANIZATION_MEMBERSHIP_FORBIDDEN',
      });
    const prior = await this.operations()
      .findOne({
        actorUserId,
        organizationId,
        keyHash: sha256(input.idempotencyKey),
      })
      .lean()
      .exec();
    if (!prior || prior.expiresAt.getTime() <= input.now.getTime())
      return undefined;
    if (
      prior.fingerprintHash !==
      this.fingerprint(input.organizationId, input.command)
    )
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
    return {
      httpStatus: prior.httpStatus,
      body: prior.resultBody,
      replayed: true,
    };
  }

  private async mapDuplicateKeyConflict(
    input: Parameters<
      OrganizationMembershipCommandRepositoryPort['execute']
    >[0],
    error: unknown,
  ): Promise<ConflictException> {
    const keyPattern =
      typeof error === 'object' && error !== null && 'keyPattern' in error
        ? (error as { keyPattern?: Record<string, unknown> }).keyPattern
        : undefined;
    if (
      keyPattern &&
      'organizationId' in keyPattern &&
      'email' in keyPattern &&
      input.command.command === 'INVITE'
    )
      return new ConflictException({ code: 'ALREADY_PENDING' });
    if (
      keyPattern &&
      'organizationId' in keyPattern &&
      'userId' in keyPattern &&
      input.command.command === 'INVITE'
    ) {
      const organizationId = new Types.ObjectId(input.organizationId);
      const user = await this.users()
        .findOne({ email: input.command.email }, { _id: 1 })
        .lean()
        .exec();
      if (user) {
        const existingMembership = await this.memberships()
          .findOne({ organizationId, userId: user._id }, { status: 1 })
          .lean()
          .exec();
        if (existingMembership?.status === 'ACTIVE')
          return new ConflictException({ code: 'TARGET_ALREADY_MEMBER' });
        if (existingMembership?.status === 'PENDING_INVITE')
          return new ConflictException({ code: 'ALREADY_PENDING' });
        if (existingMembership?.status === 'SUSPENDED')
          return new ConflictException({ code: 'USE_RESUME' });
        if (existingMembership?.status === 'REMOVED')
          return new ConflictException({ code: 'USE_REINVITE' });
      }
    }
    return new ConflictException({ code: 'MEMBERSHIP_INVALID_TRANSITION' });
  }

  private fingerprint(
    organizationId: string,
    command: OrganizationMembershipCommand,
    actorContext: 'ORGANIZATION' | 'PLATFORM' = 'ORGANIZATION',
  ): string {
    return sha256(
      JSON.stringify({
        organizationId,
        ...command,
        ...(actorContext === 'PLATFORM' ? { actorContext } : {}),
      }),
    );
  }

  private mapMembership(
    organizationId: string,
    row: MembershipDocument,
  ): MembershipMutationAcknowledgement['membership'] {
    return {
      id: row._id.toHexString(),
      organizationId,
      userId: row.userId.toHexString(),
      status: row.status,
      version: row.version,
    };
  }

  private users(): Model<UserDocument> {
    return this.model<UserDocument>('users');
  }
  private memberships(): Model<MembershipDocument> {
    return this.model<MembershipDocument>('organization_memberships');
  }
  private invitations(): Model<InvitationDocument> {
    return this.model<InvitationDocument>('organization_invitations');
  }
  private assignments(): Model<RoleAssignmentDocument> {
    return this.model<RoleAssignmentDocument>('role_assignments');
  }
  private roles(): Model<RoleDocument> {
    return this.model<RoleDocument>('roles');
  }
  private operations(): Model<OperationDocument> {
    return this.model<OperationDocument>('membership_operations');
  }
  private organizations(): Model<{ _id: Types.ObjectId }> {
    return this.model<{ _id: Types.ObjectId }>('organizations');
  }
  private outbox(): Model<Record<string, unknown>> {
    return this.model<Record<string, unknown>>('outbox_events');
  }

  private model<T>(name: string): Model<T> {
    const model = this.connectionOrThrow().models[modelName(name)] as
      Model<T> | undefined;
    if (!model)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return model;
  }

  private connectionOrThrow(): Connection {
    if (!this.connection)
      throw new ServiceUnavailableException({
        code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
      });
    return this.connection;
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}
