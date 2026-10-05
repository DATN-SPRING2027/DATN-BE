import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';

export type DocumentedPermission = 'project.create';
export type PlatformPermission =
  'organization.create' | 'platform.health.read' | 'platform.audit.read';
export const PLATFORM_PERMISSIONS: readonly PlatformPermission[] = [
  'organization.create',
  'platform.health.read',
  'platform.audit.read',
];
export type ProjectAccessPermission =
  | 'project.visibility.manage'
  | 'project.leader.manage'
  | 'project.members.list'
  | 'project.members.add'
  | 'project.members.remove';
const enabledProjectAccessPermissions: ReadonlySet<string> = new Set([
  'project.visibility.manage',
  'project.leader.manage',
  'project.members.list',
  'project.members.add',
  'project.members.remove',
]);
export type ExplicitDenyAssessment = 'CLEAR' | 'DENY' | 'UNKNOWN';

export interface PlatformAuthorizationSubject {
  userId: string;
  status: string;
}

export interface PlatformAuthorityAssignmentEvidence {
  subjectUserId: string;
  grantedAt: Date;
  grantedBy: string;
  permission: string;
  scope: string;
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface PlatformAuthorizationEvaluationInput {
  permission: string;
  subject: PlatformAuthorizationSubject | null;
  assignments: readonly PlatformAuthorityAssignmentEvidence[];
  now: Date;
}

export interface AuthorizationSubject {
  userId: string;
  organizationId: string;
  status: string;
}

export interface OrganizationMembershipEvidence {
  userId: string;
  organizationId: string;
  status: string;
}

export interface AuthorizationEvaluationInput {
  permission: DocumentedPermission;
  subject: AuthorizationSubject | null;
  requestedOrganizationId: string;
  membership: OrganizationMembershipEvidence | null;
  explicitDeny: ExplicitDenyAssessment;
  now: Date;
}

export type AuthorizationDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'INVALID_CONTEXT'
        | 'INACTIVE_MEMBERSHIP'
        | 'EXPLICIT_DENY_OR_UNKNOWN'
        | 'NO_DOCUMENTED_PERMISSION';
    };

export interface ProjectReadAssignmentEvidence {
  projectId: string | null;
  roleCode: string;
  resolvedRoleCode: string | null;
  permissions: readonly string[];
}

export interface ProjectReadScopeInput {
  subject: AuthorizationSubject | null;
  requestedOrganizationId: string;
  membership: OrganizationMembershipEvidence | null;
  assignments: readonly ProjectReadAssignmentEvidence[];
  activeProjectMembershipIds: readonly string[];
  explicitDeny: ExplicitDenyAssessment;
}

export interface ProjectAccessProjectEvidence {
  id: string;
  organizationId: string;
  status: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
}

export interface ProjectAccessAssignmentEvidence extends ProjectReadAssignmentEvidence {
  userId: string;
  organizationId: string;
}

export interface ProjectAccessEvaluationInput {
  permission: ProjectAccessPermission;
  subject: AuthorizationSubject | null;
  requestedOrganizationId: string;
  requestedProjectId: string;
  project: ProjectAccessProjectEvidence | null;
  membership: OrganizationMembershipEvidence | null;
  projectMembership: {
    userId: string;
    organizationId: string;
    projectId: string;
    status: string;
  } | null;
  assignments: readonly ProjectAccessAssignmentEvidence[];
  explicitDeny: ExplicitDenyAssessment;
}

export type ProjectReadScope =
  | {
      all: true;
      projectIds: readonly string[];
      includePublicProjects: false;
    }
  | {
      all: false;
      projectIds: readonly string[];
      includePublicProjects: boolean;
    };

const validObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);
const objectIdKey = (value: string): string | null =>
  validObjectId(value) ? new Types.ObjectId(value).toHexString() : null;
const sameObjectId = (left: string, right: string): boolean =>
  validObjectId(left) &&
  validObjectId(right) &&
  new Types.ObjectId(left).equals(new Types.ObjectId(right));

