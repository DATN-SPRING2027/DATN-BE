import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  OrganizationProvisioningInput,
  OrganizationProvisioningRepository,
  ProvisionedOrganization,
} from '../../application/organizations/organization-provisioning.repository';
import { IAM_PERSISTENCE } from '../persistence';

interface UserDocument {
  _id: Types.ObjectId;
  status: string;
}

interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
}

interface OrganizationDocument {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  plan: 'FREE' | 'ENTERPRISE';
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipDocument {
  _id: Types.ObjectId;
}

interface RoleAssignmentDocument {
  _id: Types.ObjectId;
}

const modelName = (collection: string): string =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class MongoOrganizationProvisioningRepository implements OrganizationProvisioningRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async create(
    actorUserId: string,
    input: OrganizationProvisioningInput,
  ): Promise<ProvisionedOrganization> {
    if (!validId(actorUserId) || !validId(input.firstAdminUserId))
      throw new Error('Trusted Organization provisioning identity is invalid');
    if (!this.connection)
      throw new Error('Organization provisioning persistence unavailable');

    const session = await this.connection.startSession();
    try {
      let created: ProvisionedOrganization | undefined;
      await session.withTransaction(async () => {
        const firstAdmin = await this.model<UserDocument>('users')
          .findOne(
            {
              _id: new Types.ObjectId(input.firstAdminUserId),
              status: 'ACTIVE',
            },
            { _id: 1, status: 1 },
          )
          .session(session)
          .lean()
          .exec();
        const adminRole = await this.model<RoleDocument>('roles')
          .findOne({ code: 'ADMIN' }, { _id: 1, code: 1 })
          .session(session)
          .lean()
          .exec();
        if (!firstAdmin || firstAdmin.status !== 'ACTIVE')
          throw new ConflictException({
            code: 'ORGANIZATION_ADMIN_UNAVAILABLE',
            message: 'The first Organization ADMIN is unavailable.',
          });
        if (!adminRole || adminRole.code !== 'ADMIN')
          throw new Error('Organization bootstrap requires the ADMIN Role');

        let organization: OrganizationDocument;
        try {
          const [row] = await this.model<OrganizationDocument>(
            'organizations',
          ).create(
            [
              {
                name: input.name,
                slug: input.slug,
                plan: input.plan,
              },
            ],
            { session },
          );
          organization = row.toObject();
        } catch (cause) {
          if (
            typeof cause === 'object' &&
            cause !== null &&
            'code' in cause &&
            (cause as { code?: unknown }).code === 11000
          )
            throw new ConflictException({
              code: 'ORGANIZATION_SLUG_CONFLICT',
              message: 'Organization slug already exists.',
            });
          throw cause;
        }

        const organizationId = organization._id;
        const userId = new Types.ObjectId(input.firstAdminUserId);
        const actorId = new Types.ObjectId(actorUserId);
        const [membership] = await this.model<MembershipDocument>(
          'organization_memberships',
        ).create(
          [
            {
              organizationId,
              userId,
              status: 'ACTIVE',
            },
          ],
          { session },
        );
        const [roleAssignment] = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        ).create(
          [
            {
              organizationId,
              userId,
              roleId: adminRole._id,
              roleCode: 'ADMIN',
              assignedBy: actorId,
            },
          ],
          { session },
        );

        await this.connection!.useDb(this.auditDatabaseName, { useCache: true })
          .collection(IAM_AUDIT_COLLECTION_NAME)
          .insertOne(
            {
              actorUserId,
              action: 'organization.create',
              targetResource: 'ORGANIZATION',
              targetResourceId: String(organizationId),
              metadata: {
                bootstrap: {
                  firstAdminUserId: input.firstAdminUserId,
                  membershipId: String(membership._id),
                  roleAssignmentId: String(roleAssignment._id),
                  roleCode: 'ADMIN',
                },
              },
              occurredAt: new Date(),
            },
            { session },
          );

        created = {
          id: String(organization._id),
          name: organization.name,
          slug: organization.slug,
          plan: organization.plan,
          createdAt: organization.createdAt.toISOString(),
          updatedAt: organization.updatedAt.toISOString(),
        };
      });
      if (!created)
        throw new Error(
          'Organization provisioning transaction created no record',
        );
      return created;
    } finally {
      await session.endSession();
    }
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(
        `Organization provisioning persistence unavailable: ${collection}`,
      );
    return model;
  }
}
