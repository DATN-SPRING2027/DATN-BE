import { Injectable } from '@nestjs/common';

export type DocumentedPermission = 'project.create';
export type ExplicitDenyAssessment = 'CLEAR' | 'DENY' | 'UNKNOWN';

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

export type ProjectReadScope =
  | { all: true; projectIds: readonly string[] }
  | { all: false; projectIds: readonly string[] };

const validObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class AuthorizationPolicy {
  projectReadScope(input: ProjectReadScopeInput): ProjectReadScope {
    const deny: ProjectReadScope = { all: false, projectIds: [] };
    const { subject, membership, requestedOrganizationId } = input;
    if (
      !subject ||
      !validObjectId(subject.userId) ||
      !validObjectId(subject.organizationId) ||
      !validObjectId(requestedOrganizationId) ||
      subject.organizationId !== requestedOrganizationId ||
      subject.status !== 'ACTIVE' ||
      !membership ||
      membership.userId !== subject.userId ||
      membership.organizationId !== requestedOrganizationId ||
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
      return { all: true, projectIds: [] };

    const active = new Set(input.activeProjectMembershipIds);
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
              active.has(assignment.projectId),
          )
          .map((assignment) => assignment.projectId as string),
      ),
    ];
    return { all: false, projectIds };
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
