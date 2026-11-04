import { HttpException } from '@nestjs/common';
import type { ClientSession, Connection, Model } from 'mongoose';
import {
  TEAM_OPERATION_PERMISSIONS,
  TeamAuthorizationPolicy,
} from '../../application/teams/team-authorization.policy';
import type { TeamAuthorizationEvaluationInput } from '../../application/teams/team-authorization.policy';
import {
  actionForbidden,
  policyNotReady,
  projectNotFound,
} from './team-foundation.repository-errors';
import {
  modelName,
  objectId,
  type AuthorizationFacts,
  type MutationCommand,
  type OrganizationMembershipDocument,
  type ProjectDocument,
  type ProjectMembershipDocument,
  type RoleAssignmentDocument,
  type RoleDocument,
  type UserDocument,
} from './team-foundation.repository.types';

export class TeamAuthorizationEvidence {
  constructor(
    private readonly policy: TeamAuthorizationPolicy,
    private readonly connection?: Connection,
  ) {}

  async load(
    organizationId: string,
    actorUserId: string,
    projectId: string,
    session?: ClientSession,
  ): Promise<AuthorizationFacts> {
    const organization = objectId(organizationId);
    const userId = objectId(actorUserId);
    const projectObjectId = objectId(projectId);
    const project = await this.findOne<ProjectDocument>(
      'projects',
      { _id: projectObjectId, organizationId: organization },
      session,
    );
    if (!project || project.status !== 'ACTIVE') throw projectNotFound();
    const user = await this.findOne<UserDocument>(
      'users',
      { _id: userId },
      session,
    );
    const organizationMembership =
      await this.findOne<OrganizationMembershipDocument>(
        'organization_memberships',
        { organizationId: organization, userId },
        session,
      );
    const projectMembership = await this.findOne<ProjectMembershipDocument>(
      'project_memberships',
      { organizationId: organization, projectId: projectObjectId, userId },
      session,
    );
    const assignments = await this.findMany<RoleAssignmentDocument>(
      'role_assignments',
      {
        organizationId: organization,
        userId,
        projectId: projectObjectId,
      },
      session,
    );
    const roleIds = assignments.map((assignment) => assignment.roleId);
    const roles = roleIds.length
      ? await this.findMany<RoleDocument>(
          'roles',
          { _id: { $in: roleIds } },
          session,
        )
      : [];
    const rolesById = new Map(roles.map((role) => [String(role._id), role]));
    return {
      user,
      organizationMembership,
      project,
      projectMembership,
      assignments: assignments.map((assignment) => {
        const role = rolesById.get(String(assignment.roleId)) ?? null;
        return {
          document: assignment,
          role,
          evidence: {
            userId: String(assignment.userId),
            organizationId: String(assignment.organizationId),
            projectId:
              assignment.projectId == null
                ? null
                : String(assignment.projectId),
            roleCode: assignment.roleCode,
            resolvedRoleCode: role?.code ?? null,
            permissions:
              Array.isArray(role?.permissions) &&
              role.permissions.every(
                (permission) => typeof permission === 'string',
              )
                ? role.permissions
                : [],
          },
        };
      }),
    };
  }

  hasActiveProjectAccess(
    facts: AuthorizationFacts,
    organizationId: string,
    actorUserId: string,
    projectId: string,
  ): boolean {
    return (
      facts.user?.status === 'ACTIVE' &&
      facts.organizationMembership?.status === 'ACTIVE' &&
      facts.project.status === 'ACTIVE' &&
      facts.projectMembership?.status === 'ACTIVE' &&
      String(facts.projectMembership.userId).toLowerCase() ===
        actorUserId.toLowerCase() &&
      String(facts.projectMembership.organizationId).toLowerCase() ===
        organizationId.toLowerCase() &&
      String(facts.projectMembership.projectId).toLowerCase() ===
        projectId.toLowerCase()
    );
  }

