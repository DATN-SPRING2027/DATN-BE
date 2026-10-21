import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  InternalServerErrorException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import type { Connection, Model, PipelineStage } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  AcceptInvitationAcknowledgement,
  AcceptInvitationResult,
  InvitationResolution,
  OrganizationInvitationRepository as OrganizationInvitationRepositoryPort,
  RecipientInvitation,
  RecipientInvitationDetail,
  RecipientInvitationPage,
  RecipientInvitationStatus,
} from '../../application/organizations/organization-invitation.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface RecipientInvitationRow {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  email: string;
  status: RecipientInvitationStatus;
  version: number;
  expiresAt: Date;
  createdAt: Date;
  organizationName: string;
}

interface RecipientInvitationListRow {
  data: RecipientInvitationRow[];
  total: Array<{ count: number }>;
}

interface AccountDocument {
  _id: Types.ObjectId;
  email: string;
  status: string;
}

interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: string;
  version: number;
}

interface OperationDocument {
  _id: Types.ObjectId;
  actorUserId: Types.ObjectId;
  organizationId: Types.ObjectId;
  contractVersion: number;
  invitationId: Types.ObjectId;
  membershipId: Types.ObjectId;
  targetUserId: Types.ObjectId;
  keyHash: string;
  fingerprintHash: string;
  command: string;
  status: 'COMMITTED';
  httpStatus: 200;
  resultBody: AcceptInvitationAcknowledgement;
  committedAt: Date;
  expiresAt: Date;
}

const operationRetentionMs = 24 * 60 * 60 * 1000;
const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

@Injectable()
export class MongoOrganizationInvitationRepository implements OrganizationInvitationRepositoryPort {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async listForRecipient(
    _userId: string,
    email: string,
    now: Date,
    page: number,
    pageSize: number,
  ): Promise<RecipientInvitationPage> {
    const pipeline: PipelineStage[] = [
      ...this.recipientJoinStages(email),
      {
        $match: {
          status: 'PENDING',
          expiresAt: { $gt: now },
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          data: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
          total: [{ $count: 'count' }],
        },
      },
    ];
    const result = await this.invitations()
      .aggregate<RecipientInvitationListRow>(pipeline)
      .exec();
    const facet = result[0] ?? { data: [], total: [] };
    return {
      data: facet.data.map((row) => this.mapInvitation(row)),
      pagination: {
        page,
        pageSize,
        totalItems: facet.total[0]?.count ?? 0,
        totalPages: Math.ceil((facet.total[0]?.count ?? 0) / pageSize),
      },
    };
  }

  async getForRecipient(
    invitationId: string,
    _userId: string,
    email: string,
    now: Date,
  ): Promise<RecipientInvitationDetail | null> {
    const [row] = await this.invitations()
      .aggregate<RecipientInvitationRow>([
        ...this.recipientJoinStages(email),
        { $match: { _id: new Types.ObjectId(invitationId) } },
        { $limit: 1 },
      ])
      .exec();
    if (!row) return null;
    const invitation = this.mapInvitation(row);
    if (
      invitation.status === 'PENDING' &&
      row.expiresAt.getTime() <= now.getTime()
    )
      invitation.status = 'EXPIRED';
    return { invitation };
  }

  async resolveByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<InvitationResolution | null> {
    const row = await this.invitations()
      .findOne({ contractVersion: 3, tokenHash })
      .lean()
      .exec();
    if (!row) return null;
    const organization = await this.model<{
      _id: Types.ObjectId;
      name: string;
    }>('organizations')
      .findById(row.organizationId, { name: 1 })
      .lean()
      .exec();
    if (!organization) return null;
    const status =
      row.status === 'PENDING' && row.expiresAt.getTime() <= now.getTime()
        ? 'EXPIRED'
        : row.status;
    return {
      invitation: {
        id: row._id.toHexString(),
        organizationId: row.organizationId.toHexString(),
        status,
        version: row.version,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        invitedEmail: row.email,
        organizationName: organization.name,
      },
    };
  }

