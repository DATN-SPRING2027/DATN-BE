import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model, PipelineStage } from 'mongoose';
import type {
  OrganizationInvitationRepository as OrganizationInvitationRepositoryPort,
  RecipientInvitation,
  RecipientInvitationDetail,
  RecipientInvitationPage,
  RecipientInvitationStatus,
} from '../../application/organizations/organization-invitation.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface RecipientInvitationRow {
  _id: Types.ObjectId;
  membershipId: Types.ObjectId;
  organizationId: Types.ObjectId;
  status: RecipientInvitationStatus;
  version: number;
  expiresAt: Date;
  createdAt: Date;
  membershipVersion: number;
  membershipStatus: 'PENDING_INVITE' | 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
  organizationName: string;
}

interface RecipientInvitationListRow {
  data: RecipientInvitationRow[];
  total: Array<{ count: number }>;
}

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;

@Injectable()
export class MongoOrganizationInvitationRepository implements OrganizationInvitationRepositoryPort {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async listForRecipient(
    userId: string,
    email: string,
    now: Date,
    page: number,
    pageSize: number,
  ): Promise<RecipientInvitationPage> {
    const pipeline: PipelineStage[] = [
      ...this.recipientJoinStages(userId, email),
      {
        $match: {
          status: 'PENDING',
          expiresAt: { $gt: now },
          membershipStatus: 'PENDING_INVITE',
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
    userId: string,
    email: string,
    now: Date,
  ): Promise<RecipientInvitationDetail | null> {
    const [row] = await this.invitations()
      .aggregate<RecipientInvitationRow>([
        ...this.recipientJoinStages(userId, email),
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
    return {
      membership: {
        id: invitation.membershipId,
        status: row.membershipStatus,
        version: row.membershipVersion,
      },
      invitation,
    };
  }

  private recipientJoinStages(userId: string, email: string): PipelineStage[] {
    return [
      {
        $match: {
          contractVersion: 2,
          targetUserId: new Types.ObjectId(userId),
          email,
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
          $expr: { $eq: ['$membership.organizationId', '$organizationId'] },
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
          membershipId: 1,
          organizationId: 1,
          status: 1,
          version: 1,
          expiresAt: 1,
          createdAt: 1,
          membershipVersion: '$membership.version',
          membershipStatus: '$membership.status',
          organizationName: '$organization.name',
        },
      },
    ];
  }

  private mapInvitation(row: RecipientInvitationRow): RecipientInvitation {
    return {
      id: row._id.toHexString(),
      membershipId: row.membershipId.toHexString(),
      organizationId: row.organizationId.toHexString(),
      status: row.status,
      version: row.version,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      membershipVersion: row.membershipVersion,
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
