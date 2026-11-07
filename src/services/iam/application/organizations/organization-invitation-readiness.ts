import { Inject, Injectable, Optional } from '@nestjs/common';

export const ORGANIZATION_INVITATION_READINESS = Symbol(
  'ORGANIZATION_INVITATION_READINESS',
);

export const ORGANIZATION_INVITATION_READINESS_EVIDENCE = Symbol(
  'ORGANIZATION_INVITATION_READINESS_EVIDENCE',
);

export type OrganizationInvitationReadinessGate =
  | 'A7_NOTIFICATION_CONTRACT_PROVIDER'
  | 'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF'
  | 'A8_COORDINATED_CUTOVER';

export type OrganizationInvitationReadinessGateEvidence =
  boolean | (() => boolean | Promise<boolean>);

export type OrganizationInvitationReadinessEvidence = Partial<
  Record<
    OrganizationInvitationReadinessGate,
    OrganizationInvitationReadinessGateEvidence
  >
>;

export interface OrganizationInvitationReadiness {
  isReady(gate: OrganizationInvitationReadinessGate): Promise<boolean>;
}

/**
 * The A7 provider/proof and A8 cutover owners have not wired their readiness
 * evidence into IAM. Keep all invitation mutations closed until that evidence
 * is supplied by a reviewed runtime adapter.
 */
@Injectable()
export class UnconfiguredOrganizationInvitationReadiness implements OrganizationInvitationReadiness {
  isReady(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

@Injectable()
export class ConfiguredOrganizationInvitationReadiness implements OrganizationInvitationReadiness {
  constructor(
    @Optional()
    @Inject(ORGANIZATION_INVITATION_READINESS_EVIDENCE)
    private readonly evidence: OrganizationInvitationReadinessEvidence = {},
  ) {}

  async isReady(gate: OrganizationInvitationReadinessGate): Promise<boolean> {
    try {
      const gateEvidence = this.evidence?.[gate];
      if (typeof gateEvidence === 'function') {
        return (await gateEvidence()) === true;
      }
      return gateEvidence === true;
    } catch {
      return false;
    }
  }
}

export async function areInvitationReadinessGatesReady(
  readiness: OrganizationInvitationReadiness,
  gates: readonly OrganizationInvitationReadinessGate[],
): Promise<boolean> {
  try {
    for (const gate of gates) {
      if (!(await readiness.isReady(gate))) return false;
    }
  } catch {
    return false;
  }
  return true;
}
