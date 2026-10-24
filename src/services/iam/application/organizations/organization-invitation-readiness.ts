import { Injectable } from '@nestjs/common';

export const ORGANIZATION_INVITATION_READINESS = Symbol(
  'ORGANIZATION_INVITATION_READINESS',
);

export type OrganizationInvitationReadinessGate =
  | 'A7_NOTIFICATION_CONTRACT_PROVIDER'
  | 'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF'
  | 'A8_COORDINATED_CUTOVER';

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
  isReady(): Promise<boolean> {
    return Promise.resolve(true);
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
