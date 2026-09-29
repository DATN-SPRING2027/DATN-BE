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

export interface RoleAssignmentEvidence {
  userId: string;
  organizationId: string;
  projectId?: string | null;
  roleCode: string;
}

export interface CapabilityGrantEvidence {
  userId: string;
  organizationId: string;
  capability: string;
  expiresAt: Date | null;
  revokedAt?: Date | null;
}

export interface AuthorizationEvaluationInput {
  permission: DocumentedPermission;
  subject: AuthorizationSubject | null;
  requestedOrganizationId: string;
  membership: OrganizationMembershipEvidence | null;
  roleAssignments: readonly RoleAssignmentEvidence[];
  grants: readonly CapabilityGrantEvidence[];
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

const validObjectId = (value: string): boolean => /^[a-f\d]{24}$/i.test(value);

@Injectable()
export class AuthorizationPolicy {
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

    const roles = new Set(
      input.roleAssignments
        .filter(
          (assignment) =>
            assignment.userId === subject.userId &&
            assignment.organizationId === requestedOrganizationId &&
            assignment.projectId == null,
        )
        .map((assignment) => assignment.roleCode),
    );
    if (roles.has('ADMIN')) return { allowed: true };

    if (
      roles.has('TEAM_LEADER') &&
      input.grants.some(
        (grant) =>
          grant.userId === subject.userId &&
          grant.organizationId === requestedOrganizationId &&
          grant.capability === 'project.create' &&
          grant.revokedAt == null &&
          grant.expiresAt instanceof Date &&
          Number.isFinite(grant.expiresAt.getTime()) &&
          grant.expiresAt.getTime() > input.now.getTime(),
      )
    )
      return { allowed: true };

    return { allowed: false, reason: 'NO_DOCUMENTED_PERMISSION' };
  }
}