@Injectable()
export class AuthorizationPolicy {
  evaluatePlatformPermission(
    input: PlatformAuthorizationEvaluationInput,
  ): AuthorizationDecision {
    if (!PLATFORM_PERMISSIONS.includes(input.permission as PlatformPermission))
      return { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
    if (
      !input.subject ||
      !validObjectId(input.subject.userId) ||
      input.subject.status !== 'ACTIVE' ||
      !Number.isFinite(input.now.getTime())
    )
      return { allowed: false, reason: 'INVALID_CONTEXT' };

    const validAssignments = input.assignments.filter(
      (assignment) =>
        sameObjectId(assignment.subjectUserId, input.subject!.userId) &&
        assignment.grantedAt instanceof Date &&
        Number.isFinite(assignment.grantedAt.getTime()) &&
        assignment.grantedAt.getTime() <= input.now.getTime() &&
        validObjectId(assignment.grantedBy) &&
        !sameObjectId(assignment.grantedBy, input.subject!.userId) &&
        assignment.permission === input.permission &&
        assignment.scope === 'PLATFORM' &&
        assignment.status === 'ACTIVE' &&
        assignment.revokedAt === null &&
        (assignment.expiresAt === null ||
          (Number.isFinite(assignment.expiresAt.getTime()) &&
            assignment.expiresAt.getTime() > input.now.getTime())),
    );

    // Duplicate active evidence is ambiguous and therefore cannot authorize.
    return validAssignments.length === 1
      ? { allowed: true }
      : { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
  }

  projectReadScope(input: ProjectReadScopeInput): ProjectReadScope {
    const deny: ProjectReadScope = {
      all: false,
      projectIds: [],
      includePublicProjects: false,
    };
    const { subject, membership, requestedOrganizationId } = input;
    if (
      !subject ||
      !validObjectId(subject.userId) ||
      !validObjectId(subject.organizationId) ||
      !validObjectId(requestedOrganizationId) ||
      !sameObjectId(subject.organizationId, requestedOrganizationId) ||
      subject.status !== 'ACTIVE' ||
      !membership ||
      !sameObjectId(membership.userId, subject.userId) ||
      !sameObjectId(membership.organizationId, requestedOrganizationId) ||
      membership.status !== 'ACTIVE' ||
      input.explicitDeny !== 'CLEAR'
    )
      return deny;

    if (
      input.assignments.some(
        (assignment) =>
          assignment.projectId === null &&
          assignment.roleCode === 'ADMIN' &&
          assignment.resolvedRoleCode === 'ADMIN',
      )
    )
      return {
        all: true,
        projectIds: [],
        includePublicProjects: false,
      };

    const active = new Set(
      input.activeProjectMembershipIds
        .map(objectIdKey)
        .filter((id): id is string => id !== null),
    );
    const projectIds = [
      ...new Set(
        input.assignments
          .filter(
            (assignment) =>
              assignment.projectId !== null &&
              (assignment.roleCode === 'TEAM_LEADER' ||
                assignment.roleCode === 'MEMBER') &&
              assignment.resolvedRoleCode === assignment.roleCode &&
              assignment.permissions.includes('project.read') &&
              objectIdKey(assignment.projectId) !== null &&
              active.has(objectIdKey(assignment.projectId) as string),
          )
          .map((assignment) => objectIdKey(assignment.projectId as string)!),
      ),
    ];
    return { all: false, projectIds, includePublicProjects: true };
  }

  evaluateProjectAccess(
    input: ProjectAccessEvaluationInput,
  ): AuthorizationDecision {
    const {
      subject,
      membership,
      project,
      requestedOrganizationId,
      requestedProjectId,
      permission,
    } = input;
    if (!enabledProjectAccessPermissions.has(permission))
      return { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };

    if (
      !subject ||
      !validObjectId(subject.userId) ||
      !validObjectId(subject.organizationId) ||
      !validObjectId(requestedOrganizationId) ||
      !validObjectId(requestedProjectId) ||
      !sameObjectId(subject.organizationId, requestedOrganizationId) ||
      subject.status !== 'ACTIVE' ||
      !project ||
      !sameObjectId(project.id, requestedProjectId) ||
      !sameObjectId(project.organizationId, requestedOrganizationId) ||
      project.status !== 'ACTIVE'
    )
      return { allowed: false, reason: 'INVALID_CONTEXT' };

    if (
      !membership ||
      !sameObjectId(membership.userId, subject.userId) ||
      !sameObjectId(membership.organizationId, requestedOrganizationId) ||
      membership.status !== 'ACTIVE'
    )
      return { allowed: false, reason: 'INACTIVE_MEMBERSHIP' };

    if (input.explicitDeny !== 'CLEAR')
      return { allowed: false, reason: 'EXPLICIT_DENY_OR_UNKNOWN' };

    const requiresOrganizationAdmin =
      permission === 'project.visibility.manage' ||
      permission === 'project.leader.manage';
    if (
      !requiresOrganizationAdmin &&
      (!input.projectMembership ||
        !sameObjectId(input.projectMembership.userId, subject.userId) ||
        !sameObjectId(
          input.projectMembership.organizationId,
          requestedOrganizationId,
        ) ||
        !sameObjectId(input.projectMembership.projectId, requestedProjectId) ||
        input.projectMembership.status !== 'ACTIVE')
    )
      return { allowed: false, reason: 'INACTIVE_MEMBERSHIP' };

    const expectedRole = requiresOrganizationAdmin ? 'ADMIN' : 'TEAM_LEADER';
    const expectedProjectId = requiresOrganizationAdmin
      ? null
      : requestedProjectId;
    const allowed = input.assignments.some(
      (assignment) =>
        sameObjectId(assignment.userId, subject.userId) &&
        sameObjectId(assignment.organizationId, requestedOrganizationId) &&
        (assignment.projectId === null
          ? expectedProjectId === null
          : expectedProjectId !== null &&
            sameObjectId(assignment.projectId, expectedProjectId)) &&
        assignment.roleCode === expectedRole &&
        assignment.resolvedRoleCode === expectedRole &&
        assignment.permissions.includes(permission),
    );
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
  }

  evaluate(input: AuthorizationEvaluationInput): AuthorizationDecision {
    const { subject, membership, requestedOrganizationId } = input;
    if (
      !subject ||
      !validObjectId(subject.userId) ||
      !validObjectId(subject.organizationId) ||
      !validObjectId(requestedOrganizationId) ||
      subject.organizationId !== requestedOrganizationId ||
      subject.status !== 'ACTIVE' ||
      !Number.isFinite(input.now.getTime())
    )
      return { allowed: false, reason: 'INVALID_CONTEXT' };

    if (
      !membership ||
      membership.userId !== subject.userId ||
      membership.organizationId !== requestedOrganizationId ||
      membership.status !== 'ACTIVE'
    )
      return { allowed: false, reason: 'INACTIVE_MEMBERSHIP' };

    if (input.explicitDeny !== 'CLEAR') {
      return { allowed: false, reason: 'EXPLICIT_DENY_OR_UNKNOWN' };
    }

    if (input.permission !== 'project.create') {
      return { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
    }

    // The accepted Project decision supersedes the older role/grant gate:
    // every authenticated User with an ACTIVE membership in the trusted
    // Organization Context may create a Project.
    return { allowed: true };
  }
}
