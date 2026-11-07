import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { Provider } from '@nestjs/common';
import { IamModule } from '../../iam.module';
import {
  areInvitationReadinessGatesReady,
  ConfiguredOrganizationInvitationReadiness,
  ORGANIZATION_INVITATION_READINESS,
  ORGANIZATION_INVITATION_READINESS_EVIDENCE,
  UnconfiguredOrganizationInvitationReadiness,
  type OrganizationInvitationReadiness,
  type OrganizationInvitationReadinessGate,
} from './organization-invitation-readiness';

const allReadinessGates: OrganizationInvitationReadinessGate[] = [
  'A7_NOTIFICATION_CONTRACT_PROVIDER',
  'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF',
  'A8_COORDINATED_CUTOVER',
];

describe('Organization invitation readiness (A7/A8)', () => {
  it.each<OrganizationInvitationReadinessGate>(allReadinessGates)(
    'keeps %s closed in UnconfiguredOrganizationInvitationReadiness',
    async (gate) => {
      expect(
        await areInvitationReadinessGatesReady(
          new UnconfiguredOrganizationInvitationReadiness(),
          [gate],
        ),
      ).toBe(false);
    },
  );

  it.each<OrganizationInvitationReadinessGate>(allReadinessGates)(
    'keeps %s closed in ConfiguredOrganizationInvitationReadiness when gate evidence is absent',
    async (gate) => {
      const adapter = new ConfiguredOrganizationInvitationReadiness();
      expect(await adapter.isReady(gate)).toBe(false);
      expect(await areInvitationReadinessGatesReady(adapter, [gate])).toBe(
        false,
      );
    },
  );

  it('requires explicit per-gate evidence before opening invitation mutations', async () => {
    const partialAdapter = new ConfiguredOrganizationInvitationReadiness({
      A7_NOTIFICATION_CONTRACT_PROVIDER: true,
    });
    expect(
      await areInvitationReadinessGatesReady(partialAdapter, [
        'A7_NOTIFICATION_CONTRACT_PROVIDER',
        'A8_COORDINATED_CUTOVER',
      ]),
    ).toBe(false);

    const fullAdapter = new ConfiguredOrganizationInvitationReadiness({
      A7_NOTIFICATION_CONTRACT_PROVIDER: () => Promise.resolve(true),
      A8_COORDINATED_CUTOVER: true,
    });
    expect(
      await areInvitationReadinessGatesReady(fullAdapter, [
        'A7_NOTIFICATION_CONTRACT_PROVIDER',
        'A8_COORDINATED_CUTOVER',
      ]),
    ).toBe(true);
    expect(
      await areInvitationReadinessGatesReady(fullAdapter, [
        'A7_LEGACY_OR_ORPHAN_RIGHTS_ACTIVATION_PROOF',
      ]),
    ).toBe(false);
  });

  it('wires IamModule runtime provider for ORGANIZATION_INVITATION_READINESS to fail closed without unverified gate evidence', async () => {
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IamModule) as
        Provider[] | undefined) ?? [];
    const readinessProvider = providers.find(
      (provider): provider is Extract<Provider, { provide: unknown }> =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === ORGANIZATION_INVITATION_READINESS,
    );
    expect(readinessProvider).toBeDefined();

    const evidenceProviders = providers.filter(
      (provider): provider is Extract<Provider, { provide: unknown }> =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === ORGANIZATION_INVITATION_READINESS_EVIDENCE,
    );

    const moduleRef = await Test.createTestingModule({
      providers: [readinessProvider!, ...evidenceProviders],
    }).compile();
    const runtimeReadiness = moduleRef.get<OrganizationInvitationReadiness>(
      ORGANIZATION_INVITATION_READINESS,
    );

    for (const gate of allReadinessGates) {
      expect(await runtimeReadiness.isReady(gate)).toBe(false);
    }
    expect(
      await areInvitationReadinessGatesReady(
        runtimeReadiness,
        allReadinessGates,
      ),
    ).toBe(false);
  });
});
