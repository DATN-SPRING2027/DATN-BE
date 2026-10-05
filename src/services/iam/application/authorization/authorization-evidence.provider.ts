import type {
  ExplicitDenyAssessment,
  OrganizationMembershipEvidence,
  PlatformAuthorityAssignmentEvidence,
  PlatformPermission,
  ProjectAccessAssignmentEvidence,
  ProjectAccessProjectEvidence,
} from './authorization.policy';

export const AUTHORIZATION_EVIDENCE_PROVIDER = Symbol(
  'AUTHORIZATION_EVIDENCE_PROVIDER',
);

export interface ProjectCreateEvidence {
  membership: OrganizationMembershipEvidence | null;
  explicitDeny: ExplicitDenyAssessment;
}

export interface ProjectAccessEvidence {
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

export interface PlatformPermissionEvidence {
  assignments: readonly PlatformAuthorityAssignmentEvidence[];
}

export interface AuthorizationEvidenceProvider {
  loadProjectCreate(
    userId: string,
    organizationId: string,
  ): Promise<ProjectCreateEvidence | null>;
  loadProjectAccess(
    userId: string,
    organizationId: string,
    projectId: string,
  ): Promise<ProjectAccessEvidence | null>;
  loadPlatformPermission(
    userId: string,
    permission: PlatformPermission,
  ): Promise<PlatformPermissionEvidence | null>;
}
