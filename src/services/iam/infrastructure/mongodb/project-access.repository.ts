import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { ClientSession, Connection, Model, PipelineStage } from 'mongoose';
import type {
  ProjectAccessRepository,
  ProjectMembershipRecord,
  ProjectMemberCandidateRecord,
  ProjectLeaderRecord,
  ProjectLeaderCandidateRecord,
  ProjectMembershipListQuery,
  ProjectSettingsUpdateInput,
} from '../../application/projects/project-access.repository';
import { PROJECT_LEADER_REQUIRED_PERMISSIONS } from '../../application/projects/project-permissions';
import type {
  ProjectRecord,
  ProjectStatus,
  ProjectVisibility,
} from '../../application/projects/project.repository';
import {
  AuthorizationPolicy,
  type ProjectAccessPermission,
} from '../../application/authorization/authorization.policy';
import {
  AUDIT_DATABASE_NAME,
  AUDIT_DATABASE_NAME_TOKEN,
  IAM_AUDIT_COLLECTION_NAME,
} from '../../../../common/mongodb/database-names';
import { IAM_PERSISTENCE } from '../persistence';

interface ProjectDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  name: string;
  code: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  status: ProjectStatus;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId: Types.ObjectId;
  userId: Types.ObjectId;
  status: 'ACTIVE' | 'INACTIVE';
  joinedAt: Date;
}

interface RoleAssignmentDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  projectId?: Types.ObjectId | null;
  userId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleCode: string;
  assignedBy: Types.ObjectId;
}

interface RoleDocument {
  _id: Types.ObjectId;
  code: string;
  permissions: string[];
}

interface UserDocument {
  _id: Types.ObjectId;
  email?: string;
  fullName?: string;
  avatarUrl?: string | null;
  status: string;
}

interface ProjectMemberCandidateAggregate {
  userId: Types.ObjectId;
  email?: string;
  fullName?: string;
  avatarUrl?: string | null;
}

interface OrganizationMembershipDocument {
  _id: Types.ObjectId;
  organizationId: Types.ObjectId;
  userId: Types.ObjectId;
  status: string;
}

const modelName = (collection: string) =>
  `${IAM_PERSISTENCE.databaseName}_${collection}`;
const validId = (value: string) => /^[a-f\d]{24}$/i.test(value);
const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const projectNotFound = () =>
  new NotFoundException({
    code: 'PROJECT_NOT_FOUND',
    message: 'Project not found.',
  });
const membershipNotFound = () =>
  new NotFoundException({
    code: 'PROJECT_MEMBERSHIP_NOT_FOUND',
    message: 'Project membership not found.',
  });

@Injectable()
export class MongoProjectAccessRepository implements ProjectAccessRepository {
  constructor(
    @Optional()
    @InjectConnection(IAM_PERSISTENCE.databaseName)
    private readonly connection?: Connection,
    @Optional()
    @Inject(AUDIT_DATABASE_NAME_TOKEN)
    private readonly auditDatabaseName = AUDIT_DATABASE_NAME,
    @Optional()
    private readonly authorizationPolicy = new AuthorizationPolicy(),
  ) {}

