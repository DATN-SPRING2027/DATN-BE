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
import type { ClientSession, Connection, Model, PipelineStage } from 'mongoose';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import type {
  PlatformEffectivePermissionProjection,
  PlatformAdministrationRepository,
  PlatformMembershipPage,
  PlatformMembershipListInput,
  PlatformMembershipSummary,
  PlatformOrganizationPage,
  PlatformOrganizationSummary,
  PlatformUserDetail,
  PlatformUserListInput,
  PlatformUserPage,
  PlatformUserOrganizationsInput,
  PlatformUserOrganizationsPage,
  PlatformUserStatusChangeInput,
  PlatformUserProfileChangeInput,
  PlatformUserArchiveInput,
  PlatformUserRestoreInput,
  PlatformUserLookupResult,
  PlatformUserSummary,
  PlatformProjectListInput,
  PlatformProjectMembershipListInput,
  PlatformProjectMemberPage,
  PlatformProjectMemberSummary,
  PlatformProjectPage,
  PlatformProjectSummary,
  PlatformDashboardSummary,
  PlatformProjectMetadataChangeInput,
  PlatformOrganizationMetadataChangeInput,
  PlatformSessionListInput,
  PlatformSessionMutationInput,
  PlatformSessionVersionInput,
  PlatformSessionSummary,
  PlatformSessionPage,
  PlatformSessionMutationResult,
  PlatformRevokeSessionsInput,
} from '../../application/platform/platform-administration.repository';
import type { OrganizationMembershipStatus } from '../../application/organizations/organization-membership-read.repository';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from '../../application/authorization/authorization.policy';
import type { UserStatus } from '../../application/users/user-directory.repository';
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

interface PlatformUserDocument {
  _id: Types.ObjectId;
  email: string;
  fullName: string;
  avatarUrl?: string | null;
  status: UserStatus;
  archivedAt?: Date | null;
  archivedBy?: Types.ObjectId | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  mutationFence?: number;
  memberships?: PlatformUserMembershipDocument[];
}

interface PlatformUserMembershipDocument {
  organizationId: Types.ObjectId;
  status: OrganizationMembershipStatus;
  organization?: { name: string; slug: string } | null;
  roles?: { code: string }[];
}

interface PlatformAuthorityDocument {
  _id: Types.ObjectId;
  permission: PlatformPermission;
  scope: string;
  status: string;
  grantedAt: Date;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

interface PlatformRoleAssignmentDocument {
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
}

interface PlatformRoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}

interface PlatformAuthorityLockDocument {
  permission: string;
  scope: 'PLATFORM';
  version: number;
}

interface PlatformRefreshSessionDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId?: string;
  userFence?: number;
  organizationId?: Types.ObjectId | null;
  context?: string;
  isRevoked?: boolean;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface PlatformSessionAggregate {
  _id: string;
  userId: Types.ObjectId;
  sessionId: string;
  context: string;
  organizationId?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
}

interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: OrganizationMembershipStatus;
  version?: number;
  createdAt: Date;
  updatedAt: Date;
  user?: {
    _id: Types.ObjectId;
    fullName: string;
    email: string;
    status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_INVITE';
  } | null;
  organization?: {
    _id: Types.ObjectId;
    name: string;
    slug: string;
  } | null;
  roles?: { code: string }[];
}

interface MembershipFacet {
  data: MembershipDocument[];
  total: { count: number }[];
}

interface PlatformUserOrganizationsFacet {
  data: PlatformUserMembershipDocument[];
  total: { count: number }[];
}

interface PlatformUserFacet {
  data: PlatformUserDocument[];
  total: { count: number }[];
}

interface PlatformProjectDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  code: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
  updatedAt: Date;
  organization?: { _id: Types.ObjectId; name: string; slug: string } | null;
  memberStats?: { count: number }[];
  leaders?: Array<{
    user?: { _id: Types.ObjectId; email: string; fullName: string } | null;
  }>;
}

interface PlatformProjectMembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: Date;
  user?: {
    _id: Types.ObjectId;
    email: string;
    fullName: string;
    status: string;
  } | null;
}

interface PlatformProjectMembershipFacet {
  data: PlatformProjectMembershipDocument[];
  total: { count: number }[];
}

interface StatusCount {
  _id: string;
  count: number;
}

