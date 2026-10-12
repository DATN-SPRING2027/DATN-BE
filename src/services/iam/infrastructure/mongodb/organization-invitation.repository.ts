import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model, ClientSession, Collection } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  CreateOrganizationInvitationInput,
  InvitationRoleCode,
  OrganizationInvitation,
  OrganizationInvitationRepository as OrganizationInvitationRepositoryPort,
} from '../../application/organizations/organization-invitation.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface InvitationDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  email: string;
  roleCode: InvitationRoleCode;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  invitedBy: Types.ObjectId;
  expiresAt: Date;
  acceptedAt?: Date;
  acceptedBy?: Types.ObjectId;
  revokedAt?: Date;
  revokedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
interface UserDocument {
  _id: Types.ObjectId;
  email: string;
  status: string;
}
interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: string;
}
interface RoleDocument {
  _id: Types.ObjectId;
  code: InvitationRoleCode;
}
interface RoleAssignmentDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId?: Types.ObjectId | null;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: InvitationRoleCode;
  assignedBy: Types.ObjectId;
}
interface OrganizationDocument {
  _id: Types.ObjectId;
  name: string;
}
interface AuditDocument {
  organizationId: Types.ObjectId;
  actorUserId: Types.ObjectId;
  action: string;
  targetResource: string;
  targetResourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
interface InvitationWithOrganization extends InvitationDocument {
  organizationName: string;
}

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const orgRole = {
  $or: [{ projectId: { $exists: false } }, { projectId: null }],
};

@Injectable()
export class MongoOrganizationInvitationRepository implements OrganizationInvitationRepositoryPort {
  constructor(
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection: Connection,
  ) {}

