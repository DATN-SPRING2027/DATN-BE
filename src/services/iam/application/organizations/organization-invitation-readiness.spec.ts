import {
  areInvitationReadinessGatesReady,
  UnconfiguredOrganizationInvitationReadiness,
  type OrganizationInvitationReadinessGate,
} from './organization-invitation-readiness';

describe('Unconfigured invitation readiness', () => {
  it.each<OrganizationInvitationReadinessGate>([
    'A7_NOTIFICATION_CONTRACT_PROVIDER',
    'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF',
    'A8_COORDINATED_CUTOVER',
  ])(
    'keeps %s closed until a runtime adapter supplies evidence',
    async (gate) => {
      expect(
        await areInvitationReadinessGatesReady(
          new UnconfiguredOrganizationInvitationReadiness(),
          [gate],
        ),
      ).toBe(false);
    },
  );
});