  async acceptForRecipient(input: {
    invitationId: string;
    actorUserId: string;
    authenticatedEmail: string;
    expectedMembershipVersion: number;
    expectedInvitationVersion: number;
    readinessReady: boolean;
    idempotencyKey: string;
    now: Date;
  }): Promise<AcceptInvitationResult> {
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const invitationId = new Types.ObjectId(input.invitationId);
    const keyHash = sha256(input.idempotencyKey);
    const fingerprintHash = sha256(
      JSON.stringify({
        command: 'ACCEPT',
        invitationId: input.invitationId,
        expectedMembershipVersion: input.expectedMembershipVersion,
        expectedInvitationVersion: input.expectedInvitationVersion,
      }),
    );
    const session = await this.connectionOrThrow().startSession();
    let result: AcceptInvitationResult | undefined;
    try {
      await session.withTransaction(async () => {
        const actor = await this.model<AccountDocument>('users')
          .findOne({ _id: actorUserId, status: 'ACTIVE' })
          .session(session)
          .lean()
          .exec();
        if (!actor)
          throw new UnauthorizedException({ code: 'AUTHENTICATION_REQUIRED' });
        const invitation = await this.invitations()
          .findOne({ _id: invitationId, contractVersion: 3 })
          .session(session)
          .lean()
          .exec();
        if (!invitation)
          throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
        const currentEmail = normalizeEmail(actor.email);
        if (
          currentEmail !== input.authenticatedEmail ||
          currentEmail !== normalizeEmail(invitation.email)
        )
          throw new ForbiddenException({ code: 'INVITATION_EMAIL_MISMATCH' });

        const prior = await this.model<OperationDocument>(
          'membership_operations',
        )
          .findOne({
            actorUserId,
            organizationId: invitation.organizationId,
            keyHash,
            contractVersion: 3,
            command: 'ACCEPT',
          })
          .session(session)
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (
            prior.fingerprintHash !== fingerprintHash ||
            !prior.invitationId.equals(invitationId)
          )
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          result = { acknowledgement: prior.resultBody, replayed: true };
          return;
        }
        if (!input.readinessReady)
          throw new ServiceUnavailableException({
            code: 'IAM_MEMBERSHIP_DEPENDENCY_UNAVAILABLE',
          });
        if (prior)
          await this.model<OperationDocument>('membership_operations')
            .deleteOne(
              { _id: prior._id, expiresAt: { $lte: input.now } },
              { session },
            )
            .exec();

        if (invitation.expiresAt.getTime() <= input.now.getTime())
          throw new GoneException({ code: 'INVITATION_EXPIRED' });
        if (
          invitation.status !== 'PENDING' ||
          invitation.version !== input.expectedInvitationVersion
        )
          throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
        const organization = await this.model<{ _id: Types.ObjectId }>(
          'organizations',
        )
          .findById(invitation.organizationId, { _id: 1 })
          .session(session)
          .lean()
          .exec();
        if (!organization)
          throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
        const existingMembership = await this.model<MembershipDocument>(
          'organization_memberships',
        )
          .findOne({
            organizationId: invitation.organizationId,
            userId: actorUserId,
          })
          .session(session)
          .lean()
          .exec();
        if (
          (existingMembership?.version ?? 0) !== input.expectedMembershipVersion
        )
          throw new ConflictException({ code: 'MEMBERSHIP_VERSION_CONFLICT' });
        if (existingMembership)
          throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });

        const membershipId = new Types.ObjectId();
        await this.model<MembershipDocument>('organization_memberships').create(
          [
            {
              _id: membershipId,
              organizationId: invitation.organizationId,
              userId: actorUserId,
              status: 'ACTIVE',
              version: 1,
              mutationFence: 0,
            },
          ],
          { session },
        );
        const accepted = await this.invitations()
          .findOneAndUpdate(
            {
              _id: invitationId,
              organizationId: invitation.organizationId,
              contractVersion: 3,
              status: 'PENDING',
              version: input.expectedInvitationVersion,
              expiresAt: { $gt: input.now },
            },
            {
              $set: {
                status: 'ACCEPTED',
                acceptedAt: input.now,
                acceptedBy: actorUserId,
              },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!accepted)
          throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });

