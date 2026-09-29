import type {
  CapabilityGrantEvidence,
  ExplicitDenyAssessment,
  OrganizationMembershipEvidence,
  RoleAssignmentEvidence,
} from './authorization.policy';

export const AUTHORIZATION_EVIDENCE_PROVIDER = Symbol(
  'AUTHORIZATION_EVIDENCE_PROVIDER',
);

export interface ProjectCreateEvidence {
  membership: OrganizationMembershipEvidence | null;
  roleAssignments: readonly RoleAssignmentEvidence[];
  grants: readonly CapabilityGrantEvidence[];
  explicitDeny: ExplicitDenyAssessment;
}

export interface AuthorizationEvidenceProvider {
  loadProjectCreate(
    userId: string,
    organizationId: string,
  ): Promise<ProjectCreateEvidence | null>;
}