  async isOrganizationAdmin(
    organizationId: string,
    userId: string,
  ): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(organizationId) ||
      !Types.ObjectId.isValid(userId)
    )
      return false;
    return this.isAdminAt(
      new Types.ObjectId(organizationId),
      new Types.ObjectId(userId),
    );
  }

  async create(
    input: CreateOrganizationInvitationInput,
  ): Promise<OrganizationInvitation> {
    if (
      !Types.ObjectId.isValid(input.organizationId) ||
      !Types.ObjectId.isValid(input.invitedBy)
    )
      throw new ForbiddenException({ code: 'ORGANIZATION_CONTEXT_REQUIRED' });
    const organizationObjectId = new Types.ObjectId(input.organizationId);
    const inviterObjectId = new Types.ObjectId(input.invitedBy);
    const session = await this.connection.startSession();
    let invitation: InvitationWithOrganization | null = null;
    try {
      await session.withTransaction(async () => {
        if (
          !(await this.isAdminAt(
            organizationObjectId,
            inviterObjectId,
            session,
          ))
        )
          throw new ForbiddenException({ code: 'ORGANIZATION_ADMIN_REQUIRED' });

        const organization = await this.organizations()
          .findById(organizationObjectId, { name: 1 })
          .session(session)
          .lean()
          .exec();
        if (!organization)
          throw new ConflictException({ code: 'ORGANIZATION_NOT_AVAILABLE' });

        const existingUser = await this.users()
          .findOne({ email: input.email }, { _id: 1, status: 1 })
          .session(session)
          .lean()
          .exec();
        if (existingUser?.status === 'ACTIVE') {
          const activeMembership = await this.memberships()
            .exists({
              organizationId: organizationObjectId,
              userId: existingUser._id,
              status: 'ACTIVE',
            })
            .session(session);
          if (activeMembership)
            throw new ConflictException({
              code: 'INVITATION_TARGET_ALREADY_MEMBER',
            });
        }

        await this.invitations()
          .updateMany(
            {
              organizationId: organizationObjectId,
              email: input.email,
              status: 'PENDING',
              expiresAt: { $lte: new Date() },
            },
            { $set: { status: 'EXPIRED' } },
            { session },
          )
          .exec();

        const [created] = await this.invitations().create(
          [
            {
              organizationId: organizationObjectId,
              email: input.email,
              roleCode: input.roleCode,
              status: 'PENDING',
              invitedBy: inviterObjectId,
              expiresAt: input.expiresAt,
            },
          ],
          { session },
        );
        await this.writeAudit(
          {
            organizationId: organizationObjectId,
            actorUserId: inviterObjectId,
            action: 'ORGANIZATION_INVITATION_CREATED',
            targetResource: 'organization_invitation',
            targetResourceId: String(created._id),
            metadata: { roleCode: input.roleCode },
            occurredAt: new Date(),
          },
          session,
        );
        invitation = {
          ...created.toObject(),
          organizationName: organization.name,
        };
      });
    } catch (error) {
      if (isDuplicateKey(error))
        throw new ConflictException({ code: 'INVITATION_ALREADY_PENDING' });
      throw error;
    } finally {
      await session.endSession();
    }
    if (!invitation)
      throw new Error('Invitation transaction returned no result');
    return this.map(invitation);
  }

  listForOrganization(
    organizationId: string,
    now: Date,
    limit: number,
  ): Promise<OrganizationInvitation[]> {
    return this.list(
      { organizationId: new Types.ObjectId(organizationId) },
      now,
      limit,
    );
  }

  listForRecipient(
    email: string,
    now: Date,
    limit: number,
  ): Promise<OrganizationInvitation[]> {
    return this.list({ email }, now, limit);
  }

  async revoke(input: {
    invitationId: string;
    organizationId: string;
    actorUserId: string;
    now: Date;
  }): Promise<boolean> {
    if (
      !Types.ObjectId.isValid(input.invitationId) ||
      !Types.ObjectId.isValid(input.organizationId) ||
      !Types.ObjectId.isValid(input.actorUserId)
    )
      return false;
    const organizationId = new Types.ObjectId(input.organizationId);
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const session = await this.connection.startSession();
    let revoked = false;
    try {
      await session.withTransaction(async () => {
        if (!(await this.isAdminAt(organizationId, actorUserId, session)))
          throw new ForbiddenException({ code: 'ORGANIZATION_ADMIN_REQUIRED' });
        const invitation = await this.invitations()
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(input.invitationId),
              organizationId,
              status: 'PENDING',
              expiresAt: { $gt: input.now },
            },
            {
              $set: {
                status: 'REVOKED',
                revokedAt: input.now,
                revokedBy: actorUserId,
              },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!invitation) return;
        await this.writeAudit(
          {
            organizationId,
            actorUserId,
            action: 'ORGANIZATION_INVITATION_REVOKED',
            targetResource: 'organization_invitation',
            targetResourceId: input.invitationId,
            metadata: { roleCode: invitation.roleCode },
            occurredAt: input.now,
          },
          session,
        );
        revoked = true;
      });
    } finally {
      await session.endSession();
    }
    return revoked;
  }

  async accept(input: {
    invitationId: string;
    userId: string;
    email: string;
    now: Date;
  }): Promise<{ organizationId: string; organizationName: string } | null> {
    if (
      !Types.ObjectId.isValid(input.invitationId) ||
      !Types.ObjectId.isValid(input.userId)
    )
      return null;
    const userId = new Types.ObjectId(input.userId);
    const session = await this.connection.startSession();
    let result: { organizationId: string; organizationName: string } | null =
      null;
    try {
      await session.withTransaction(async () => {
        const invitation = await this.invitations()
          .findOne({
            _id: new Types.ObjectId(input.invitationId),
            email: input.email,
            status: 'PENDING',
            expiresAt: { $gt: input.now },
          })
          .session(session)
          .lean()
          .exec();
        if (!invitation) return;

        const user = await this.users()
          .findOne({ _id: userId, email: input.email, status: 'ACTIVE' })
          .session(session)
          .lean()
          .exec();
        if (!user) return;

        const organization = await this.organizations()
          .findById(invitation.organizationId, { name: 1 })
          .session(session)
          .lean()
          .exec();
        if (!organization) return;

        const membership = await this.memberships()
          .findOne({ organizationId: invitation.organizationId, userId })
          .session(session)
          .lean()
          .exec();
        if (membership && membership.status !== 'PENDING_INVITE') return;

        const role = await this.roles()
          .findOne({ code: invitation.roleCode }, { _id: 1 })
          .session(session)
          .lean()
          .exec();
        if (!role)
          throw new Error(
            `Invitation Role is unavailable: ${invitation.roleCode}`,
          );

        const consumed = await this.invitations()
          .findOneAndUpdate(
            {
              _id: invitation._id,
              email: input.email,
              status: 'PENDING',
              expiresAt: { $gt: input.now },
            },
            {
              $set: {
                status: 'ACCEPTED',
                acceptedAt: input.now,
                acceptedBy: userId,
              },
            },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!consumed) return;

        if (membership) {
          await this.memberships()
            .updateOne(
              { _id: membership._id, status: 'PENDING_INVITE' },
              { $set: { status: 'ACTIVE' } },
              { session },
            )
            .exec();
        } else {
          await this.memberships().create(
            [
              {
                organizationId: invitation.organizationId,
                userId,
                status: 'ACTIVE',
              },
            ],
            { session },
          );
        }

        const roleAssignment = await this.assignments()
          .findOne({
            organizationId: invitation.organizationId,
            userId,
            ...orgRole,
          })
          .session(session)
          .lean()
          .exec();
        if (roleAssignment) {
          await this.assignments()
            .updateOne(
              { _id: roleAssignment._id },
              {
                $set: {
                  roleId: role._id,
                  roleCode: invitation.roleCode,
                  assignedBy: invitation.invitedBy,
                },
              },
              { session },
            )
            .exec();
        } else {
          await this.assignments().create(
            [
              {
                organizationId: invitation.organizationId,
                userId,
                roleId: role._id,
                roleCode: invitation.roleCode,
                assignedBy: invitation.invitedBy,
              },
            ],
            { session },
          );
        }

        await this.writeAudit(
          {
            organizationId: invitation.organizationId,
            actorUserId: userId,
            action: 'ORGANIZATION_INVITATION_ACCEPTED',
            targetResource: 'organization_invitation',
            targetResourceId: input.invitationId,
            metadata: {
              roleCode: invitation.roleCode,
              invitedBy: String(invitation.invitedBy),
            },
            occurredAt: input.now,
          },
          session,
        );
        result = {
          organizationId: String(invitation.organizationId),
          organizationName: organization.name,
        };
      });
    } catch (error) {
      if (isDuplicateKey(error)) return null;
      throw error;
    } finally {
      await session.endSession();
    }
    return result;
  }

  private async list(
    filter: { organizationId?: Types.ObjectId; email?: string },
    now: Date,
    limit: number,
  ): Promise<OrganizationInvitation[]> {
    const invitations = await this.invitations()
      .find({ ...filter, status: 'PENDING', expiresAt: { $gt: now } })
      .sort({ expiresAt: 1, _id: 1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .lean()
      .exec();
    if (invitations.length === 0) return [];
    const organizationIds = [
      ...new Map(
        invitations.map((invitation) => [
          String(invitation.organizationId),
          invitation.organizationId,
        ]),
      ).values(),
    ];
    const organizations = await this.organizations()
      .find({ _id: { $in: organizationIds } }, { name: 1 })
      .lean()
      .exec();
    const names = new Map(
      organizations.map((organization) => [
        String(organization._id),
        organization.name,
      ]),
    );
    return invitations.flatMap((invitation) => {
      const organizationName = names.get(String(invitation.organizationId));
      return organizationName
        ? [this.map({ ...invitation, organizationName })]
        : [];
    });
  }

  private map(invitation: InvitationWithOrganization): OrganizationInvitation {
    return {
      id: String(invitation._id),
      organizationId: String(invitation.organizationId),
      organizationName: invitation.organizationName,
      email: invitation.email,
      roleCode: invitation.roleCode,
      status: invitation.status,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  private async isAdminAt(
    organizationId: Types.ObjectId,
    userId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<boolean> {
    const membership = await this.memberships()
      .exists({ organizationId, userId, status: 'ACTIVE' })
      .session(session ?? null);
    if (!membership) return false;
    const assignment = await this.assignments()
      .exists({ organizationId, userId, roleCode: 'ADMIN', ...orgRole })
      .session(session ?? null);
    if (!assignment) return false;
    return Boolean(
      await this.users()
        .exists({ _id: userId, status: 'ACTIVE' })
        .session(session ?? null),
    );
  }

  private async writeAudit(
    input: AuditDocument,
    session: ClientSession,
  ): Promise<void> {
    await this.audit().insertOne(
      { ...input, createdAt: input.occurredAt, updatedAt: input.occurredAt },
      { session },
    );
  }

  private model<T>(name: string): Model<T> {
    const model = this.connection.models[modelName(name)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(
        `Organization invitation persistence unavailable: ${name}`,
      );
    return model;
  }

  private invitations(): Model<InvitationDocument> {
    return this.model('organization_invitations');
  }
  private users(): Model<UserDocument> {
    return this.model('users');
  }
  private memberships(): Model<MembershipDocument> {
    return this.model('organization_memberships');
  }
  private roles(): Model<RoleDocument> {
    return this.model('roles');
  }
  private assignments(): Model<RoleAssignmentDocument> {
    return this.model('role_assignments');
  }
  private organizations(): Model<OrganizationDocument> {
    return this.model('organizations');
  }
  private audit(): Collection<AuditDocument> {
    return this.connection
      .useDb(AUDIT_DATABASE_NAME, { useCache: true })
      .collection(
        IAM_AUDIT_COLLECTION_NAME,
      ) as unknown as Collection<AuditDocument>;
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}