        const operationId = new Types.ObjectId();
        const acknowledgement: AcceptInvitationAcknowledgement = {
          operationId: operationId.toHexString(),
          membership: {
            id: membershipId.toHexString(),
            organizationId: invitation.organizationId.toHexString(),
            userId: actorUserId.toHexString(),
            status: 'ACTIVE',
            version: 1,
          },
          invitation: {
            id: accepted._id.toHexString(),
            status: 'ACCEPTED',
            version: accepted.version,
            expiresAt: accepted.expiresAt.toISOString(),
          },
        };
        await this.model<OperationDocument>('membership_operations').create(
          [
            {
              _id: operationId,
              actorUserId,
              organizationId: invitation.organizationId,
              contractVersion: 3,
              invitationId,
              membershipId,
              targetUserId: actorUserId,
              keyHash,
              fingerprintHash,
              command: 'ACCEPT',
              status: 'COMMITTED',
              httpStatus: 200,
              resultBody: acknowledgement,
              committedAt: input.now,
              expiresAt: new Date(input.now.getTime() + operationRetentionMs),
            },
          ],
          { session },
        );
        await this.connectionOrThrow()
          .useDb(AUDIT_DATABASE_NAME, { useCache: true })
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .insertOne(
            {
              eventId: randomUUID(),
              schemaVersion: 2,
              operationId: operationId.toHexString(),
              organizationId: invitation.organizationId.toHexString(),
              actorUserId: actorUserId.toHexString(),
              scope: 'ORGANIZATION',
              result: 'SUCCESS',
              action: 'ORGANIZATION_INVITATION_ACCEPTED',
              reasonCode: 'INVITATION_ACCEPTED',
              occurredAt: input.now,
              membershipId: membershipId.toHexString(),
              targetResource: 'ORGANIZATION_MEMBERSHIP',
              targetResourceId: membershipId.toHexString(),
              invitationIds: [invitationId.toHexString()],
              before: {
                membershipStatus: 'ABSENT',
                membershipVersion: 0,
                invitationStatus: 'PENDING',
                invitationVersion: invitation.version,
              },
              after: {
                membershipStatus: 'ACTIVE',
                membershipVersion: 1,
                invitationStatus: 'ACCEPTED',
                invitationVersion: accepted.version,
              },
            },
            { session },
          );
        result = { acknowledgement, replayed: false };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (isDuplicateKey(error)) {
        const prior = await this.model<OperationDocument>(
          'membership_operations',
        )
          .findOne({
            actorUserId,
            keyHash,
            command: 'ACCEPT',
            contractVersion: 3,
          })
          .lean()
          .exec();
        if (prior && prior.expiresAt.getTime() > input.now.getTime()) {
          if (prior.fingerprintHash !== fingerprintHash)
            throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
          return { acknowledgement: prior.resultBody, replayed: true };
        }
        throw new ConflictException({ code: 'INVITATION_NOT_ACCEPTABLE' });
      }
      throw new InternalServerErrorException({
        code: 'IAM_MEMBERSHIP_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    if (!result) throw new Error('Invitation acceptance returned no result');
    return result;
  }

  private recipientJoinStages(email: string): PipelineStage[] {
    return [
      {
        $match: {
          contractVersion: 3,
          email,
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      },
      { $unwind: '$organization' },
      {
        $project: {
          _id: 1,
          organizationId: 1,
          email: 1,
          status: 1,
          version: 1,
          expiresAt: 1,
          createdAt: 1,
          organizationName: '$organization.name',
        },
      },
    ];
  }

  private mapInvitation(row: RecipientInvitationRow): RecipientInvitation {
    return {
      id: row._id.toHexString(),
      organizationId: row.organizationId.toHexString(),
      status: row.status,
      version: row.version,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      invitedEmail: row.email,
      organizationName: row.organizationName,
    };
  }

  private invitations(): Model<RecipientInvitationRow> {
    return this.model<RecipientInvitationRow>('organization_invitations');
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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