function unavailable(): never {
  throw new ServiceUnavailableException({
    code: 'IAM_PLATFORM_ADMINISTRATION_UNAVAILABLE',
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const version = row.version;
  if (
    !(row._id instanceof Types.ObjectId) ||
    !(row.organizationId instanceof Types.ObjectId) ||
    !(row.userId instanceof Types.ObjectId) ||
    !['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'].includes(
      row.status,
    ) ||
    (version !== undefined &&
      (!Number.isSafeInteger(version) || version < 1)) ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !(row.updatedAt instanceof Date) ||
    !Number.isFinite(row.updatedAt.getTime())
  )
    unavailable();

  const user = row.user;
  const organization = row.organization;
  if (
    user &&
    (!(user._id instanceof Types.ObjectId) ||
      typeof user.fullName !== 'string' ||
      typeof user.email !== 'string' ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(user.status))
  )
    unavailable();
  if (
    organization &&
    (!(organization._id instanceof Types.ObjectId) ||
      typeof organization.name !== 'string' ||
      typeof organization.slug !== 'string')
  )
    unavailable();

  return {
    id: row._id.toHexString(),
    organizationId: row.organizationId.toHexString(),
    userId: row.userId.toHexString(),
    status: row.status,
    version: version ?? 1,
    hasPersistedVersion: version !== undefined,
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
    ...(organization
      ? {
          organization: {
            id: organization._id.toHexString(),
            name: organization.name,
            slug: organization.slug,
          },
        }
      : {}),
  };
}

function mapPlatformProjectMember(
  row: PlatformProjectMembershipDocument,
): PlatformProjectMemberSummary {
  if (
    !(row._id instanceof Types.ObjectId) ||
    !(row.organizationId instanceof Types.ObjectId) ||
    !(row.projectId instanceof Types.ObjectId) ||
    !(row.userId instanceof Types.ObjectId) ||
    !['ACTIVE', 'INACTIVE'].includes(row.status) ||
    !(row.joinedAt instanceof Date) ||
    !Number.isFinite(row.joinedAt.getTime())
  )
    unavailable();
  const user = row.user;
  if (
    user &&
    (!(user._id instanceof Types.ObjectId) ||
      typeof user.email !== 'string' ||
      typeof user.fullName !== 'string' ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(user.status))
  )
    unavailable();
  return {
    id: row._id.toHexString(),
    organizationId: row.organizationId.toHexString(),
    projectId: row.projectId.toHexString(),
    userId: row.userId.toHexString(),
    status: row.status,
    joinedAt: row.joinedAt.toISOString(),
    user: user
      ? {
          id: user._id.toHexString(),
          email: user.email,
          fullName: user.fullName,
          accountStatus: user.status,
        }
      : null,
  };
}

@Injectable()
export class MongoPlatformAdministrationRepository implements PlatformAdministrationRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
  ) {}

  async listUsers(input: PlatformUserListInput): Promise<PlatformUserPage> {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize ||
      (input.organizationId !== undefined && !validId(input.organizationId))
    )
      unavailable();

    const match: Record<string, unknown> = {};
    if (input.status === 'ARCHIVED') {
      match.archivedAt = { $type: 'date' };
    } else if (input.status) {
      match.status = input.status;
      match.archivedAt = null;
    }
    if (input.search) {
      const search = new RegExp(escapeRegex(input.search), 'i');
      match.$or = [{ email: search }, { fullName: search }];
    }
    const organizationId = input.organizationId
      ? new Types.ObjectId(input.organizationId)
      : undefined;
    const pipeline: PipelineStage[] = [
      { $match: match },
      this.userMembershipLookup(organizationId, input.roleCode),
      ...(organizationId || input.roleCode
        ? [{ $match: { 'memberships.0': { $exists: true } } } as PipelineStage]
        : []),
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          data: [
            { $skip: (input.page - 1) * input.pageSize },
            { $limit: input.pageSize },
            {
              $project: {
                _id: 1,
                email: 1,
                fullName: 1,
                avatarUrl: 1,
                status: 1,
                archivedAt: 1,
                createdAt: 1,
                updatedAt: 1,
                memberships: 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];
    const [facet] = await this.users()
      .aggregate<PlatformUserFacet>(pipeline)
      .allowDiskUse(true)
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map((row) => this.mapPlatformUser(row)),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async listProjects(
    input: PlatformProjectListInput,
  ): Promise<PlatformProjectPage> {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize ||
      (input.organizationId !== undefined && !validId(input.organizationId))
    )
      unavailable();
    const match: Record<string, unknown> = {};
    if (input.organizationId)
      match.organizationId = new Types.ObjectId(input.organizationId);
    if (input.visibility) match.visibility = input.visibility;
    if (input.status) match.status = input.status;
    if (input.search) {
      const literal = new RegExp(escapeRegex(input.search), 'i');
      match.$or = [
        { name: literal },
        { code: literal },
        { 'organization.name': literal },
        { 'organization.slug': literal },
      ];
    }
    const [facet] = await this.projects()
      .aggregate<{
        data: PlatformProjectDocument[];
        total: { count: number }[];
      }>([
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            pipeline: [{ $project: { _id: 1, name: 1, slug: 1 } }],
            as: 'organization',
          },
        },
        { $unwind: '$organization' },
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (input.page - 1) * input.pageSize },
              { $limit: input.pageSize },
              ...this.projectSummaryStages(),
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map((row) => this.mapProject(row)),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async findProject(id: string): Promise<PlatformProjectSummary | null> {
    if (!validId(id)) return null;
    const [row] = await this.projects()
      .aggregate<PlatformProjectDocument>([
        { $match: { _id: new Types.ObjectId(id) } },
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            pipeline: [{ $project: { _id: 1, name: 1, slug: 1 } }],
            as: 'organization',
          },
        },
        { $unwind: '$organization' },
        ...this.projectSummaryStages(),
      ])
      .exec();
    return row ? this.mapProject(row) : null;
  }

  async listProjectMemberships(
    input: PlatformProjectMembershipListInput,
  ): Promise<PlatformProjectMemberPage> {
    if (
      !validId(input.projectId) ||
      !validId(input.organizationId) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize
    )
      unavailable();
    const match: Record<string, unknown> = {
      projectId: new Types.ObjectId(input.projectId),
      organizationId: new Types.ObjectId(input.organizationId),
    };
    if (input.status) match.status = input.status;
    const search = input.search
      ? new RegExp(escapeRegex(input.search), 'i')
      : undefined;
    const [facet] = await this.model<PlatformProjectMembershipDocument>(
      'project_memberships',
    )
      .aggregate<PlatformProjectMembershipFacet>([
        { $match: match },
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
        ...(search
          ? ([
              {
                $match: {
                  $or: [{ 'user.email': search }, { 'user.fullName': search }],
                },
              },
            ] as PipelineStage[])
          : []),
        { $sort: { joinedAt: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: (input.page - 1) * input.pageSize },
              { $limit: input.pageSize },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .allowDiskUse(true)
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map(mapPlatformProjectMember),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async changeProjectMetadata(
    input: PlatformProjectMetadataChangeInput,
  ): Promise<PlatformProjectSummary | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.projectId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const connection = this.connection;
    if (!connection) unavailable();
    const projectId = new Types.ObjectId(input.projectId);
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.projects.project.manage',
          input.now,
          session,
        );
        const project = await this.projects()
          .findById(projectId)
          .session(session)
          .lean()
          .exec();
        if (!project) return;
        // Resolve ownership before any write, in the same transaction snapshot.
        const organization = await this.organizations()
          .exists({ _id: project.organizationId })
          .session(session)
          .exec();
        if (!organization) return;
        if (!(project.updatedAt instanceof Date))
          throw new ConflictException({ code: 'PROJECT_VERSION_STALE' });
        const set: Record<string, unknown> = {};
        if (input.name !== undefined) set.name = input.name;
        if (input.code !== undefined) set.code = input.code;
        if (input.visibility !== undefined) set.visibility = input.visibility;
        const noChange = Object.entries(set).every(
          ([key, value]) => project[key as keyof typeof project] === value,
        );
        if (
          project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() &&
          !noChange
        )
          throw new ConflictException({ code: 'PROJECT_VERSION_STALE' });
        if (noChange) return;
        const updatedAt = new Date(
          Math.max(input.now.getTime(), project.updatedAt.getTime() + 1),
        );
        const update = await this.projects()
          .updateOne(
            { _id: projectId, updatedAt: input.expectedUpdatedAt },
            { $set: { ...set, updatedAt } },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'PROJECT_VERSION_STALE' });
        await this.writePlatformMetadataAudit(
          {
            eventId: randomUUID(),
            action: 'platform.project.metadata.changed',
            targetResource: 'PROJECT',
            targetResourceId: input.projectId,
            organizationId: project.organizationId.toHexString(),
            actorUserId: input.actorUserId,
            scope: 'PLATFORM',
            result: 'SUCCESS',
            reasonCode: input.reasonCode,
            previous: Object.fromEntries(
              Object.keys(set).map((key) => [
                key,
                project[key as keyof typeof project],
              ]),
            ),
            next: set,
            ...(input.correlationId ? { requestId: input.correlationId } : {}),
            occurredAt: input.now,
          },
          session,
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isDuplicateKey(error))
        throw new ConflictException({ code: 'PROJECT_CODE_CONFLICT' });
      throw new InternalServerErrorException({
        code: 'IAM_PLATFORM_PROJECT_UPDATE_FAILED',
      });
    } finally {
      await session.endSession();
    }
    return this.findProject(input.projectId);
  }

  async changeOrganizationMetadata(
    input: PlatformOrganizationMetadataChangeInput,
  ): Promise<PlatformOrganizationSummary | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.organizationId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const connection = this.connection;
    if (!connection) unavailable();
    const organizationId = new Types.ObjectId(input.organizationId);
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.organizations.organization.manage',
          input.now,
          session,
        );
        const organization = await this.organizations()
          .findById(organizationId)
          .session(session)
          .lean()
          .exec();
        if (!organization) return;
        const set: Record<string, unknown> = {};
        if (input.name !== undefined) set.name = input.name;
        if (input.slug !== undefined) set.slug = input.slug;
        const noChange = Object.entries(set).every(
          ([key, value]) =>
            organization[key as keyof typeof organization] === value,
        );
        if (
          organization.updatedAt.getTime() !==
            input.expectedUpdatedAt.getTime() &&
          !noChange
        )
          throw new ConflictException({ code: 'ORGANIZATION_VERSION_STALE' });
        if (noChange) return;
        const updatedAt = new Date(
          Math.max(input.now.getTime(), organization.updatedAt.getTime() + 1),
        );
        const update = await this.organizations()
          .updateOne(
            { _id: organizationId, updatedAt: input.expectedUpdatedAt },
            { $set: { ...set, updatedAt } },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'ORGANIZATION_VERSION_STALE' });
        await this.writePlatformMetadataAudit(
          {
            eventId: randomUUID(),
            action: 'platform.organization.metadata.changed',
            targetResource: 'ORGANIZATION',
            targetResourceId: input.organizationId,
            actorUserId: input.actorUserId,
            scope: 'PLATFORM',
            result: 'SUCCESS',
            reasonCode: input.reasonCode,
            previous: Object.fromEntries(
              Object.keys(set).map((key) => [
                key,
                organization[key as keyof typeof organization],
              ]),
            ),
            next: set,
            ...(input.correlationId ? { requestId: input.correlationId } : {}),
            occurredAt: input.now,
          },
          session,
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isDuplicateKey(error))
        throw new ConflictException({ code: 'ORGANIZATION_SLUG_CONFLICT' });
      throw new InternalServerErrorException({
        code: 'IAM_PLATFORM_ORGANIZATION_UPDATE_FAILED',
      });
    } finally {
      await session.endSession();
    }
    return this.findOrganization(input.organizationId);
  }

  async getDashboardSummary(now: Date): Promise<PlatformDashboardSummary> {
    const [organizationCount, userCounts, projectCounts, membershipCounts] =
      await Promise.all([
        this.organizations().countDocuments({}).exec(),
        this.platformUsers()
          .aggregate<StatusCount>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
        this.projects()
          .aggregate<StatusCount>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
        this.memberships()
          .aggregate<StatusCount>([
            { $group: { _id: '$status', count: { $sum: 1 } } },
          ])
          .exec(),
      ]);
    const count = (rows: StatusCount[], status: string) =>
      rows.find((row) => row._id === status)?.count ?? 0;
    return {
      organizations: { total: organizationCount },
      users: {
        total: userCounts.reduce((sum, row) => sum + row.count, 0),
        active: count(userCounts, 'ACTIVE'),
        suspended: count(userCounts, 'SUSPENDED'),
        pendingInvite: count(userCounts, 'PENDING_INVITE'),
      },
      projects: {
        total: projectCounts.reduce((sum, row) => sum + row.count, 0),
        active: count(projectCounts, 'ACTIVE'),
        archived: count(projectCounts, 'ARCHIVED'),
      },
      memberships: {
        total: membershipCounts.reduce((sum, row) => sum + row.count, 0),
        active: count(membershipCounts, 'ACTIVE'),
        suspended: count(membershipCounts, 'SUSPENDED'),
        pendingInvite: count(membershipCounts, 'PENDING_INVITE'),
        removed: count(membershipCounts, 'REMOVED'),
      },
      generatedAt: now.toISOString(),
    };
  }

  async listUserSessions(
    input: PlatformSessionListInput,
  ): Promise<PlatformSessionPage | null> {
    if (!validId(input.userId)) return null;
    const userId = new Types.ObjectId(input.userId);
    const userFence = await this.findUserMutationFence(userId);
    if (userFence === null) return null;
    const now = new Date();
    const pipeline: PipelineStage[] = [
      ...this.sessionFamilyStages(userId, now, userFence),
      ...(input.status
        ? [{ $match: { status: input.status } } as PipelineStage]
        : []),
      {
        $facet: {
          data: [
            { $sort: { updatedAt: -1, _id: 1 } },
            { $skip: (input.page - 1) * input.pageSize },
            { $limit: input.pageSize },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];
    const [facet] = await this.refreshSessions()
      .aggregate<{
        data: PlatformSessionAggregate[];
        total: { count: number }[];
      }>(pipeline)
      .exec();
    const totalItems = facet?.total[0]?.count ?? 0;
    return {
      data: (facet?.data ?? []).map((row) => this.mapPlatformSession(row)),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async findUserSession(
    userIdValue: string,
    sessionId: string,
  ): Promise<PlatformSessionSummary | null> {
    if (!validId(userIdValue)) return null;
    const userId = new Types.ObjectId(userIdValue);
    const userFence = await this.findUserMutationFence(userId);
    if (userFence === null) return null;
    const [row] = await this.refreshSessions()
      .aggregate<PlatformSessionAggregate>([
        ...this.sessionFamilyStages(userId, new Date(), userFence),
        { $match: { _id: sessionId } },
        { $limit: 1 },
      ])
      .exec();
    return row ? this.mapPlatformSession(row) : null;
  }

  async revokeUserSession(
    input: PlatformSessionMutationInput & PlatformSessionVersionInput,
  ): Promise<PlatformSessionSummary | null> {
    const result = await this.revokeUserSessions({
      ...input,
      sessions: [
        {
          sessionId: input.sessionId,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
      ],
    });
    return result?.data[0] ?? null;
  }

  async revokeUserSessions(
    input: PlatformRevokeSessionsInput,
  ): Promise<PlatformSessionMutationResult | null> {
    if (!validId(input.actorUserId) || !validId(input.userId)) unavailable();
    const connection = this.connection;
    if (!connection) unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    const session = await connection.startSession();
    let revokedCount = 0;
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.sessions.session.manage',
          input.now,
          session,
        );
        const user = await this.platformUsers()
          .findById(userId)
          .select({ _id: 1 })
          .session(session)
          .lean()
          .exec();
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        const currentFence = await this.findUserMutationFence(userId, session);
        if (currentFence === null)
          throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        revokedCount = 0;
        for (const request of input.sessions) {
          const current = await this.findSessionWithinTransaction(
            userId,
            request.sessionId,
            input.now,
            currentFence,
            session,
          );
          if (!current)
            throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
          if (
            current.status !== 'REVOKED' &&
            new Date(current.updatedAt).getTime() !==
              request.expectedUpdatedAt.getTime()
          )
            throw new ConflictException({ code: 'SESSION_VERSION_STALE' });
          if (current.status === 'REVOKED') continue;
          const update = await this.refreshSessions()
            .updateMany(
              {
                ...this.sessionFamilyFilter(userId, request.sessionId),
                isRevoked: { $ne: true },
              },
              { $set: { isRevoked: true, updatedAt: input.now } },
              { session, timestamps: false },
            )
            .exec();
          if (update.modifiedCount < 1)
            throw new ConflictException({ code: 'SESSION_VERSION_STALE' });
          revokedCount += 1;
          await this.writePlatformMetadataAudit(
            {
              eventId: randomUUID(),
              action: 'platform.session.revoked',
              targetResource: 'SESSION',
              targetResourceId: request.sessionId,
              actorUserId: input.actorUserId,
              scope: 'PLATFORM',
              result: 'SUCCESS',
              reasonCode: input.reasonCode,
              ...(input.correlationId
                ? { requestId: input.correlationId }
                : {}),
              occurredAt: input.now,
            },
            session,
          );
        }
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_SESSION_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    const data: PlatformSessionSummary[] = [];
    for (const request of input.sessions) {
      const current = await this.findUserSession(
        input.userId,
        request.sessionId,
      );
      if (current) data.push(current);
    }
    return { revokedCount, data };
  }

  async revokeAllUserSessions(
    input: PlatformSessionMutationInput,
  ): Promise<number | null> {
    if (!validId(input.actorUserId) || !validId(input.userId)) unavailable();
    const connection = this.connection;
    if (!connection) unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    const session = await connection.startSession();
    let revokedCount: number | null = null;
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.sessions.session.manage',
          input.now,
          session,
        );
        const userUpdate = await this.platformUsers()
          .updateOne(
            { _id: userId },
            { $inc: { mutationFence: 1 } },
            { session, timestamps: false },
          )
          .exec();
        if (userUpdate.matchedCount !== 1)
          throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        const update = await this.refreshSessions()
          .updateMany(
            { userId, isRevoked: { $ne: true } },
            { $set: { isRevoked: true, updatedAt: input.now } },
            { session, timestamps: false },
          )
          .exec();
        revokedCount = update.modifiedCount;
        await this.writePlatformMetadataAudit(
          {
            eventId: randomUUID(),
            action: 'platform.sessions.revoked_all',
            targetResource: 'USER',
            targetResourceId: input.userId,
            actorUserId: input.actorUserId,
            scope: 'PLATFORM',
            result: 'SUCCESS',
            reasonCode: input.reasonCode,
            revokedSessionCount: update.modifiedCount,
            ...(input.correlationId ? { requestId: input.correlationId } : {}),
            occurredAt: input.now,
          },
          session,
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_SESSION_MUTATION_FAILED',
      });
    } finally {
      await session.endSession();
    }
    return revokedCount;
  }

  async findUser(id: string): Promise<PlatformUserDetail | null> {
    if (!validId(id)) return null;
    const userId = new Types.ObjectId(id);
    const [row] = await this.users()
      .aggregate<PlatformUserFacet['data'][number]>([
        { $match: { _id: userId } },
        this.userMembershipLookup(),
        {
          $project: {
            _id: 1,
            email: 1,
            fullName: 1,
            avatarUrl: 1,
            status: 1,
            archivedAt: 1,
            lastLoginAt: 1,
            createdAt: 1,
            updatedAt: 1,
            memberships: 1,
          },
        },
      ])
      .exec();
    if (!row) return null;
    const assignments = await this.platformAssignments()
      .find({
        subjectUserId: userId,
        scope: 'PLATFORM',
        permission: { $in: [...PLATFORM_PERMISSIONS] },
      })
      .select({
        permission: 1,
        scope: 1,
        status: 1,
        grantedAt: 1,
        expiresAt: 1,
        revokedAt: 1,
      })
      .sort({ permission: 1, grantedAt: -1, _id: 1 })
      .lean()
      .exec();
    const now = Date.now();
    const validCounts = new Map<string, number>();
    for (const assignment of assignments) {
      if (
        assignment.status === 'ACTIVE' &&
        assignment.revokedAt == null &&
        assignment.grantedAt instanceof Date &&
        Number.isFinite(assignment.grantedAt.getTime()) &&
        assignment.grantedAt.getTime() <= now &&
        (assignment.expiresAt == null ||
          (assignment.expiresAt instanceof Date &&
            assignment.expiresAt.getTime() > now))
      ) {
        validCounts.set(
          assignment.permission,
          (validCounts.get(assignment.permission) ?? 0) + 1,
        );
      }
    }
    const effectivePlatformPermissions = assignments.map((assignment) =>
      this.mapEffectivePermission(
        assignment,
        validCounts.get(assignment.permission) === 1,
        now,
      ),
    );
    return {
      ...this.mapPlatformUser(row),
      lastLoginAt: this.optionalDate(row.lastLoginAt),
      effectivePlatformPermissions,
    };
  }

  async listUserOrganizations(
    input: PlatformUserOrganizationsInput,
  ): Promise<PlatformUserOrganizationsPage | null> {
    if (
      !validId(input.userId) ||
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize
    )
      unavailable();
    const userId = new Types.ObjectId(input.userId);
    if (!(await this.users().exists({ _id: userId }))) return null;
    const match: Record<string, unknown> = { userId };
    if (input.status) match.status = input.status;
    const [facet] = await this.memberships()
      .aggregate<PlatformUserOrganizationsFacet>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (input.page - 1) * input.pageSize },
              { $limit: input.pageSize },
              {
                $lookup: {
                  from: 'organizations',
                  localField: 'organizationId',
                  foreignField: '_id',
                  pipeline: [{ $project: { _id: 0, name: 1, slug: 1 } }],
                  as: 'organization',
                },
              },
              {
                $unwind: {
                  path: '$organization',
                  preserveNullAndEmptyArrays: true,
                },
              },
              {
                $lookup: {
                  from: 'role_assignments',
                  let: { userId: '$userId', organizationId: '$organizationId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ['$userId', '$$userId'] },
                            { $eq: ['$organizationId', '$$organizationId'] },
                          ],
                        },
                        $or: [
                          { projectId: { $exists: false } },
                          { projectId: null },
                        ],
                      },
                    },
                    { $project: { _id: 0, code: '$roleCode' } },
                  ],
                  as: 'roles',
                },
              },
              {
                $project: {
                  _id: 0,
                  organizationId: 1,
                  status: 1,
                  organization: 1,
                  roles: 1,
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
      data: (facet?.data ?? []).map((row) => this.mapUserMembership(row)),
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / input.pageSize),
      },
    };
  }

  async changeUserStatus(
    input: PlatformUserStatusChangeInput,
  ): Promise<PlatformUserDetail | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    if (actorUserId.equals(userId)) {
      throw new ForbiddenException({
        code: 'SELF_STATUS_CHANGE_FORBIDDEN',
        message: 'A Platform Operator cannot change their own account status.',
      });
    }
    const connection = this.connection;
    if (!connection) unavailable();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.users.account.manage',
          input.now,
          session,
        );
        const user = await this.platformUsers()
          .findById(userId)
          .session(session)
          .lean()
          .exec();
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        if (!(user.updatedAt instanceof Date))
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.archivedAt != null)
          throw new ConflictException({ code: 'USER_ARCHIVED' });
        if (!['ACTIVE', 'SUSPENDED'].includes(user.status))
          throw new ConflictException({
            code: 'USER_STATUS_TRANSITION_INVALID',
          });
        if (user.status === input.status) return;

        let leaderlessOrganizationIds: string[] = [];
        if (user.status === 'ACTIVE' && input.status === 'SUSPENDED') {
          const allowEmergencyBypass =
            input.emergencyBypassLastAdmin === true &&
            input.reasonCode === 'SECURITY_INCIDENT';
          leaderlessOrganizationIds = await this.protectLastOrganizationAdmin(
            userId,
            session,
            allowEmergencyBypass,
          );
        }

        const update = await this.platformUsers()
          .updateOne(
            {
              _id: userId,
              status: user.status,
              updatedAt: input.expectedUpdatedAt,
            },
            {
              $set: {
                status: input.status,
                updatedAt: new Date(
                  Math.max(input.now.getTime(), user.updatedAt.getTime() + 1),
                ),
              },
              $inc: { mutationFence: 1 },
            },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'USER_VERSION_STALE' });

        if (input.status === 'SUSPENDED') {
          await this.refreshSessions()
            .updateMany(
              { userId, isRevoked: { $ne: true } },
              { $set: { isRevoked: true, updatedAt: input.now } },
              { session },
            )
            .exec();
        }
        await this.writePlatformUserStatusAudit(
          input,
          user.status,
          session,
          leaderlessOrganizationIds,
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_USER_MUTATION_FAILED',
        message: 'The Platform user status change could not be committed.',
      });
    } finally {
      await session.endSession();
    }
    return this.findUser(input.userId);
  }

  async updateUserProfile(
    input: PlatformUserProfileChangeInput,
  ): Promise<PlatformUserDetail | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    const connection = this.connection;
    if (!connection) unavailable();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.users.account.manage',
          input.now,
          session,
        );
        const user = await this.platformUsers()
          .findById(userId)
          .session(session)
          .lean()
          .exec();
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        if (!(user.updatedAt instanceof Date))
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.archivedAt != null)
          throw new ConflictException({ code: 'USER_ARCHIVED' });

        const changes: Record<string, string | null> = {};
        const changedFields: Array<'fullName' | 'avatarUrl'> = [];
        if (
          input.fullName !== undefined &&
          input.fullName.trim() !== user.fullName
        ) {
          changes.fullName = input.fullName.trim();
          changedFields.push('fullName');
        }
        if (
          input.avatarUrl !== undefined &&
          (user.avatarUrl ?? null) !== input.avatarUrl
        ) {
          changes.avatarUrl = input.avatarUrl;
          changedFields.push('avatarUrl');
        }
        if (changedFields.length === 0) return;
        changedFields.sort();

        const update = await this.platformUsers()
          .updateOne(
            {
              _id: userId,
              updatedAt: input.expectedUpdatedAt,
              archivedAt: null,
            },
            {
              $set: {
                ...changes,
                updatedAt: new Date(
                  Math.max(input.now.getTime(), user.updatedAt.getTime() + 1),
                ),
              },
              $inc: { mutationFence: 1 },
            },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        await this.writePlatformUserProfileAudit(input, changedFields, session);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_USER_MUTATION_FAILED',
        message: 'The Platform user profile change could not be committed.',
      });
    } finally {
      await session.endSession();
    }
    return this.findUser(input.userId);
  }

  async archiveUser(
    input: PlatformUserArchiveInput,
  ): Promise<PlatformUserDetail | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    if (actorUserId.equals(userId)) {
      throw new ForbiddenException({
        code: 'SELF_ARCHIVE_FORBIDDEN',
        message: 'A Platform Operator cannot archive their own account.',
      });
    }
    const connection = this.connection;
    if (!connection) unavailable();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.users.account.manage',
          input.now,
          session,
        );
        const user = await this.platformUsers()
          .findById(userId)
          .session(session)
          .lean()
          .exec();
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        if (!(user.updatedAt instanceof Date))
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.archivedAt != null)
          throw new ConflictException({ code: 'USER_ALREADY_ARCHIVED' });
        if (!['ACTIVE', 'SUSPENDED'].includes(user.status))
          throw new ConflictException({ code: 'USER_ARCHIVE_STATE_INVALID' });
        let leaderlessOrganizationIds: string[] = [];
        if (user.status === 'ACTIVE') {
          const allowEmergencyBypass =
            input.emergencyBypassLastAdmin === true &&
            input.reasonCode === 'SECURITY_INCIDENT';
          leaderlessOrganizationIds = await this.protectLastOrganizationAdmin(
            userId,
            session,
            allowEmergencyBypass,
          );
        }

        const update = await this.platformUsers()
          .updateOne(
            {
              _id: userId,
              status: user.status,
              updatedAt: input.expectedUpdatedAt,
              archivedAt: null,
            },
            {
              $set: {
                status: 'SUSPENDED',
                archivedAt: input.now,
                archivedBy: actorUserId,
                updatedAt: new Date(
                  Math.max(input.now.getTime(), user.updatedAt.getTime() + 1),
                ),
              },
              $inc: { mutationFence: 1 },
            },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        await this.refreshSessions()
          .updateMany(
            { userId, isRevoked: { $ne: true } },
            { $set: { isRevoked: true, updatedAt: input.now } },
            { session },
          )
          .exec();
        await this.writePlatformUserArchiveAudit(
          input,
          user.status,
          session,
          leaderlessOrganizationIds,
        );
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_USER_MUTATION_FAILED',
        message: 'The Platform user archive could not be committed.',
      });
    } finally {
      await session.endSession();
    }
    return this.findUser(input.userId);
  }

  async restoreUser(
    input: PlatformUserRestoreInput,
  ): Promise<PlatformUserDetail | null> {
    if (
      !validId(input.actorUserId) ||
      !validId(input.userId) ||
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
      input.reasonCode !== 'ACCESS_REVIEW' ||
      !(input.now instanceof Date) ||
      !Number.isFinite(input.now.getTime())
    )
      unavailable();
    const actorUserId = new Types.ObjectId(input.actorUserId);
    const userId = new Types.ObjectId(input.userId);
    if (actorUserId.equals(userId)) {
      throw new ForbiddenException({
        code: 'SELF_RESTORE_FORBIDDEN',
        message: 'A Platform Operator cannot restore their own account.',
      });
    }
    const connection = this.connection;
    if (!connection) unavailable();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.requirePlatformMutationAuthority(
          actorUserId,
          'platform.users.account.manage',
          input.now,
          session,
        );
        const user = await this.platformUsers()
          .findById(userId)
          .session(session)
          .lean()
          .exec();
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        if (!(user.updatedAt instanceof Date))
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (user.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        if (!(user.archivedAt instanceof Date))
          throw new ConflictException({ code: 'USER_NOT_ARCHIVED' });
        if (user.status !== 'SUSPENDED')
          throw new ConflictException({ code: 'USER_RESTORE_STATE_INVALID' });

        const update = await this.platformUsers()
          .updateOne(
            {
              _id: userId,
              status: 'SUSPENDED',
              updatedAt: input.expectedUpdatedAt,
              archivedAt: user.archivedAt,
            },
            {
              $unset: { archivedAt: 1, archivedBy: 1 },
              $set: {
                updatedAt: new Date(
                  Math.max(input.now.getTime(), user.updatedAt.getTime() + 1),
                ),
              },
              $inc: { mutationFence: 1 },
            },
            { session, timestamps: false },
          )
          .exec();
        if (update.matchedCount !== 1)
          throw new ConflictException({ code: 'USER_VERSION_STALE' });
        await this.writePlatformUserRestoreAudit(input, session);
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException({
        code: 'PLATFORM_USER_MUTATION_FAILED',
        message: 'The Platform user restore could not be committed.',
      });
    } finally {
      await session.endSession();
    }
    return this.findUser(input.userId);
  }

  private async findUserMutationFence(
    userId: Types.ObjectId,
    session?: ClientSession,
  ): Promise<number | null> {
    let query = this.platformUsers()
      .findById(userId)
      .select({ mutationFence: 1 })
      .lean();
    if (session) query = query.session(session);
    const user = await query.exec();
    if (!user) return null;
    const fence = user.mutationFence ?? 0;
    if (!Number.isSafeInteger(fence) || fence < 0) unavailable();
    return fence;
  }

  private async findSessionWithinTransaction(
    userId: Types.ObjectId,
    sessionId: string,
    now: Date,
    userFence: number,
    session: ClientSession,
  ): Promise<PlatformSessionSummary | null> {
    const [row] = await this.refreshSessions()
      .aggregate<PlatformSessionAggregate>([
        ...this.sessionFamilyStages(userId, now, userFence),
        { $match: { _id: sessionId } },
        { $limit: 1 },
      ])
      .session(session)
      .exec();
    return row ? this.mapPlatformSession(row) : null;
  }

  private sessionFamilyStages(
    userId: Types.ObjectId,
    now: Date,
    userFence: number,
  ): PipelineStage[] {
    return [
      { $match: { userId } },
      {
        $addFields: {
          _platformSessionId: {
            $ifNull: ['$sessionId', { $toString: '$_id' }],
          },
        },
      },
      { $sort: { updatedAt: -1, _id: -1 } },
      {
        $group: {
          _id: '$_platformSessionId',
          userId: { $first: '$userId' },
          context: {
            $first: {
              $ifNull: [
                '$context',
                {
                  $cond: [
                    { $ne: ['$organizationId', null] },
                    'ORGANIZATION',
                    'ACCOUNT',
                  ],
                },
              ],
            },
          },
          organizationId: { $first: '$organizationId' },
          createdAt: { $min: '$createdAt' },
          updatedAt: { $max: '$updatedAt' },
          expiresAt: { $max: '$expiresAt' },
          sessionFence: { $max: { $ifNull: ['$userFence', 0] } },
          activeRows: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$isRevoked', true] },
                    { $gt: ['$expiresAt', now] },
                    { $eq: [{ $ifNull: ['$userFence', 0] }, userFence] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          unrevokedRows: {
            $sum: { $cond: [{ $ne: ['$isRevoked', true] }, 1, 0] },
          },
        },
      },
      {
        $addFields: {
          sessionId: '$_id',
          status: {
            $cond: [
              { $gt: ['$activeRows', 0] },
              'ACTIVE',
              {
                $cond: [
                  { $ne: ['$sessionFence', userFence] },
                  'REVOKED',
                  {
                    $cond: [
                      { $gt: ['$unrevokedRows', 0] },
                      'EXPIRED',
                      'REVOKED',
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $project: {
          _id: 1,
          sessionId: 1,
          userId: 1,
          context: 1,
          organizationId: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 1,
        },
      },
    ];
  }

  private sessionFamilyFilter(
    userId: Types.ObjectId,
    sessionId: string,
  ): Record<string, unknown> {
    const alternatives: Record<string, unknown>[] = [{ sessionId }];
    if (validId(sessionId))
      alternatives.push({
        _id: new Types.ObjectId(sessionId),
        sessionId: { $exists: false },
      });
    return { userId, $or: alternatives };
  }

  private mapPlatformSession(
    row: PlatformSessionAggregate,
  ): PlatformSessionSummary {
    if (
      !(row.userId instanceof Types.ObjectId) ||
      typeof row.sessionId !== 'string' ||
      !['ACCOUNT', 'ORGANIZATION', 'PLATFORM'].includes(row.context) ||
      !['ACTIVE', 'REVOKED', 'EXPIRED'].includes(row.status) ||
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      !(row.updatedAt instanceof Date) ||
      !Number.isFinite(row.updatedAt.getTime()) ||
      !(row.expiresAt instanceof Date) ||
      !Number.isFinite(row.expiresAt.getTime()) ||
      (row.context === 'ORGANIZATION' &&
        !(row.organizationId instanceof Types.ObjectId))
    )
      unavailable();
    return {
      id: row.sessionId,
      userId: row.userId.toHexString(),
      context: row.context as 'ACCOUNT' | 'ORGANIZATION' | 'PLATFORM',
      organizationId:
        row.organizationId instanceof Types.ObjectId
          ? row.organizationId.toHexString()
          : null,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private async requirePlatformMutationAuthority(
    actorUserId: Types.ObjectId,
    permission: PlatformPermission,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const lock = await this.platformAuthorityLocks()
      .findOneAndUpdate(
        { permission: 'PLATFORM_OPERATOR_LIFECYCLE', scope: 'PLATFORM' },
        { $inc: { version: 1 } },
        { new: true, session },
      )
      .lean()
      .exec();
    if (!lock) unavailable();
    const actor = await this.platformUsers()
      .findOne({ _id: actorUserId, status: 'ACTIVE' }, { _id: 1 })
      .session(session)
      .lean()
      .exec();
    if (!actor) throw new ForbiddenException({ code: 'FORBIDDEN' });
    const assignments = await this.platformAssignments()
      .find({
        subjectUserId: actorUserId,
        permission,
        scope: 'PLATFORM',
        status: 'ACTIVE',
        grantedBy: { $ne: actorUserId },
        grantedAt: { $lte: now },
        revokedAt: null,
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $gt: now } },
        ],
      })
      .session(session)
      .lean()
      .exec();
    if (assignments.length !== 1)
      throw new ForbiddenException({ code: 'FORBIDDEN' });
  }

  private async eligibleOrganizationAdminIds(
    organizationId: Types.ObjectId,
    session: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const assignments = await this.roleAssignments()
      .find(
        {
          organizationId,
          roleCode: 'ADMIN',
          $or: [{ projectId: { $exists: false } }, { projectId: null }],
        },
        { userId: 1, roleId: 1 },
      )
      .session(session)
      .lean()
      .exec();
    if (assignments.length === 0) return [];
    const roles = await this.roles()
      .find(
        {
          _id: { $in: assignments.map((row) => row.roleId) },
          code: 'ADMIN',
          permissions: 'organization.memberships.manage',
        },
        { _id: 1 },
      )
      .session(session)
      .lean()
      .exec();
    const eligibleRoleIds = new Set(
      roles.map((role) => role._id.toHexString()),
    );
    const candidateIds = [
      ...new Map(
        assignments
          .filter((row) => eligibleRoleIds.has(row.roleId.toHexString()))
          .map((row) => [row.userId.toHexString(), row.userId]),
      ).values(),
    ];
    if (candidateIds.length === 0) return [];
    const activeMembershipUserIds = await this.memberships()
      .distinct('userId', {
        organizationId,
        userId: { $in: candidateIds },
        status: 'ACTIVE',
      })
      .session(session)
      .exec();
    return this.platformUsers()
      .distinct('_id', {
        _id: { $in: activeMembershipUserIds },
        status: 'ACTIVE',
      })
      .session(session)
      .exec();
  }

  private async protectLastOrganizationAdmin(
    userId: Types.ObjectId,
    session: ClientSession,
    allowEmergencyBypass = false,
  ): Promise<string[]> {
    const memberships = await this.memberships()
      .find({ userId, status: 'ACTIVE' }, { organizationId: 1 })
      .session(session)
      .lean()
      .exec();
    const organizationIds = [
      ...new Map(
        memberships.map((membership) => [
          membership.organizationId.toHexString(),
          membership.organizationId,
        ]),
      ).values(),
    ].sort((left, right) =>
      left.toHexString().localeCompare(right.toHexString()),
    );
    const leaderlessOrganizationIds: string[] = [];
    for (const organizationId of organizationIds) {
      const adminsBeforeFence = await this.eligibleOrganizationAdminIds(
        organizationId,
        session,
      );
      if (!adminsBeforeFence.some((adminId) => adminId.equals(userId)))
        continue;
      const fence = await this.organizations()
        .updateOne(
          { _id: organizationId },
          {
            $inc: { membershipAdminRevision: 1 },
            $currentDate: { updatedAt: true },
          },
          { session },
        )
        .exec();
      if (fence.matchedCount !== 1)
        throw new ConflictException({ code: 'USER_MEMBERSHIP_STATE_STALE' });
      const admins = await this.eligibleOrganizationAdminIds(
        organizationId,
        session,
      );
      if (
        admins.some((adminId) => adminId.equals(userId)) &&
        admins.length <= 1
      ) {
        if (!allowEmergencyBypass) {
          throw new ConflictException({
            code: 'LAST_ELIGIBLE_ADMIN',
            message:
              'The last eligible Organization ADMIN cannot be suspended.',
          });
        }
        leaderlessOrganizationIds.push(organizationId.toHexString());
      }
    }
    return leaderlessOrganizationIds;
  }

  private async writePlatformUserProfileAudit(
    input: PlatformUserProfileChangeInput,
    changedFields: Array<'fullName' | 'avatarUrl'>,
    session: ClientSession,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) unavailable();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(
        {
          eventId: randomUUID(),
          action: 'platform.user.profile.updated',
          targetResource: 'USER',
          targetResourceId: input.userId,
          actorUserId: input.actorUserId,
          scope: 'PLATFORM',
          result: 'SUCCESS',
          changedFields,
          ...(input.correlationId ? { requestId: input.correlationId } : {}),
          occurredAt: input.now,
        },
        { session },
      );
  }

  private async writePlatformUserArchiveAudit(
    input: PlatformUserArchiveInput,
    previousStatus: string,
    session: ClientSession,
    leaderlessOrganizationIds: readonly string[] = [],
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) unavailable();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(
        {
          eventId: randomUUID(),
          action: 'platform.user.archived',
          targetResource: 'USER',
          targetResourceId: input.userId,
          actorUserId: input.actorUserId,
          scope: 'PLATFORM',
          result: 'SUCCESS',
          reasonCode: input.reasonCode,
          previousStatus,
          newStatus: 'SUSPENDED',
          ...(input.emergencyBypassLastAdmin === true
            ? {
                emergencyBypassLastAdmin: true,
                leaderlessOrganizationIds: [...leaderlessOrganizationIds],
              }
            : {}),
          ...(input.correlationId ? { requestId: input.correlationId } : {}),
          occurredAt: input.now,
        },
        { session },
      );
  }

  private async writePlatformUserRestoreAudit(
    input: PlatformUserRestoreInput,
    session: ClientSession,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) unavailable();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(
        {
          eventId: randomUUID(),
          action: 'platform.user.restored',
          targetResource: 'USER',
          targetResourceId: input.userId,
          actorUserId: input.actorUserId,
          scope: 'PLATFORM',
          result: 'SUCCESS',
          reasonCode: input.reasonCode,
          previousStatus: 'SUSPENDED',
          newStatus: 'SUSPENDED',
          ...(input.correlationId ? { requestId: input.correlationId } : {}),
          occurredAt: input.now,
        },
        { session },
      );
  }

  private async writePlatformUserStatusAudit(
    input: PlatformUserStatusChangeInput,
    previousStatus: string,
    session: ClientSession,
    leaderlessOrganizationIds: readonly string[] = [],
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) unavailable();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(
        {
          eventId: randomUUID(),
          action: 'platform.user.status.changed',
          targetResource: 'USER',
          targetResourceId: input.userId,
          actorUserId: input.actorUserId,
          scope: 'PLATFORM',
          result: 'SUCCESS',
          reasonCode: input.reasonCode,
          previousStatus,
          newStatus: input.status,
          ...(input.emergencyBypassLastAdmin === true
            ? {
                emergencyBypassLastAdmin: true,
                leaderlessOrganizationIds: [...leaderlessOrganizationIds],
              }
            : {}),
          ...(input.correlationId ? { requestId: input.correlationId } : {}),
          occurredAt: input.now,
        },
        { session },
      );
  }

  private async writePlatformMetadataAudit(
    record: Record<string, unknown>,
    session: ClientSession,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) unavailable();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(record, { session });
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  private userMembershipLookup(
    organizationId?: Types.ObjectId,
    roleCode?: string,
  ): PipelineStage.Lookup {
    const membershipMatch: Record<string, unknown> = {
      $expr: { $eq: ['$userId', '$$userId'] },
    };
    if (organizationId) membershipMatch.organizationId = organizationId;
    const roleMatch: Record<string, unknown> = {
      $expr: {
        $and: [
          { $eq: ['$userId', '$$userId'] },
          { $eq: ['$organizationId', '$$organizationId'] },
        ],
      },
      $or: [{ projectId: { $exists: false } }, { projectId: null }],
    };
    return {
      $lookup: {
        from: 'organization_memberships',
        let: { userId: '$_id' },
        pipeline: [
          { $match: membershipMatch },
          { $sort: { createdAt: -1, _id: -1 } },
          ...(!roleCode ? ([{ $limit: 51 }] as PipelineStage[]) : []),
          {
            $lookup: {
              from: 'organizations',
              localField: 'organizationId',
              foreignField: '_id',
              pipeline: [{ $project: { _id: 0, name: 1, slug: 1 } }],
              as: 'organization',
            },
          },
          {
            $unwind: {
              path: '$organization',
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: 'role_assignments',
              let: { userId: '$userId', organizationId: '$organizationId' },
              pipeline: [
                { $match: roleMatch },
                { $project: { _id: 0, code: '$roleCode' } },
              ],
              as: 'roles',
            },
          },
          ...(roleCode
            ? ([
                { $match: { 'roles.code': roleCode } },
                { $limit: 51 },
              ] as PipelineStage[])
            : []),
          {
            $project: {
              _id: 0,
              organizationId: 1,
              status: 1,
              organization: 1,
              roles: 1,
            },
          },
        ] as unknown as PipelineStage.Lookup['$lookup']['pipeline'],
        as: 'memberships',
      },
    };
  }

  private mapPlatformUser(row: PlatformUserDocument): PlatformUserSummary {
    if (
      !(row._id instanceof Types.ObjectId) ||
      typeof row.email !== 'string' ||
      typeof row.fullName !== 'string' ||
      (row.avatarUrl != null && typeof row.avatarUrl !== 'string') ||
      !['ACTIVE', 'SUSPENDED', 'PENDING_INVITE'].includes(row.status) ||
      (row.archivedAt != null &&
        (!(row.archivedAt instanceof Date) ||
          !Number.isFinite(row.archivedAt.getTime()))) ||
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      !(row.updatedAt instanceof Date) ||
      !Number.isFinite(row.updatedAt.getTime())
    )
      unavailable();
    const membershipRows = row.memberships ?? [];
    const memberships = membershipRows
      .slice(0, 50)
      .map((membership) => this.mapUserMembership(membership));
    return {
      id: row._id.toHexString(),
      email: row.email,
      fullName: row.fullName,
      avatarUrl: row.avatarUrl ?? null,
      status: row.status,
      archivedAt: this.optionalDate(row.archivedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      memberships,
      membershipsTruncated: membershipRows.length > 50,
    };
  }

  private mapUserMembership(
    membership: PlatformUserMembershipDocument,
  ): PlatformUserSummary['memberships'][number] {
    if (
      !(membership.organizationId instanceof Types.ObjectId) ||
      !['PENDING_INVITE', 'ACTIVE', 'SUSPENDED', 'REMOVED'].includes(
        membership.status,
      ) ||
      !membership.organization ||
      typeof membership.organization.name !== 'string' ||
      typeof membership.organization.slug !== 'string'
    )
      unavailable();
    return {
      organizationId: membership.organizationId.toHexString(),
      organizationName: membership.organization.name,
      organizationSlug: membership.organization.slug,
      status: membership.status,
      organizationRoles: [
        ...new Set(
          (membership.roles ?? [])
            .map(({ code }) => code)
            .filter((code) =>
              ['ADMIN', 'TEAM_LEADER', 'MEMBER'].includes(code),
            ),
        ),
      ].sort(),
    };
  }

  private mapEffectivePermission(
    row: PlatformAuthorityDocument,
    uniquelyEffective: boolean,
    now: number,
  ): PlatformEffectivePermissionProjection {
    if (
      !(row._id instanceof Types.ObjectId) ||
      !PLATFORM_PERMISSIONS.includes(row.permission) ||
      row.scope !== 'PLATFORM' ||
      !['ACTIVE', 'REVOKED'].includes(row.status) ||
      !(row.grantedAt instanceof Date) ||
      !Number.isFinite(row.grantedAt.getTime())
    )
      unavailable();
    const expiresAt = row.expiresAt ?? null;
    if (
      expiresAt !== null &&
      (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))
    )
      unavailable();
    const isEffective =
      uniquelyEffective &&
      row.status === 'ACTIVE' &&
      row.revokedAt == null &&
      row.grantedAt.getTime() <= now &&
      (expiresAt === null || expiresAt.getTime() > now);
    return {
      permission: row.permission,
      scope: 'PLATFORM',
      status: row.status as 'ACTIVE' | 'REVOKED',
      source: 'PLATFORM_AUTHORITY_ASSIGNMENT',
      grantedAt: row.grantedAt.toISOString(),
      expiresAt: expiresAt?.toISOString() ?? null,
      effective: isEffective,
    };
  }

  private optionalDate(value: Date | null | undefined): string | null {
    if (value == null) return null;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
      unavailable();
    return value.toISOString();
  }

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

  async listPlatformMemberships(
    input: PlatformMembershipListInput,
  ): Promise<PlatformMembershipPage> {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > maxPageSize ||
      (input.organizationId !== undefined && !validId(input.organizationId))
    )
      unavailable();
    const match: Record<string, unknown> = {};
    if (input.organizationId)
      match.organizationId = new Types.ObjectId(input.organizationId);
    if (input.status) match.status = input.status;
    const search = input.search
      ? new RegExp(escapeRegex(input.search), 'i')
      : undefined;
    const [facet] = await this.memberships()
      .aggregate<MembershipFacet>([
        { $match: match },
        ...this.platformMembershipSummaryStages(),
        ...(input.roleCode
          ? ([{ $match: { 'roles.code': input.roleCode } }] as PipelineStage[])
          : []),
        ...(search
          ? ([
              {
                $match: {
                  $or: [
                    { 'user.email': search },
                    { 'user.fullName': search },
                    { 'organization.name': search },
                    { 'organization.slug': search },
                  ],
                },
              },
            ] as PipelineStage[])
          : []),
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            data: [
              { $skip: (input.page - 1) * input.pageSize },
              { $limit: input.pageSize },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .allowDiskUse(true)
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

  async findPlatformMembership(
    id: string,
  ): Promise<PlatformMembershipSummary | null> {
    if (!validId(id)) return null;
    const [row] = await this.memberships()
      .aggregate<MembershipDocument>([
        { $match: { _id: new Types.ObjectId(id) } },
        ...this.platformMembershipSummaryStages(),
        { $limit: 1 },
      ])
      .exec();
    return row ? mapMembership(row) : null;
  }

  private organizations(): Model<OrganizationDocument> {
    return this.model<OrganizationDocument>('organizations');
  }

  private projects(): Model<PlatformProjectDocument> {
    return this.model<PlatformProjectDocument>('projects');
  }

  private users(): Model<ActiveUserDocument> {
    return this.model<ActiveUserDocument>('users');
  }

  private platformUsers(): Model<PlatformUserDocument> {
    return this.model<PlatformUserDocument>('users');
  }

  private memberships(): Model<MembershipDocument> {
    return this.model<MembershipDocument>('organization_memberships');
  }

  private platformMembershipSummaryStages(): PipelineStage[] {
    return [
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
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          pipeline: [{ $project: { _id: 1, name: 1, slug: 1 } }],
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'role_assignments',
          let: {
            membershipUserId: '$userId',
            membershipOrganizationId: '$organizationId',
          },
          pipeline: [
            {
              $match: {
                projectId: null,
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$membershipUserId'] },
                    { $eq: ['$organizationId', '$$membershipOrganizationId'] },
                  ],
                },
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
          organization: 1,
          roles: 1,
        },
      },
    ];
  }

  private platformAssignments(): Model<PlatformAuthorityDocument> {
    return this.model<PlatformAuthorityDocument>(
      'platform_authority_assignments',
    );
  }

  private platformAuthorityLocks(): Model<PlatformAuthorityLockDocument> {
    return this.model<PlatformAuthorityLockDocument>(
      'platform_authority_change_locks',
    );
  }

  private refreshSessions(): Model<PlatformRefreshSessionDocument> {
    return this.model<PlatformRefreshSessionDocument>('refresh_sessions');
  }

  private roleAssignments(): Model<PlatformRoleAssignmentDocument> {
    return this.model<PlatformRoleAssignmentDocument>('role_assignments');
  }

  private roles(): Model<PlatformRoleDocument> {
    return this.model<PlatformRoleDocument>('roles');
  }

  private projectSummaryStages(): PipelineStage.FacetPipelineStage[] {
    return [
      {
        $lookup: {
          from: 'project_memberships',
          let: { projectId: '$_id', organizationId: '$organizationId' },
          pipeline: [
            {
              $match: {
                status: 'ACTIVE',
                $expr: {
                  $and: [
                    { $eq: ['$projectId', '$$projectId'] },
                    { $eq: ['$organizationId', '$$organizationId'] },
                  ],
                },
              },
            },
            { $count: 'count' },
          ],
          as: 'memberStats',
        },
      },
      {
        $lookup: {
          from: 'role_assignments',
          let: { projectId: '$_id', organizationId: '$organizationId' },
          pipeline: [
            {
              $match: {
                roleCode: 'TEAM_LEADER',
                $expr: {
                  $and: [
                    { $eq: ['$projectId', '$$projectId'] },
                    { $eq: ['$organizationId', '$$organizationId'] },
                  ],
                },
              },
            },
            { $sort: { userId: 1, _id: 1 } },
            { $limit: 21 },
            {
              $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                pipeline: [{ $project: { _id: 1, email: 1, fullName: 1 } }],
                as: 'user',
              },
            },
            { $unwind: '$user' },
            { $project: { _id: 0, user: 1 } },
          ],
          as: 'leaders',
        },
      },
      {
        $project: {
          _id: 1,
          organizationId: 1,
          organization: 1,
          name: 1,
          code: 1,
          visibility: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
          memberStats: 1,
          leaders: 1,
        },
      },
    ];
  }

  private mapProject(row: PlatformProjectDocument): PlatformProjectSummary {
    if (
      !(row._id instanceof Types.ObjectId) ||
      !(row.organizationId instanceof Types.ObjectId) ||
      !row.organization ||
      !(row.organization._id instanceof Types.ObjectId) ||
      row.organization._id.toHexString() !== row.organizationId.toHexString() ||
      typeof row.organization.name !== 'string' ||
      typeof row.organization.slug !== 'string' ||
      typeof row.name !== 'string' ||
      typeof row.code !== 'string' ||
      !['PRIVATE', 'PUBLIC'].includes(row.visibility) ||
      !['ACTIVE', 'ARCHIVED'].includes(row.status) ||
      !(row.createdAt instanceof Date) ||
      !Number.isFinite(row.createdAt.getTime()) ||
      !(row.updatedAt instanceof Date) ||
      !Number.isFinite(row.updatedAt.getTime())
    )
      unavailable();
    const memberCount = row.memberStats?.[0]?.count ?? 0;
    if (!Number.isSafeInteger(memberCount) || memberCount < 0) unavailable();
    return {
      id: row._id.toHexString(),
      organization: {
        id: row.organization._id.toHexString(),
        name: row.organization.name,
        slug: row.organization.slug,
      },
      name: row.name,
      code: row.code,
      visibility: row.visibility,
      status: row.status,
      memberCount,
      leaders: (row.leaders ?? [])
        .flatMap(({ user }) => {
          if (!user) return [];
          if (
            !(user._id instanceof Types.ObjectId) ||
            typeof user.email !== 'string' ||
            typeof user.fullName !== 'string'
          )
            unavailable();
          return [
            {
              id: user._id.toHexString(),
              email: user.email,
              fullName: user.fullName,
            },
          ];
        })
        .slice(0, 20),
      leadersTruncated: (row.leaders?.length ?? 0) > 20,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private model<T>(name: string): Model<T> {
    const model = this.connection?.models[modelName(name)] as
      Model<T> | undefined;
    if (!model) unavailable();
    return model;
  }
}
