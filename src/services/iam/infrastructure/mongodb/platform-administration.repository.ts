import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection, Model, PipelineStage } from 'mongoose';
import type {
  PlatformAdministrationRepository,
  PlatformMembershipPage,
  PlatformMembershipSummary,
  PlatformOrganizationPage,
  PlatformOrganizationSummary,
  PlatformUserLookupResult,
} from '../../application/platform/platform-administration.repository';
import type { OrganizationMembershipStatus } from '../../application/organizations/organization-membership-read.repository';
import { IAM_PERSISTENCE } from '../persistence';

const modelName = (name: string) => `${IAM_PERSISTENCE.databaseName}_${name}`;
const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);
const maxPageSize = 100;

interface OrganizationDocument {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  plan: 'FREE' | 'ENTERPRISE';
  createdAt: Date;
  updatedAt: Date;
}

interface ActiveUserDocument {
  _id: Types.ObjectId;
  email: string;
  fullName: string;
  status: 'ACTIVE';
}

interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: OrganizationMembershipStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    _id: Types.ObjectId;
    fullName: string;
    email: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
  } | null;
  roles?: { code: string }[];
}

interface MembershipFacet {
  data: MembershipDocument[];
  total: { count: number }[];
}

function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'IAM_PLATFORM_ADMINISTRATION_UNAVAILABLE',
  });
}

function mapOrganization(
  row: OrganizationDocument,
): PlatformOrganizationSummary {
  if (
    !(row._id instanceof Types.ObjectId) ||
    typeof row.name !== 'string' ||
    typeof row.slug !== 'string' ||
    !['FREE', 'ENTERPRISE'].includes(row.plan) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  )
    unavailable();
  return {
    id: row._id.toHexString(),
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapMembership(row: MembershipDocument): PlatformMembershipSummary {
  if (
    !(row._id instanceof Types.ObjectId) ||
    !(row.organizationId instanceof Types.ObjectId) ||
    !(row.userId instanceof Types.ObjectId) ||
    !['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'].includes(
      row.status,
    ) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  )
    unavailable();

  const user = row.user;
  if (
    user &&
    (!(user._id instanceof Types.ObjectId) ||
      typeof user.fullName !== 'string' ||
      typeof user.email !== 'string' ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(user.status))
  )
    unavailable();

  return {
    id: row._id.toHexString(),
    organizationId: row.organizationId.toHexString(),
    userId: row.userId.toHexString(),
    status: row.status,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    user: user
      ? {
          id: user._id.toHexString(),
          email: user.email,
          fullName: user.fullName,
          accountStatus: user.status,
        }
      : null,
    organizationRoles: [
      ...new Set(
        (row.roles ?? [])
          .map(({ code }) => code)
          .filter(
            (code): code is 'ADMIN' | 'MEMBER' =>
              code === 'ADMIN' || code === 'MEMBER',
          ),
      ),
    ].sort(),
  };
}

@Injectable()
export class MongoPlatformAdministrationRepository implements PlatformAdministrationRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
  ) {}

  async listOrganizations(
    page: number,
    pageSize: number,
  ): Promise<PlatformOrganizationPage> {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > maxPageSize
    )
      unavailable();
    const [facet] = await this.organizations()
      .aggregate<{
        data: OrganizationDocument[];
        total: { count: number }[];
      }>([
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (page - 1) * pageSize },
              { $limit: pageSize },
              {
                $project: {
                  _id: 1,
                  name: 1,
                  slug: 1,
                  plan: 1,
                  createdAt: 1,
                  updatedAt: 1,
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
      data: (facet?.data ?? []).map(mapOrganization),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  }

  async findOrganization(
    id: string,
  ): Promise<PlatformOrganizationSummary | null> {
    if (!validId(id)) return null;
    const row = await this.organizations()
      .findById(new Types.ObjectId(id))
      .select({ _id: 1, name: 1, slug: 1, plan: 1, createdAt: 1, updatedAt: 1 })
      .lean()
      .exec();
    return row ? mapOrganization(row) : null;
  }

  async findActiveUserByExactEmail(
    email: string,
  ): Promise<PlatformUserLookupResult | null> {
    const row = await this.users()
      .findOne({ email, status: 'ACTIVE' })
      .select({ _id: 1, email: 1, fullName: 1, status: 1 })
      .lean()
      .exec();
    if (!row) return null;
    if (
      !(row._id instanceof Types.ObjectId) ||
      row.email !== email ||
      typeof row.fullName !== 'string' ||
      row.status !== 'ACTIVE'
    )
      unavailable();
    return {
      id: row._id.toHexString(),
      email: row.email,
      fullName: row.fullName,
      status: 'ACTIVE',
    };
  }

  async listOrganizationMemberships(input: {
    organizationId: string;
    page: number;
    pageSize: number;
    status?: OrganizationMembershipStatus;
  }): Promise<PlatformMembershipPage> {
    if (
      !validId(input.organizationId) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize
    )
      unavailable();
    const organizationId = new Types.ObjectId(input.organizationId);
    const match: Record<string, unknown> = { organizationId };
    if (input.status) match.status = input.status;
    const roleLookup: (
      PipelineStage.Lookup | PipelineStage.Unwind | PipelineStage.Project
    )[] = [
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          pipeline: [
            { $project: { _id: 1, email: 1, fullName: 1, status: 1 } },
          ],
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'role_assignments',
          let: { membershipUserId: '$userId' },
          pipeline: [
            {
              $match: {
                organizationId,
                projectId: null,
                $expr: { $eq: ['$userId', '$$membershipUserId'] },
              },
            },
            { $project: { _id: 0, code: '$roleCode' } },
          ],
          as: 'roles',
        },
      },
      {
        $project: {
          _id: 1,
          organizationId: 1,
          userId: 1,
          status: 1,
          version: 1,
          createdAt: 1,
          updatedAt: 1,
          user: 1,
          roles: 1,
        },
      },
    ];
    const [facet] = await this.memberships()
      .aggregate<MembershipFacet>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (input.page - 1) * input.pageSize },
              { $limit: input.pageSize },
              ...roleLookup,
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map(mapMembership),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  private organizations(): Model<OrganizationDocument> {
    return this.model<OrganizationDocument>('organizations');
  }

  private users(): Model<ActiveUserDocument> {
    return this.model<ActiveUserDocument>('users');
  }

  private memberships(): Model<MembershipDocument> {
    return this.model<MembershipDocument>('organization_memberships');
  }

  private model<T>(name: string): Model<T> {
    const model = this.connection?.models[modelName(name)] as
      Model<T> | undefined;
    if (!model) unavailable();
    return model;
  }
}
