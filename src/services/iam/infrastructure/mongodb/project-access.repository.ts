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
import type { ClientSession, Connection, Model } from 'mongoose';
import type {
  ProjectAccessRepository,
  ProjectMembershipRecord,
  ProjectMembershipListQuery,
} from '../../application/projects/project-access.repository';
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
  status: string;
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

  async makePublic(
    organizationId: string,
    actorId: string,
    projectId: string,
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
        if (authorizedProject.visibility !== 'PRIVATE')
          throw new ConflictException({
            code: 'PROJECT_VISIBILITY_TRANSITION_NOT_ALLOWED',
            message: 'Only an active PRIVATE Project can be made PUBLIC.',
          });
        const project = await this.model<ProjectDocument>('projects')
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(projectId),
              organizationId: new Types.ObjectId(organizationId),
              status: 'ACTIVE',
              visibility: 'PRIVATE',
            },
            { $set: { visibility: 'PUBLIC' } },
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
            message: 'Only an active PRIVATE Project can be made PUBLIC.',
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
  ) {
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
    return {
      data: rows.map((row) => this.membershipRecord(row)),
      totalItems,
    };
  }

  async addMember(
    organizationId: string,
    actorId: string,
    projectId: string,
    userId: string,
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

        const memberRole = await this.currentRole('MEMBER', session);
        if (!memberRole?.permissions.includes('project.read'))
          throw new ConflictException({
            code: 'PROJECT_MEMBER_ROLE_UNAVAILABLE',
            message:
              'The current MEMBER Role with project.read is not provisioned.',
          });
        await this.fenceRole(memberRole, 'MEMBER', ['project.read'], session);

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
            existingAssignment.roleCode === 'TEAM_LEADER' ||
            currentRole?.code === 'TEAM_LEADER'
          )
            throw new ConflictException({
              code: 'PROJECT_LEADER_MUST_BE_REVOKED_FIRST',
              message:
                'A Project Leader appointment must be revoked by an ADMIN before removal or reactivation.',
            });
          if (
            existingAssignment.roleCode !== currentRole?.code ||
            currentRole?.code !== 'MEMBER'
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
                roleId: memberRole._id,
                roleCode: 'MEMBER',
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
                roleId: memberRole._id,
                roleCode: 'MEMBER',
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
        const projectMembership = await this.model<MembershipDocument>(
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
        if (!target || !organizationMembership || !projectMembership)
          throw membershipNotFound();
        await this.fenceRecipientEligibility(
          target,
          organizationMembership,
          projectMembership,
          organization,
          project,
          session,
        );

        const leaderRole = await this.currentRole('TEAM_LEADER', session);
        const leaderPermissions = [
          'project.read',
          'project.members.list',
          'project.members.add',
          'project.members.remove',
        ];
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
        const leaderPermissions = [
          'project.read',
          'project.members.list',
          'project.members.add',
          'project.members.remove',
        ];
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

    const requiresOrganizationAdmin =
      permission === 'project.visibility.manage' ||
      permission === 'project.leader.manage';
    const expectedRole = requiresOrganizationAdmin ? 'ADMIN' : 'TEAM_LEADER';
    const expectedProjectId = requiresOrganizationAdmin
      ? null
      : projectObjectId.toHexString();
    const authorizationAssignment = assignments.find((assignment) => {
      const role = rolesById.get(String(assignment.roleId));
      return (
        String(assignment.userId) === actorId &&
        String(assignment.organizationId) === organizationId &&
        (assignment.projectId == null ? null : String(assignment.projectId)) ===
          expectedProjectId &&
        assignment.roleCode === expectedRole &&
        role?.code === expectedRole &&
        role.permissions.includes(permission)
      );
    });
    if (!user || !membership || !authorizationAssignment)
      throw new ForbiddenException();

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
    if (!requiresOrganizationAdmin) {
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
        permissions: permission,
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

  private membershipRecord(row: MembershipDocument): ProjectMembershipRecord {
    return {
      id: String(row._id),
      organizationId: String(row.organizationId),
      projectId: String(row.projectId),
      userId: String(row.userId),
      status: row.status,
      joinedAt: row.joinedAt.toISOString(),
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
