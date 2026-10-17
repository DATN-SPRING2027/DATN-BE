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
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  AdminInvitationPage,
  AdminInvitationSummary,
  MembershipMutationAcknowledgement,
  MembershipMutationResult,
  OrganizationMembershipCommand,
  OrganizationMembershipCommandRepository as OrganizationMembershipCommandRepositoryPort,
} from '../../application/organizations/organization-membership-command.repository';
import { IAM_PERSISTENCE } from '../persistence';

const organizationMembershipManagePermission =
  'organization.memberships.manage';
const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const invitationQuota = 30;
const invitationQuotaWindowMs = 60 * 60 * 1000;

function isInvitationCommandReadinessBlocked(
  command: OrganizationMembershipCommand,
): boolean {
  return (
    command.command === 'INVITE' ||
    command.command === 'RESEND' ||
    command.command === 'CANCEL'
  );
}
const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const organizationLevel = { projectId: null };

interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: string;
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
  membershipId: Types.ObjectId;
  targetUserId: Types.ObjectId;
  email: string;
  contractVersion: number;
  version: number;
  status: 'PENDING' | 'ACCEPTED' | 'CANCELLED' | 'EXPIRED' | 'SUPERSEDED';
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  supersedesInvitationId?: Types.ObjectId;
}
interface AdminInvitationRow extends InvitationDocument {
  membershipVersion: number;
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
  membershipId: Types.ObjectId;
  targetUserId: Types.ObjectId;
  keyHash: string;
  fingerprintHash: string;
  command: OrganizationMembershipCommand['command'];
  status: 'COMMITTED';
  httpStatus: 200 | 201;
  resultBody: MembershipMutationAcknowledgement;
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
  occurredAt: Date;
  reasonCode: string;
  correlationId?: string;
  membershipId: string;
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
            contractVersion: 2,
            status: 'PENDING',
            expiresAt: { $gt: now },
          },
        },
        {
          $lookup: {
            from: 'organization_memberships',
            localField: 'membershipId',
            foreignField: '_id',
            as: 'membership',
          },
        },
        { $unwind: '$membership' },
        {
          $match: {
            'membership.status': 'PENDING_INVITE',
            $expr: {
              $and: [
                { $eq: ['$membership.organizationId', '$organizationId'] },
                { $eq: ['$membership.userId', '$targetUserId'] },
              ],
            },
          },
        },
        { $addFields: { membershipVersion: '$membership.version' } },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              { $project: { membership: 0 } },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map((row) =>
        this.mapInvitation(row, row.membershipVersion),
      ),
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

        // A new invitation command cannot be enabled until its accepted A7/A8
        // readiness gates are verified. Keep this after exact replay lookup so
        // a previously committed operation still returns its original result.
        if (isInvitationCommandReadinessBlocked(input.command))
          throw new ServiceUnavailableException({
            code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
          });

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
        const body: MembershipMutationAcknowledgement = {
          operationId: operationId.toHexString(),
          membership: change.membership,
          ...(change.invitation ? { invitation: change.invitation } : {}),
        };
        const committedAt = input.now;
        const httpStatus = input.command.command === 'INVITE' ? 201 : 200;
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
            occurredAt: input.now,
            reasonCode: input.command.reasonCode,
            ...(input.correlationId
              ? { correlationId: input.correlationId }
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
                payload: { invitationId: change.outbox.invitationId },
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

  private async applyCommand(
    organizationIdText: string,
    actorUserId: Types.ObjectId,
    command: OrganizationMembershipCommand,
    now: Date,
    session: ClientSession,
  ): Promise<{
    membership: MembershipMutationAcknowledgement['membership'];
    invitation?: MembershipMutationAcknowledgement['invitation'];
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
    outbox?: { eventName: string; invitationId: string };
  }> {
    if (command.command === 'INVITE')
      return this.invite(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    if (command.command === 'RESEND')
      return this.resend(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    if (command.command === 'CANCEL')
      return this.cancel(
        organizationIdText,
        actorUserId,
        command,
        now,
        session,
      );
    return this.suspend(organizationIdText, actorUserId, command, now, session);
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
      command.expectedMembershipVersion,
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
      command.expectedMembershipVersion,
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
  ): Promise<InvitationDocument> {
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
    return invitation;
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
  ): string {
    return sha256(JSON.stringify({ organizationId, ...command }));
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

  private mapInvitation(
    row: InvitationDocument,
    membershipVersion: number,
  ): AdminInvitationSummary {
    return {
      id: row._id.toHexString(),
      membershipId: row.membershipId.toHexString(),
      organizationId: row.organizationId.toHexString(),
      status: row.status,
      version: row.version,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      membershipVersion,
      targetUserId: row.targetUserId.toHexString(),
      email: row.email,
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