  async updateSettings(
    organizationId: string,
    actorId: string,
    projectId: string,
    input: ProjectSettingsUpdateInput,
  ): Promise<ProjectRecord> {
    this.assertIds(organizationId, actorId, projectId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      let result: ProjectRecord | undefined;
      await session.withTransaction(async () => {
        const authorizedProject = await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.update',
          session,
        );
        const update: Record<string, unknown> = {};
        if (input.name !== undefined && input.name !== authorizedProject.name)
          update.name = input.name;
        if (Object.hasOwn(input, 'description')) {
          const nextDescription = input.description ?? null;
          const currentDescription = authorizedProject.description ?? null;
          if (nextDescription !== currentDescription)
            update.description = nextDescription;
        }
        if (Object.keys(update).length === 0) {
          result = this.projectRecord(authorizedProject);
          return;
        }

        const project = await this.model<ProjectDocument>('projects')
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(projectId),
              organizationId: new Types.ObjectId(organizationId),
              status: 'ACTIVE',
            },
            { $set: update },
            { new: true, session, runValidators: true },
          )
          .lean()
          .exec();
        if (!project) throw projectNotFound();
        result = this.projectRecord(project);
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_SETTINGS_UPDATED',
          targetResource: 'PROJECT',
          targetResourceId: projectId,
        });
      });
      if (!result)
        throw new Error('Project settings transaction did not finish');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async deleteProject(
    organizationId: string,
    actorId: string,
    projectId: string,
  ): Promise<void> {
    if (![organizationId, actorId, projectId].every(validId))
      throw projectNotFound();
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.delete',
          session,
        );
        const organization = new Types.ObjectId(organizationId);
        const projectObjectId = new Types.ObjectId(projectId);

        const deleted = await this.model<ProjectDocument>('projects')
          .findOneAndDelete(
            {
              _id: projectObjectId,
              organizationId: organization,
              status: 'ACTIVE',
            },
            { session },
          )
          .lean()
          .exec();
        if (!deleted) throw projectNotFound();

        await this.model<MembershipDocument>('project_memberships')
          .deleteMany(
            {
              organizationId: organization,
              projectId: projectObjectId,
            },
            { session },
          )
          .exec();
        await this.model<RoleAssignmentDocument>('role_assignments')
          .deleteMany(
            {
              organizationId: organization,
              projectId: projectObjectId,
            },
            { session },
          )
          .exec();

        const teamsModel = this.connection?.models[modelName('teams')] as
          Model<{ _id: Types.ObjectId }> | undefined;
        const teamMembershipsModel = this.connection?.models[
          modelName('team_memberships')
        ] as Model<{ teamId: Types.ObjectId }> | undefined;
        if (teamsModel) {
          const projectTeams = await teamsModel
            .find({
              organizationId: organization,
              projectId: projectObjectId,
            })
            .select({ _id: 1 })
            .session(session)
            .lean()
            .exec();
          if (projectTeams.length > 0 && teamMembershipsModel) {
            await teamMembershipsModel
              .deleteMany(
                { teamId: { $in: projectTeams.map((team) => team._id) } },
                { session },
              )
              .exec();
          }
          await teamsModel
            .deleteMany(
              {
                organizationId: organization,
                projectId: projectObjectId,
              },
              { session },
            )
            .exec();
        }

        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_DELETED',
          targetResource: 'PROJECT',
          targetResourceId: projectId,
        });
      });
    } finally {
      await session.endSession();
    }
  }

  async changeVisibility(
    organizationId: string,
    actorId: string,
    projectId: string,
    visibility: ProjectVisibility,
  ): Promise<ProjectRecord> {
    this.assertIds(organizationId, actorId, projectId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      let result: ProjectRecord | undefined;
      await session.withTransaction(async () => {
        const authorizedProject = await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.visibility.manage',
          session,
        );
        if (
          !['PRIVATE', 'PUBLIC'].includes(authorizedProject.visibility ?? '') ||
          authorizedProject.visibility === visibility
        )
          throw new ConflictException({
            code: 'PROJECT_VISIBILITY_TRANSITION_NOT_ALLOWED',
            message:
              'Project visibility changed or already matches the requested value.',
          });
        const project = await this.model<ProjectDocument>('projects')
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(projectId),
              organizationId: new Types.ObjectId(organizationId),
              status: 'ACTIVE',
              visibility: authorizedProject.visibility,
            },
            { $set: { visibility } },
            { new: true, session },
          )
          .lean()
          .exec();
        if (!project) {
          const current = await this.model<ProjectDocument>('projects')
            .findOne({
              _id: new Types.ObjectId(projectId),
              organizationId: new Types.ObjectId(organizationId),
            })
            .session(session)
            .lean()
            .exec();
          if (!current) throw projectNotFound();
          throw new ConflictException({
            code: 'PROJECT_VISIBILITY_TRANSITION_NOT_ALLOWED',
            message:
              'Project visibility changed or already matches the requested value.',
          });
        }
        result = this.projectRecord(project);
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_VISIBILITY_CHANGED',
          targetResource: 'PROJECT',
          targetResourceId: projectId,
        });
      });
      if (!result)
        throw new Error('Visibility transaction did not update Project');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async listMembers(
    organizationId: string,
    projectId: string,
    query: ProjectMembershipListQuery,
  ): Promise<{ data: ProjectMembershipRecord[]; totalItems: number }> {
    this.assertIds(organizationId, projectId);
    await this.requireActiveProject(organizationId, projectId);
    const filter = {
      organizationId: new Types.ObjectId(organizationId),
      projectId: new Types.ObjectId(projectId),
      status: query.status ?? 'ACTIVE',
    };
    const memberships = this.model<MembershipDocument>('project_memberships');
    const [rows, totalItems] = await Promise.all([
      memberships
        .find(filter)
        .sort({ joinedAt: 1, _id: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .lean()
        .exec(),
      memberships.countDocuments(filter).exec(),
    ]);

    const userIds = [...new Set(rows.map((row) => row.userId))];
    const userMap = new Map<
      string,
      {
        id: string;
        fullName?: string;
        email: string;
        avatarUrl?: string | null;
      }
    >();
    if (userIds.length > 0) {
      const users = await this.model<UserDocument>('users')
        .find({ _id: { $in: userIds } })
        .select({ _id: 1, email: 1, fullName: 1, avatarUrl: 1 })
        .lean()
        .exec();
      for (const u of users) {
        userMap.set(String(u._id), {
          id: String(u._id),
          email: u.email ?? '',
          ...(u.fullName ? { fullName: u.fullName } : {}),
          avatarUrl: u.avatarUrl ?? null,
        });
      }
    }

    return {
      data: rows.map((row) =>
        this.membershipRecord(row, userMap.get(String(row.userId))),
      ),
      totalItems,
    };
  }

  async listMemberCandidates(
    organizationId: string,
    projectId: string,
    search?: string,
  ): Promise<ProjectMemberCandidateRecord[]> {
    this.assertIds(organizationId, projectId);
    await this.requireActiveProject(organizationId, projectId);

    const userMatch: Record<string, unknown> = { 'user.status': 'ACTIVE' };
    if (search && search.trim().length > 0) {
      const sanitized = search.trim();
      userMatch['user.email'] = new RegExp(
        sanitized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i',
      );
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          organizationId: new Types.ObjectId(organizationId),
          status: 'ACTIVE',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      { $match: userMatch },
      { $limit: 50 },
      {
        $project: {
          _id: 0,
          userId: '$user._id',
          email: '$user.email',
          fullName: '$user.fullName',
          avatarUrl: '$user.avatarUrl',
        },
      },
    ];

    const users = await this.model<OrganizationMembershipDocument>(
      'organization_memberships',
    )
      .aggregate<ProjectMemberCandidateAggregate>(pipeline)
      .exec();

    if (users.length === 0) return [];

    const userIds = users.map((u) => u.userId);
    const existingProjectMemberships = await this.model<MembershipDocument>(
      'project_memberships',
    )
      .find({
        organizationId: new Types.ObjectId(organizationId),
        projectId: new Types.ObjectId(projectId),
        userId: { $in: userIds },
        status: 'ACTIVE',
      })
      .select({ userId: 1 })
      .lean()
      .exec();

    const projectMemberSet = new Set(
      existingProjectMemberships.map((m) => String(m.userId)),
    );

    return users.map((u) => ({
      userId: String(u.userId),
      email: u.email ?? '',
      fullName: u.fullName ?? '',
      avatarUrl: u.avatarUrl ?? null,
      organizationMembershipStatus: 'ACTIVE',
      isProjectMember: projectMemberSet.has(String(u.userId)),
    }));
  }

  async listLeaders(
    organizationId: string,
    projectId: string,
  ): Promise<ProjectLeaderRecord[]> {
    this.assertIds(organizationId, projectId);
    await this.requireActiveProject(organizationId, projectId);
    const organization = new Types.ObjectId(organizationId);
    const project = new Types.ObjectId(projectId);
    const assignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find({
        organizationId: organization,
        projectId: project,
        roleCode: 'TEAM_LEADER',
      })
      .select({ _id: 1, userId: 1, roleId: 1 })
      .lean()
      .exec();
    if (assignments.length === 0) return [];

    const roleIds = [
      ...new Map(
        assignments.map((item) => [String(item.roleId), item.roleId]),
      ).values(),
    ];
    const roles = await this.model<RoleDocument>('roles')
      .find({ _id: { $in: roleIds } })
      .select({ _id: 1, code: 1 })
      .lean()
      .exec();
    const currentRoleIds = new Set(
      roles
        .filter((role) => role.code === 'TEAM_LEADER')
        .map((role) => String(role._id)),
    );
    const currentAssignments = assignments.filter((assignment) =>
      currentRoleIds.has(String(assignment.roleId)),
    );
    if (currentAssignments.length === 0) return [];

    const userIds = [
      ...new Map(
        currentAssignments.map((item) => [String(item.userId), item.userId]),
      ).values(),
    ];
    const [users, organizationMemberships, projectMemberships] =
      await Promise.all([
        this.model<UserDocument>('users')
          .find({ _id: { $in: userIds } })
          .select({ _id: 1, email: 1, fullName: 1, avatarUrl: 1, status: 1 })
          .lean()
          .exec(),
        this.model<OrganizationMembershipDocument>('organization_memberships')
          .find({ organizationId: organization, userId: { $in: userIds } })
          .select({ userId: 1, status: 1 })
          .lean()
          .exec(),
        this.model<MembershipDocument>('project_memberships')
          .find({
            organizationId: organization,
            projectId: project,
            userId: { $in: userIds },
          })
          .select({ userId: 1, status: 1 })
          .lean()
          .exec(),
      ]);
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const activeOrganizationMembers = new Set(
      organizationMemberships
        .filter((membership) => membership.status === 'ACTIVE')
        .map((membership) => String(membership.userId)),
    );
    const activeProjectMembers = new Set(
      projectMemberships
        .filter((membership) => membership.status === 'ACTIVE')
        .map((membership) => String(membership.userId)),
    );

    return currentAssignments
      .flatMap((assignment): ProjectLeaderRecord[] => {
        const userId = String(assignment.userId);
        const user = usersById.get(userId);
        if (!user) return [];
        const active =
          user.status === 'ACTIVE' &&
          activeOrganizationMembers.has(userId) &&
          activeProjectMembers.has(userId);
        return [
          {
            userId,
            fullName: user.fullName ?? '',
            email: user.email ?? '',
            avatarUrl: user.avatarUrl ?? null,
            role: 'TEAM_LEADER',
            status: active ? 'ACTIVE' : 'INACTIVE',
          },
        ];
      })
      .sort(
        (left, right) =>
          left.fullName.localeCompare(right.fullName) ||
          left.email.localeCompare(right.email),
      );
  }

  async listLeaderCandidates(
    organizationId: string,
    projectId: string,
    search?: string,
  ): Promise<ProjectLeaderCandidateRecord[]> {
    this.assertIds(organizationId, projectId);
    await this.requireActiveProject(organizationId, projectId);
    const query = search?.trim();
    if (!query) return [];

    const organization = new Types.ObjectId(organizationId);
    const project = new Types.ObjectId(projectId);
    const projectMemberships = await this.model<MembershipDocument>(
      'project_memberships',
    )
      .find({
        organizationId: organization,
        projectId: project,
        status: 'ACTIVE',
      })
      .select({ userId: 1 })
      .lean()
      .exec();
    const projectMemberIds = [
      ...new Map(
        projectMemberships.map((membership) => [
          String(membership.userId),
          membership.userId,
        ]),
      ).values(),
    ];
    if (projectMemberIds.length === 0) return [];

    const organizationMemberships =
      await this.model<OrganizationMembershipDocument>(
        'organization_memberships',
      )
        .find({
          organizationId: organization,
          userId: { $in: projectMemberIds },
          status: 'ACTIVE',
        })
        .select({ userId: 1 })
        .lean()
        .exec();
    const activeOrganizationMemberIds = new Set(
      organizationMemberships.map((membership) => String(membership.userId)),
    );
    const scopedProjectMemberIds = projectMemberIds.filter((userId) =>
      activeOrganizationMemberIds.has(String(userId)),
    );
    if (scopedProjectMemberIds.length === 0) return [];

    const projectAssignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find({
        organizationId: organization,
        projectId: project,
        userId: { $in: scopedProjectMemberIds },
        roleCode: { $in: ['MEMBER', 'TEAM_LEADER'] },
      })
      .select({ userId: 1, roleId: 1, roleCode: 1 })
      .lean()
      .exec();
    const assignedRoleIds = [
      ...new Map(
        projectAssignments.map((assignment) => [
          String(assignment.roleId),
          assignment.roleId,
        ]),
      ).values(),
    ];
    const assignedRoles = assignedRoleIds.length
      ? await this.model<RoleDocument>('roles')
          .find({ _id: { $in: assignedRoleIds } })
          .select({ _id: 1, code: 1 })
          .lean()
          .exec()
      : [];
    const roleCodes = new Map(
      assignedRoles.map((role) => [String(role._id), role.code]),
    );
    const validMemberIds = new Set<string>();
    const currentLeaderIds = new Set<string>();
    for (const assignment of projectAssignments) {
      const userId = String(assignment.userId);
      const resolvedRoleCode = roleCodes.get(String(assignment.roleId));
      if (
        assignment.roleCode === 'TEAM_LEADER' &&
        resolvedRoleCode === 'TEAM_LEADER'
      )
        currentLeaderIds.add(userId);
      if (assignment.roleCode === 'MEMBER' && resolvedRoleCode === 'MEMBER')
        validMemberIds.add(userId);
    }

    const candidateIds = scopedProjectMemberIds.filter((userId) => {
      const id = String(userId);
      return validMemberIds.has(id) && !currentLeaderIds.has(id);
    });
    if (candidateIds.length === 0) return [];

    const users = await this.model<UserDocument>('users')
      .find({
        _id: { $in: candidateIds },
        status: 'ACTIVE',
        email: new RegExp(escapeRegExp(query), 'i'),
      })
      .select({ _id: 1, email: 1, fullName: 1, avatarUrl: 1 })
      .sort({ email: 1, _id: 1 })
      .limit(50)
      .lean()
      .exec();

    return users.map((user) => ({
      userId: String(user._id),
      fullName: user.fullName ?? '',
      email: user.email ?? '',
      avatarUrl: user.avatarUrl ?? null,
      role: 'MEMBER' as const,
      status: 'ACTIVE' as const,
    }));
  }

  async addMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
    role: 'MEMBER' | 'TEAM_LEADER' = 'MEMBER',
  ): Promise<ProjectMembershipRecord> {
    this.assertIds(organizationId, actorId, projectId, userId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      let result: ProjectMembershipRecord | undefined;
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.members.add',
          session,
        );
        const target = await this.model<UserDocument>('users')
          .findOne({ _id: new Types.ObjectId(userId), status: 'ACTIVE' })
          .session(session)
          .lean()
          .exec();
        const organizationMembership =
          await this.model<OrganizationMembershipDocument>(
            'organization_memberships',
          )
            .findOne({
              organizationId: new Types.ObjectId(organizationId),
              userId: new Types.ObjectId(userId),
              status: 'ACTIVE',
            })
            .session(session)
            .lean()
            .exec();
        if (!target || !organizationMembership) throw membershipNotFound();

        const organization = new Types.ObjectId(organizationId);
        const project = new Types.ObjectId(projectId);
        await this.fenceRecipientEligibility(
          target,
          organizationMembership,
          null,
          organization,
          project,
          session,
        );

        const targetRole = await this.currentRole(role, session);
        if (role === 'TEAM_LEADER') {
          const leaderPermissions = PROJECT_LEADER_REQUIRED_PERMISSIONS;
          if (
            !targetRole ||
            !leaderPermissions.every((permission) =>
              targetRole.permissions.includes(permission),
            )
          )
            throw new ConflictException({
              code: 'PROJECT_LEADER_ROLE_UNAVAILABLE',
              message:
                'The current TEAM_LEADER Role is not provisioned with the approved Project permissions.',
            });
          await this.fenceRole(
            targetRole,
            'TEAM_LEADER',
            leaderPermissions,
            session,
          );
        } else {
          if (!targetRole?.permissions.includes('project.read'))
            throw new ConflictException({
              code: 'PROJECT_MEMBER_ROLE_UNAVAILABLE',
              message:
                'The current MEMBER Role with project.read is not provisioned.',
            });
          await this.fenceRole(targetRole, 'MEMBER', ['project.read'], session);
        }

        const user = new Types.ObjectId(userId);
        let membership = await this.model<MembershipDocument>(
          'project_memberships',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: user,
          })
          .session(session)
          .lean()
          .exec();
        if (membership?.status === 'ACTIVE')
          throw new ConflictException({
            code: 'PROJECT_MEMBERSHIP_ALREADY_ACTIVE',
            message: 'The user is already an active Project member.',
          });

        if (membership) {
          await this.model<MembershipDocument>('project_memberships').updateOne(
            { _id: membership._id, status: 'INACTIVE' },
            { $set: { status: 'ACTIVE' } },
            { session },
          );
          membership = { ...membership, status: 'ACTIVE' };
        } else {
          const [created] = await this.model<MembershipDocument>(
            'project_memberships',
          ).create(
            [
              {
                organizationId: organization,
                projectId: project,
                userId: user,
                status: 'ACTIVE',
                joinedAt: new Date(),
              },
            ],
            { session },
          );
          membership = created.toObject();
        }

        const existingAssignment = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: user,
          })
          .session(session)
          .lean()
          .exec();
        if (existingAssignment) {
          const currentRole = await this.model<RoleDocument>('roles')
            .findById(existingAssignment.roleId)
            .session(session)
            .lean()
            .exec();
          if (
            role === 'MEMBER' &&
            (existingAssignment.roleCode === 'TEAM_LEADER' ||
              currentRole?.code === 'TEAM_LEADER')
          )
            throw new ConflictException({
              code: 'PROJECT_LEADER_MUST_BE_REVOKED_FIRST',
              message:
                'A Project Leader appointment must be revoked by an ADMIN before removal or reactivation.',
            });
          if (
            role === 'MEMBER' &&
            (existingAssignment.roleCode !== currentRole?.code ||
              currentRole?.code !== 'MEMBER')
          )
            throw new ConflictException({
              code: 'PROJECT_ROLE_ASSIGNMENT_INVALID',
              message:
                'The existing Project RoleAssignment is not a current MEMBER assignment.',
            });
          await this.model<RoleAssignmentDocument>(
            'role_assignments',
          ).updateOne(
            { _id: existingAssignment._id },
            {
              $set: {
                roleId: targetRole._id,
                roleCode: role,
                assignedBy: new Types.ObjectId(actorId),
              },
            },
            { session },
          );
        } else {
          await this.model<RoleAssignmentDocument>('role_assignments').create(
            [
              {
                organizationId: organization,
                projectId: project,
                userId: user,
                roleId: targetRole._id,
                roleCode: role,
                assignedBy: new Types.ObjectId(actorId),
              },
            ],
            { session },
          );
        }

        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_MEMBER_ADDED',
          targetResource: 'PROJECT_MEMBERSHIP',
          targetResourceId: String(membership._id),
        });
        result = this.membershipRecord(membership);
      });
      if (!result)
        throw new Error('Membership transaction did not create a record');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async removeMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    membershipId: string,
  ): Promise<void> {
    this.assertIds(organizationId, actorId, projectId, membershipId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.members.remove',
          session,
        );
        const membership = await this.model<MembershipDocument>(
          'project_memberships',
        )
          .findOne({
            _id: new Types.ObjectId(membershipId),
            organizationId: new Types.ObjectId(organizationId),
            projectId: new Types.ObjectId(projectId),
          })
          .session(session)
          .lean()
          .exec();
        if (!membership) throw membershipNotFound();
        if (membership.status === 'INACTIVE') return;
        if (membership.status !== 'ACTIVE') throw membershipNotFound();

        const assignment = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        )
          .findOne({
            organizationId: new Types.ObjectId(organizationId),
            projectId: new Types.ObjectId(projectId),
            userId: membership.userId,
          })
          .session(session)
          .lean()
          .exec();
        if (assignment) {
          const role = await this.model<RoleDocument>('roles')
            .findById(assignment.roleId)
            .session(session)
            .lean()
            .exec();
          if (
            assignment.roleCode === 'TEAM_LEADER' ||
            role?.code === 'TEAM_LEADER'
          )
            throw new ConflictException({
              code: 'PROJECT_LEADER_MUST_BE_REVOKED_FIRST',
              message:
                'A Project Leader appointment must be revoked by an ADMIN before membership removal.',
            });
          await this.fenceAuthorizationDocument(
            'role_assignments',
            {
              _id: assignment._id,
              organizationId: new Types.ObjectId(organizationId),
              projectId: new Types.ObjectId(projectId),
              userId: membership.userId,
              roleId: assignment.roleId,
              roleCode: assignment.roleCode,
            },
            session,
          );
          if (role)
            await this.fenceAuthorizationDocument(
              'roles',
              { _id: role._id, code: role.code },
              session,
            );
        }

        await this.model<MembershipDocument>('project_memberships').updateOne(
          { _id: membership._id, status: 'ACTIVE' },
          { $set: { status: 'INACTIVE' } },
          { session },
        );
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_MEMBER_REMOVED',
          targetResource: 'PROJECT_MEMBERSHIP',
          targetResourceId: membershipId,
        });
      });
    } finally {
      await session.endSession();
    }
  }

  async assignLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    this.assertIds(organizationId, actorId, projectId, userId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.leader.manage',
          session,
        );
        const organization = new Types.ObjectId(organizationId);
        const project = new Types.ObjectId(projectId);
        const user = new Types.ObjectId(userId);
        const target = await this.model<UserDocument>('users')
          .findOne({ _id: user, status: 'ACTIVE' })
          .session(session)
          .lean()
          .exec();
        const organizationMembership =
          await this.model<OrganizationMembershipDocument>(
            'organization_memberships',
          )
            .findOne({
              organizationId: organization,
              userId: user,
              status: 'ACTIVE',
            })
            .session(session)
            .lean()
            .exec();
        let projectMembership = await this.model<MembershipDocument>(
          'project_memberships',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: user,
            status: 'ACTIVE',
          })
          .session(session)
          .lean()
          .exec();
        if (!target || !organizationMembership) throw membershipNotFound();
        if (!projectMembership) {
          const existingEffectiveLeaders =
            await this.findEffectiveLeaderAssignments(
              organization,
              project,
              undefined,
              session,
            );
          if (existingEffectiveLeaders.length > 0) throw membershipNotFound();
          const upsertedMembership = await this.model<MembershipDocument>(
            'project_memberships',
          )
            .findOneAndUpdate(
              {
                organizationId: organization,
                projectId: project,
                userId: user,
              },
              {
                $set: { status: 'ACTIVE' },
                $setOnInsert: { joinedAt: new Date() },
              },
              { upsert: true, new: true, session },
            )
            .lean()
            .exec();
          projectMembership = upsertedMembership;
        }
        if (!projectMembership) throw membershipNotFound();
        await this.fenceRecipientEligibility(
          target,
          organizationMembership,
          projectMembership,
          organization,
          project,
          session,
        );

        const leaderRole = await this.currentRole('TEAM_LEADER', session);
        const leaderPermissions = PROJECT_LEADER_REQUIRED_PERMISSIONS;
        if (
          !leaderRole ||
          !leaderPermissions.every((permission) =>
            leaderRole.permissions.includes(permission),
          )
        )
          throw new ConflictException({
            code: 'PROJECT_LEADER_ROLE_UNAVAILABLE',
            message:
              'The current TEAM_LEADER Role is not provisioned with the approved Project permissions.',
          });
        await this.fenceRole(
          leaderRole,
          'TEAM_LEADER',
          leaderPermissions,
          session,
        );

        const assignmentModel =
          this.model<RoleAssignmentDocument>('role_assignments');
        const assignment = await assignmentModel
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: user,
          })
          .session(session)
          .lean()
          .exec();
        if (assignment?.roleCode === 'TEAM_LEADER')
          throw new ConflictException({
            code: 'PROJECT_LEADER_ALREADY_ASSIGNED',
            message: 'The user is already a Project Leader.',
          });
        if (assignment) {
          const currentRole = await this.model<RoleDocument>('roles')
            .findById(assignment.roleId)
            .session(session)
            .lean()
            .exec();
          if (
            !currentRole ||
            assignment.roleCode !== currentRole.code ||
            currentRole.code !== 'MEMBER'
          )
            throw new ConflictException({
              code: 'PROJECT_ROLE_ASSIGNMENT_INVALID',
              message:
                'Only a current MEMBER RoleAssignment can be appointed as a Project Leader.',
            });
          await this.fenceRole(currentRole, 'MEMBER', [], session);
          await assignmentModel.updateOne(
            { _id: assignment._id },
            {
              $set: {
                roleId: leaderRole._id,
                roleCode: 'TEAM_LEADER',
                assignedBy: new Types.ObjectId(actorId),
              },
            },
            { session },
          );
        } else {
          const [created] = await assignmentModel.create(
            [
              {
                organizationId: organization,
                projectId: project,
                userId: user,
                roleId: leaderRole._id,
                roleCode: 'TEAM_LEADER',
                assignedBy: new Types.ObjectId(actorId),
              },
            ],
            { session },
          );
          await this.audit(session, {
            organizationId,
            projectId,
            actorId,
            action: 'PROJECT_LEADER_ASSIGNED',
            targetResource: 'ROLE_ASSIGNMENT',
            targetResourceId: String(created._id),
          });
          return;
        }

        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_LEADER_ASSIGNED',
          targetResource: 'ROLE_ASSIGNMENT',
          targetResourceId: String(assignment._id),
        });
      });
    } finally {
      await session.endSession();
    }
  }

  async revokeLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
  ): Promise<void> {
    this.assertIds(organizationId, actorId, projectId, userId);
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.leader.manage',
          session,
        );
        const organization = new Types.ObjectId(organizationId);
        const project = new Types.ObjectId(projectId);
        const user = new Types.ObjectId(userId);
        const assignmentModel =
          this.model<RoleAssignmentDocument>('role_assignments');
        const assignment = await assignmentModel
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: user,
            roleCode: 'TEAM_LEADER',
          })
          .session(session)
          .lean()
          .exec();
        if (!assignment) throw membershipNotFound();
        const leaderRole = await this.model<RoleDocument>('roles')
          .findById(assignment.roleId)
          .session(session)
          .lean()
          .exec();
        if (leaderRole?.code !== 'TEAM_LEADER')
          throw new ConflictException({
            code: 'PROJECT_ROLE_ASSIGNMENT_INVALID',
            message: 'The Project Leader RoleAssignment is stale.',
          });
        await this.fenceRole(leaderRole, 'TEAM_LEADER', [], session);
        const memberRole = await this.currentRole('MEMBER', session);
        if (!memberRole?.permissions.includes('project.read'))
          throw new ConflictException({
            code: 'PROJECT_MEMBER_ROLE_UNAVAILABLE',
            message:
              'The current MEMBER Role with project.read is not provisioned.',
          });
        await this.fenceRole(memberRole, 'MEMBER', ['project.read'], session);
        const survivingLeaders = await this.findEffectiveLeaderAssignments(
          organization,
          project,
          user,
          session,
        );
        const survivor = survivingLeaders[0];
        if (!survivor)
          throw new ConflictException({
            code: 'LAST_PROJECT_LEADER_REQUIRED',
            message:
              'The last active Project Leader cannot be revoked without appointing a replacement Leader first.',
          });
        await this.fenceRecipientEligibility(
          survivor.user,
          survivor.organizationMembership,
          survivor.projectMembership,
          organization,
          project,
          session,
        );
        const fencedSurvivorAssignment = await assignmentModel.updateOne(
          {
            _id: survivor.assignment._id,
            organizationId: organization,
            projectId: project,
            userId: survivor.user._id,
            roleId: leaderRole._id,
            roleCode: 'TEAM_LEADER',
          },
          { $inc: { __v: 1 } },
          { session, timestamps: false },
        );
        if (fencedSurvivorAssignment.modifiedCount !== 1)
          throw new ConflictException({
            code: 'LAST_PROJECT_LEADER_REQUIRED',
            message:
              'The last active Project Leader cannot be revoked without appointing a replacement Leader first.',
          });
        const updated = await assignmentModel.updateOne(
          { _id: assignment._id, roleCode: 'TEAM_LEADER' },
          {
            $set: {
              roleId: memberRole._id,
              roleCode: 'MEMBER',
              assignedBy: new Types.ObjectId(actorId),
            },
          },
          { session },
        );
        if (!updated.modifiedCount)
          throw new ConflictException({
            code: 'PROJECT_LEADER_CHANGED_CONCURRENTLY',
            message: 'The Project Leader appointment changed concurrently.',
          });
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_LEADER_REVOKED',
          targetResource: 'ROLE_ASSIGNMENT',
          targetResourceId: String(assignment._id),
        });
      });
    } finally {
      await session.endSession();
    }
  }

  private async findEffectiveLeaderAssignments(
    organization: Types.ObjectId,
    project: Types.ObjectId,
    excludeUser?: Types.ObjectId,
    session?: ClientSession,
  ): Promise<
    Array<{
      assignment: RoleAssignmentDocument;
      user: UserDocument;
      organizationMembership: OrganizationMembershipDocument;
      projectMembership: MembershipDocument;
    }>
  > {
    const assignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find({
        organizationId: organization,
        projectId: project,
        roleCode: 'TEAM_LEADER',
        ...(excludeUser ? { userId: { $ne: excludeUser } } : {}),
      })
      .session(session ?? null)
      .lean()
      .exec();
    if (assignments.length === 0) return [];

    const roleIds = [
      ...new Map(
        assignments.map((item) => [String(item.roleId), item.roleId]),
      ).values(),
    ];
    const roles = await this.model<RoleDocument>('roles')
      .find({ _id: { $in: roleIds }, code: 'TEAM_LEADER' })
      .session(session ?? null)
      .select({ _id: 1, code: 1 })
      .lean()
      .exec();
    const validRoleIds = new Set(roles.map((role) => String(role._id)));
    const validAssignments = assignments.filter((item) =>
      validRoleIds.has(String(item.roleId)),
    );
    if (validAssignments.length === 0) return [];

    const userIds = [
      ...new Map(
        validAssignments.map((item) => [String(item.userId), item.userId]),
      ).values(),
    ];
    const [users, organizationMemberships, projectMemberships] =
      await Promise.all([
        this.model<UserDocument>('users')
          .find({ _id: { $in: userIds }, status: 'ACTIVE' })
          .session(session ?? null)
          .lean()
          .exec(),
        this.model<OrganizationMembershipDocument>('organization_memberships')
          .find({
            organizationId: organization,
            userId: { $in: userIds },
            status: 'ACTIVE',
          })
          .session(session ?? null)
          .lean()
          .exec(),
        this.model<MembershipDocument>('project_memberships')
          .find({
            organizationId: organization,
            projectId: project,
            userId: { $in: userIds },
            status: 'ACTIVE',
          })
          .session(session ?? null)
          .lean()
          .exec(),
      ]);
    const usersById = new Map(users.map((item) => [String(item._id), item]));
    const orgMembershipsByUserId = new Map(
      organizationMemberships.map((item) => [String(item.userId), item]),
    );
    const projectMembershipsByUserId = new Map(
      projectMemberships.map((item) => [String(item.userId), item]),
    );

    const effective: Array<{
      assignment: RoleAssignmentDocument;
      user: UserDocument;
      organizationMembership: OrganizationMembershipDocument;
      projectMembership: MembershipDocument;
    }> = [];
    for (const assignment of validAssignments) {
      const uid = String(assignment.userId);
      const user = usersById.get(uid);
      const organizationMembership = orgMembershipsByUserId.get(uid);
      const projectMembership = projectMembershipsByUserId.get(uid);
      if (user && organizationMembership && projectMembership) {
        effective.push({
          assignment,
          user,
          organizationMembership,
          projectMembership,
        });
      }
    }
    return effective;
  }

  async changeLeader(
    organizationId: string,
    actorId: string,
    projectId: string,
    previousUserId: string,
    nextUserId: string,
  ): Promise<void> {
    this.assertIds(
      organizationId,
      actorId,
      projectId,
      previousUserId,
      nextUserId,
    );
    if (new Types.ObjectId(previousUserId).equals(nextUserId))
      throw new ConflictException({
        code: 'PROJECT_LEADER_CHANGE_TARGETS_MUST_DIFFER',
        message: 'The current and replacement Project Leaders must differ.',
      });
    const connection = this.requireConnection();
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await this.authorizeMutation(
          organizationId,
          actorId,
          projectId,
          'project.leader.manage',
          session,
        );
        const organization = new Types.ObjectId(organizationId);
        const project = new Types.ObjectId(projectId);
        const previousUser = new Types.ObjectId(previousUserId);
        const nextUser = new Types.ObjectId(nextUserId);
        const previousAssignment = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: previousUser,
            roleCode: 'TEAM_LEADER',
          })
          .session(session)
          .lean()
          .exec();
        const nextMembership = await this.model<MembershipDocument>(
          'project_memberships',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: nextUser,
            status: 'ACTIVE',
          })
          .session(session)
          .lean()
          .exec();
        const nextOrgMembership =
          await this.model<OrganizationMembershipDocument>(
            'organization_memberships',
          )
            .findOne({
              organizationId: organization,
              userId: nextUser,
              status: 'ACTIVE',
            })
            .session(session)
            .lean()
            .exec();
        const nextUserDoc = await this.model<UserDocument>('users')
          .findOne({ _id: nextUser, status: 'ACTIVE' })
          .session(session)
          .lean()
          .exec();
        if (!previousAssignment) throw membershipNotFound();
        const previousRole = await this.model<RoleDocument>('roles')
          .findById(previousAssignment.roleId)
          .session(session)
          .lean()
          .exec();
        if (previousRole?.code !== 'TEAM_LEADER')
          throw new ConflictException({
            code: 'PROJECT_ROLE_ASSIGNMENT_INVALID',
            message: 'The current Project Leader RoleAssignment is stale.',
          });
        await this.fenceRole(previousRole, 'TEAM_LEADER', [], session);
        if (!nextMembership || !nextOrgMembership || !nextUserDoc)
          throw membershipNotFound();
        await this.fenceRecipientEligibility(
          nextUserDoc,
          nextOrgMembership,
          nextMembership,
          organization,
          project,
          session,
        );

        const nextAssignment = await this.model<RoleAssignmentDocument>(
          'role_assignments',
        )
          .findOne({
            organizationId: organization,
            projectId: project,
            userId: nextUser,
          })
          .session(session)
          .lean()
          .exec();
        if (!nextAssignment)
          throw new ConflictException({
            code: 'PROJECT_MEMBER_ROLE_ASSIGNMENT_REQUIRED',
            message:
              'The replacement Project Leader must have a current MEMBER RoleAssignment.',
          });
        const nextRole = await this.model<RoleDocument>('roles')
          .findById(nextAssignment.roleId)
          .session(session)
          .lean()
          .exec();
        if (
          !nextRole ||
          nextAssignment.roleCode !== nextRole.code ||
          nextRole.code !== 'MEMBER'
        )
          throw new ConflictException({
            code: 'PROJECT_ROLE_ASSIGNMENT_INVALID',
            message:
              'The replacement Project Leader must have a current MEMBER RoleAssignment.',
          });
        await this.fenceRole(nextRole, 'MEMBER', [], session);

        const memberRole = await this.currentRole('MEMBER', session);
        const leaderRole = await this.currentRole('TEAM_LEADER', session);
        const leaderPermissions = PROJECT_LEADER_REQUIRED_PERMISSIONS;
        if (!memberRole?.permissions.includes('project.read'))
          throw new ConflictException({
            code: 'PROJECT_MEMBER_ROLE_UNAVAILABLE',
            message:
              'The current MEMBER Role with project.read is not provisioned.',
          });
        if (
          !leaderRole ||
          !leaderPermissions.every((permission) =>
            leaderRole.permissions.includes(permission),
          )
        )
          throw new ConflictException({
            code: 'PROJECT_LEADER_ROLE_UNAVAILABLE',
            message:
              'The current TEAM_LEADER Role is not provisioned with the approved Project permissions.',
          });
        await this.fenceRole(memberRole, 'MEMBER', ['project.read'], session);
        await this.fenceRole(
          leaderRole,
          'TEAM_LEADER',
          leaderPermissions,
          session,
        );

        const assignments =
          this.model<RoleAssignmentDocument>('role_assignments');
        const demoted = await assignments.updateOne(
          {
            _id: previousAssignment._id,
            roleCode: 'TEAM_LEADER',
          },
          {
            $set: {
              roleId: memberRole._id,
              roleCode: 'MEMBER',
              assignedBy: new Types.ObjectId(actorId),
            },
          },
          { session },
        );
        const promoted = await assignments.updateOne(
          {
            _id: nextAssignment._id,
            roleCode: 'MEMBER',
          },
          {
            $set: {
              roleId: leaderRole._id,
              roleCode: 'TEAM_LEADER',
              assignedBy: new Types.ObjectId(actorId),
            },
          },
          { session },
        );
        if (!demoted.modifiedCount || !promoted.modifiedCount)
          throw new ConflictException({
            code: 'PROJECT_LEADER_CHANGED_CONCURRENTLY',
            message: 'A Project Leader appointment changed concurrently.',
          });
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_LEADER_CHANGED',
          targetResource: 'ROLE_ASSIGNMENT',
          targetResourceId: String(previousAssignment._id),
        });
        await this.audit(session, {
          organizationId,
          projectId,
          actorId,
          action: 'PROJECT_LEADER_CHANGED',
          targetResource: 'ROLE_ASSIGNMENT',
          targetResourceId: String(nextAssignment._id),
        });
      });
    } finally {
      await session.endSession();
    }
  }

  private async requireActiveProject(
    organizationId: string,
    projectId: string,
    session?: ClientSession,
  ): Promise<ProjectDocument> {
    let query = this.model<ProjectDocument>('projects').findOne({
      _id: new Types.ObjectId(projectId),
      organizationId: new Types.ObjectId(organizationId),
      status: 'ACTIVE',
    });
    if (session) query = query.session(session);
    const project = await query.lean().exec();
    if (!project) throw projectNotFound();
    return project;
  }

  private async authorizeMutation(
    organizationId: string,
    actorId: string,
    projectId: string,
    permission: Extract<
      ProjectAccessPermission,
      | 'project.visibility.manage'
      | 'project.leader.manage'
      | 'project.update'
      | 'project.delete'
      | 'project.members.add'
      | 'project.members.remove'
    >,
    session: ClientSession,
  ): Promise<ProjectDocument> {
    const organization = new Types.ObjectId(organizationId);
    const actor = new Types.ObjectId(actorId);
    const projectObjectId = new Types.ObjectId(projectId);
    const project = await this.model<ProjectDocument>('projects')
      .findOne({ _id: projectObjectId, organizationId: organization })
      .session(session)
      .lean()
      .exec();
    if (!project || project.status !== 'ACTIVE') throw projectNotFound();

    const user = await this.model<UserDocument>('users')
      .findById(actor)
      .session(session)
      .lean()
      .exec();
    const membership = await this.model<OrganizationMembershipDocument>(
      'organization_memberships',
    )
      .findOne({ organizationId: organization, userId: actor })
      .session(session)
      .lean()
      .exec();
    const projectMembership = await this.model<MembershipDocument>(
      'project_memberships',
    )
      .findOne({
        organizationId: organization,
        projectId: projectObjectId,
        userId: actor,
      })
      .session(session)
      .lean()
      .exec();
    const assignments = await this.model<RoleAssignmentDocument>(
      'role_assignments',
    )
      .find({
        organizationId: organization,
        userId: actor,
        $or: [
          { projectId: { $exists: false } },
          { projectId: null },
          { projectId: projectObjectId },
        ],
      })
      .session(session)
      .lean()
      .exec();
    const roleIds = assignments.map((assignment) => assignment.roleId);
    const roles = roleIds.length
      ? await this.model<RoleDocument>('roles')
          .find({ _id: { $in: roleIds } })
          .session(session)
          .lean()
          .exec()
      : [];
    const rolesById = new Map(roles.map((role) => [String(role._id), role]));
    const assignmentEvidence = assignments.map((assignment) => {
      const role = rolesById.get(String(assignment.roleId));
      return {
        userId: String(assignment.userId),
        organizationId: String(assignment.organizationId),
        projectId:
          assignment.projectId == null ? null : String(assignment.projectId),
        roleCode: assignment.roleCode,
        resolvedRoleCode: role?.code ?? null,
        permissions: role?.permissions ?? [],
      };
    });
    const decision = this.authorizationPolicy.evaluateProjectAccess({
      permission,
      subject: {
        userId: actorId,
        organizationId,
        status: user?.status ?? 'INACTIVE',
      },
      requestedOrganizationId: organizationId,
      requestedProjectId: projectObjectId.toHexString(),
      project: {
        id: String(project._id),
        organizationId: String(project.organizationId),
        status: project.status,
        ...(project.visibility ? { visibility: project.visibility } : {}),
      },
      membership: membership
        ? {
            userId: String(membership.userId),
            organizationId: String(membership.organizationId),
            status: membership.status,
          }
        : null,
      projectMembership: projectMembership
        ? {
            userId: String(projectMembership.userId),
            organizationId: String(projectMembership.organizationId),
            projectId: String(projectMembership.projectId),
            status: projectMembership.status,
          }
        : null,
      assignments: assignmentEvidence,
      explicitDeny: 'CLEAR',
    });
    if (!decision.allowed) throw new ForbiddenException();

    const projectIdValue = projectObjectId.toHexString();
    const allowedScopes: readonly {
      roleCode: 'ADMIN' | 'TEAM_LEADER';
      projectId: string | null;
    }[] =
      permission === 'project.visibility.manage' ||
      permission === 'project.members.add' ||
      permission === 'project.members.remove'
        ? [
            { roleCode: 'ADMIN', projectId: null },
            { roleCode: 'TEAM_LEADER', projectId: projectIdValue },
          ]
        : permission === 'project.leader.manage' ||
            permission === 'project.delete'
          ? [{ roleCode: 'ADMIN', projectId: null }]
          : [{ roleCode: 'TEAM_LEADER', projectId: projectIdValue }];
    const authorizationMatch = allowedScopes
      .map((scope) => ({
        scope,
        assignment: assignments.find((assignment) => {
          const role = rolesById.get(String(assignment.roleId));
          return (
            String(assignment.userId) === actorId &&
            String(assignment.organizationId) === organizationId &&
            (assignment.projectId == null
              ? null
              : String(assignment.projectId)) === scope.projectId &&
            assignment.roleCode === scope.roleCode &&
            role?.code === scope.roleCode &&
            (permission === 'project.delete'
              ? role.permissions.includes('project.delete') ||
                role.permissions.includes('project.leader.manage') ||
                role.permissions.includes('project.visibility.manage')
              : role.permissions.includes(permission))
          );
        }),
      }))
      .find((candidate) => candidate.assignment !== undefined);
    const authorizationAssignment = authorizationMatch?.assignment;
    const expectedRole = authorizationMatch?.scope.roleCode;
    const expectedProjectId = authorizationMatch?.scope.projectId;
    if (!user || !membership || !authorizationAssignment || !expectedRole)
      throw new ForbiddenException();
    const requiresProjectMembership = expectedRole === 'TEAM_LEADER';

    // These version-key writes create a same-document write conflict with a
    // concurrent membership, assignment, permission, user, or Project change.
    // MongoDB retries transient transaction conflicts; the retry re-reads the
    // authority and denies if it was revoked before this mutation committed.
    await this.fenceAuthorizationDocument(
      'users',
      { _id: actor, status: 'ACTIVE' },
      session,
    );
    await this.fenceAuthorizationDocument(
      'organization_memberships',
      {
        _id: membership._id,
        organizationId: organization,
        userId: actor,
        status: 'ACTIVE',
      },
      session,
    );
    if (requiresProjectMembership) {
      if (!projectMembership) throw new ForbiddenException();
      await this.fenceAuthorizationDocument(
        'project_memberships',
        {
          _id: projectMembership._id,
          organizationId: organization,
          projectId: projectObjectId,
          userId: actor,
          status: 'ACTIVE',
        },
        session,
      );
    }
    await this.fenceAuthorizationDocument(
      'role_assignments',
      {
        _id: authorizationAssignment._id,
        organizationId: organization,
        userId: actor,
        roleId: authorizationAssignment.roleId,
        roleCode: expectedRole,
        ...(expectedProjectId === null
          ? { $or: [{ projectId: { $exists: false } }, { projectId: null }] }
          : { projectId: projectObjectId }),
      },
      session,
    );
    const authorizationRole = rolesById.get(
      String(authorizationAssignment.roleId),
    );
    if (!authorizationRole) throw new ForbiddenException();
    await this.fenceAuthorizationDocument(
      'roles',
      {
        _id: authorizationRole._id,
        code: expectedRole,
        permissions:
          permission === 'project.delete'
            ? {
                $in: [
                  'project.delete',
                  'project.leader.manage',
                  'project.visibility.manage',
                ],
              }
            : permission,
      },
      session,
    );
    await this.fenceAuthorizationDocument(
      'projects',
      { _id: projectObjectId, organizationId: organization, status: 'ACTIVE' },
      session,
    );
    return project;
  }

  private async fenceAuthorizationDocument(
    collection: string,
    filter: Record<string, unknown>,
    session: ClientSession,
  ): Promise<void> {
    const result = await this.model(collection).updateOne(
      filter,
      { $inc: { __v: 1 } },
      { session, timestamps: false },
    );
    if (result.modifiedCount !== 1) throw new ForbiddenException();
  }

  private async fenceRecipientEligibility(
    user: UserDocument,
    organizationMembership: OrganizationMembershipDocument,
    projectMembership: MembershipDocument | null,
    organizationId: Types.ObjectId,
    projectId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    // A write to each eligibility document conflicts with a concurrent
    // status change in the same transaction. If revocation commits first,
    // the transaction retry re-reads the ineligible recipient and aborts.
    await this.fenceAuthorizationDocument(
      'users',
      { _id: user._id, status: 'ACTIVE' },
      session,
    );
    await this.fenceAuthorizationDocument(
      'organization_memberships',
      {
        _id: organizationMembership._id,
        organizationId,
        userId: user._id,
        status: 'ACTIVE',
      },
      session,
    );
    if (projectMembership) {
      await this.fenceAuthorizationDocument(
        'project_memberships',
        {
          _id: projectMembership._id,
          organizationId,
          projectId,
          userId: user._id,
          status: 'ACTIVE',
        },
        session,
      );
    }
  }

  private async fenceRole(
    role: RoleDocument,
    roleCode: string,
    requiredPermissions: readonly string[],
    session: ClientSession,
  ): Promise<void> {
    await this.fenceAuthorizationDocument(
      'roles',
      {
        _id: role._id,
        code: roleCode,
        ...(requiredPermissions.length > 0
          ? { permissions: { $all: [...requiredPermissions] } }
          : {}),
      },
      session,
    );
  }

  private async currentRole(
    code: string,
    session: ClientSession,
  ): Promise<RoleDocument | null> {
    return this.model<RoleDocument>('roles')
      .findOne({ code })
      .session(session)
      .lean()
      .exec();
  }

  private async audit(
    session: ClientSession,
    event: {
      organizationId: string;
      projectId: string;
      actorId: string;
      action: string;
      targetResource: string;
      targetResourceId: string;
    },
  ): Promise<void> {
    const connection = this.requireConnection();
    await connection
      .useDb(this.auditDatabaseName, { useCache: true })
      .collection(IAM_AUDIT_COLLECTION_NAME)
      .insertOne(
        {
          organizationId: event.organizationId,
          projectId: event.projectId,
          actorUserId: event.actorId,
          action: event.action,
          targetResource: event.targetResource,
          targetResourceId: event.targetResourceId,
          occurredAt: new Date(),
        },
        { session },
      );
  }

  private projectRecord(row: ProjectDocument): ProjectRecord {
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      name: row.name,
      code: row.code,
      ...(row.description === undefined
        ? {}
        : { description: row.description }),
      visibility: row.visibility ?? 'PRIVATE',
      status: row.status,
      createdBy: String(row.createdBy),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private membershipRecord(
    row: MembershipDocument,
    user?: {
      id: string;
      fullName?: string;
      email: string;
      avatarUrl?: string | null;
    } | null,
  ): ProjectMembershipRecord {
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      projectId: String(row.projectId),
      userId: String(row.userId),
      status: row.status,
      joinedAt: row.joinedAt.toISOString(),
      ...(user !== undefined ? { user } : {}),
    };
  }

  private assertIds(...values: string[]): void {
    if (!values.every(validId)) throw membershipNotFound();
  }

  private requireConnection(): Connection {
    if (!this.connection)
      throw new Error('Project Access persistence unavailable');
    return this.connection;
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model)
      throw new Error(`Project Access persistence unavailable: ${collection}`);
    return model;
  }
}
