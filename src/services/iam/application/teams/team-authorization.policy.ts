import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';
import type {
  AuthorizationSubject,
  ExplicitDenyAssessment,
  OrganizationMembershipEvidence,
  ProjectAccessAssignmentEvidence,
  ProjectAccessProjectEvidence,
} from '../authorization/authorization.policy';

export type TeamActionPermission =
  'team.create' | 'team.update' | 'team.archive' | 'team.restore' | 'team.read';

export const TEAM_OPERATION_PERMISSIONS: Readonly<
  Record<TeamActionPermission, readonly string[]>
> = {
  'team.create': ['team.create', 'team.children.manage'],
  'team.update': ['team.update', 'team.children.manage'],
  'team.archive': ['team.archive', 'team.children.manage'],
  'team.restore': ['team.restore', 'team.children.manage'],
  'team.read': ['team.read', 'team.children.manage'],
};

export interface TeamAuthorizationEvaluationInput {
  permission: TeamActionPermission;
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

export type TeamAuthorizationDecision =
  | { allowed: true; access: 'MANAGER' }
  | {
      allowed: false;
      reason:
        | 'INVALID_CONTEXT'
        | 'INACTIVE_MEMBERSHIP'
        | 'EXPLICIT_DENY_OR_UNKNOWN'
        | 'NO_DOCUMENTED_PERMISSION';
    };

const validObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);
const sameObjectId = (left: string, right: string): boolean =>
  validObjectId(left) &&
  validObjectId(right) &&
  new Types.ObjectId(left).equals(new Types.ObjectId(right));
const hasPermissions = (candidate: unknown, required: readonly string[]) =>
  Array.isArray(candidate) &&
  candidate.every((permission) => typeof permission === 'string') &&
  required.every((permission) => candidate.includes(permission));

@Injectable()
export class TeamAuthorizationPolicy {
  evaluate(input: TeamAuthorizationEvaluationInput): TeamAuthorizationDecision {
    const {
      subject,
      membership,
      project,
      requestedOrganizationId,
      requestedProjectId,
    } = input;
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
      membership.status !== 'ACTIVE' ||
      !input.projectMembership ||
      !sameObjectId(input.projectMembership.userId, subject.userId) ||
      !sameObjectId(
        input.projectMembership.organizationId,
        requestedOrganizationId,
      ) ||
      !sameObjectId(input.projectMembership.projectId, requestedProjectId) ||
      input.projectMembership.status !== 'ACTIVE'
    )
      return { allowed: false, reason: 'INACTIVE_MEMBERSHIP' };

    if (input.explicitDeny !== 'CLEAR')
      return { allowed: false, reason: 'EXPLICIT_DENY_OR_UNKNOWN' };

    const scopedAssignments = input.assignments.filter(
      (assignment) =>
        sameObjectId(assignment.userId, subject.userId) &&
        sameObjectId(assignment.organizationId, requestedOrganizationId) &&
        sameObjectId(assignment.projectId ?? '', requestedProjectId),
    );
    const requiredPermissions = TEAM_OPERATION_PERMISSIONS[input.permission];
    const manager = scopedAssignments.some(
      (assignment) =>
        assignment.roleCode === 'TEAM_LEADER' &&
        assignment.resolvedRoleCode === 'TEAM_LEADER' &&
        hasPermissions(assignment.permissions, requiredPermissions),
    );
    if (manager) return { allowed: true, access: 'MANAGER' };

    return { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
  }
}
