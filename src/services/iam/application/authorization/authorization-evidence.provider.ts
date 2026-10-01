import type {
  ExplicitDenyAssessment,
  OrganizationMembershipEvidence,
} from './authorization.policy';

export const AUTHORIZATION_EVIDENCE_PROVIDER = Symbol(
  'AUTHORIZATION_EVIDENCE_PROVIDER',
);

export interface ProjectCreateEvidence {
  membership: OrganizationMembershipEvidence | null;
  explicitDeny: ExplicitDenyAssessment;
}

export interface AuthorizationEvidenceProvider {
  loadProjectCreate(
    userId: string,
    organizationId: string,
  ): Promise<ProjectCreateEvidence | null>;
}