  authorizationInput(
    facts: AuthorizationFacts,
    organizationId: string,
    actorUserId: string,
    projectId: string,
    permission: TeamAuthorizationEvaluationInput['permission'],
  ): TeamAuthorizationEvaluationInput {
    return {
      permission,
      subject: {
        userId: actorUserId,
        organizationId,
        status: facts.user?.status ?? 'INACTIVE',
      },
      requestedOrganizationId: organizationId,
      requestedProjectId: projectId,
      project: {
        id: String(facts.project._id),
        organizationId: String(facts.project.organizationId),
        status: facts.project.status,
      },
      membership: facts.organizationMembership
        ? {
            userId: String(facts.organizationMembership.userId),
            organizationId: String(facts.organizationMembership.organizationId),
            status: facts.organizationMembership.status,
          }
        : null,
      projectMembership: facts.projectMembership
        ? {
            userId: String(facts.projectMembership.userId),
            organizationId: String(facts.projectMembership.organizationId),
            projectId: String(facts.projectMembership.projectId),
            status: facts.projectMembership.status,
          }
        : null,
      assignments: facts.assignments.map((assignment) => assignment.evidence),
      // The current IAM role/assignment sources persist positive permissions
      // only. No authoritative Team deny source is available to assess CLEAR.
      // Preserve DEC-002 fail-closed behavior until a deny-capable source is
      // selected and exposed through the evidence provider.
      explicitDeny: 'UNKNOWN',
    };
  }

  async fenceAuthorization(
    facts: AuthorizationFacts,
    command: MutationCommand,
    projectId: string,
    session: ClientSession,
  ): Promise<void> {
    const orgId = objectId(command.organizationId);
    const userId = objectId(command.actorUserId);
    const projectObjectId = objectId(projectId);
    if (
      !facts.user ||
      !facts.organizationMembership ||
      !facts.projectMembership
    )
      throw actionForbidden();
    const requiredPermissions = TEAM_OPERATION_PERMISSIONS[command.permission];
    const assignment = facts.assignments.find(
      (candidate) =>
        candidate.evidence.roleCode === 'TEAM_LEADER' &&
        candidate.evidence.resolvedRoleCode === 'TEAM_LEADER' &&
        candidate.evidence.projectId?.toLowerCase() ===
          projectId.toLowerCase() &&
        requiredPermissions.every((permission) =>
          candidate.evidence.permissions.includes(permission),
        ),
    );
    if (!assignment?.role) throw actionForbidden();
    const fences: Array<{ modifiedCount: number }> = [];
    fences.push(
      await this.model<UserDocument>('users').updateOne(
        { _id: userId, status: 'ACTIVE' },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    fences.push(
      await this.model<OrganizationMembershipDocument>(
        'organization_memberships',
      ).updateOne(
        {
          _id: facts.organizationMembership._id,
          organizationId: orgId,
          userId,
          status: 'ACTIVE',
        },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    fences.push(
      await this.model<ProjectMembershipDocument>(
        'project_memberships',
      ).updateOne(
        {
          _id: facts.projectMembership._id,
          organizationId: orgId,
          projectId: projectObjectId,
          userId,
          status: 'ACTIVE',
        },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    fences.push(
      await this.model<RoleAssignmentDocument>('role_assignments').updateOne(
        {
          _id: assignment.document._id,
          organizationId: orgId,
          userId,
          projectId: projectObjectId,
          roleId: assignment.document.roleId,
          roleCode: 'TEAM_LEADER',
        },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    fences.push(
      await this.model<RoleDocument>('roles').updateOne(
        {
          _id: assignment.role._id,
          code: 'TEAM_LEADER',
          permissions: { $all: requiredPermissions },
        },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    fences.push(
      await this.model<ProjectDocument>('projects').updateOne(
        { _id: projectObjectId, organizationId: orgId, status: 'ACTIVE' },
        { $inc: { __v: 1 } },
        { session, timestamps: false },
      ),
    );
    if (fences.some((result) => result.modifiedCount !== 1))
      throw actionForbidden();
  }

  private async findOne<T>(
    collection: string,
    filter: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<T | null> {
    try {
      let query = this.model<T>(collection).findOne(filter);
      if (session) query = query.session(session);
      return (await query.lean().exec()) as unknown as T | null;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw policyNotReady();
    }
  }

  private async findMany<T>(
    collection: string,
    filter: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<T[]> {
    try {
      let query = this.model<T>(collection).find(filter);
      if (session) query = query.session(session);
      return (await query.lean().exec()) as unknown as T[];
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw policyNotReady();
    }
  }

  private model<T>(collection: string): Model<T> {
    const model = this.connection?.models[modelName(collection)] as
      Model<T> | undefined;
    if (!model) throw policyNotReady();
    return model;
  }
}
