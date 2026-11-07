import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
const notificationKey =
  'ORGANIZATION_INVITATION_A7_NOTIFICATION_EVIDENCE_SHA256';
const legacyRightsKey =
  'ORGANIZATION_INVITATION_A7_LEGACY_RIGHTS_EVIDENCE_SHA256';
const cutoverKey = 'ORGANIZATION_INVITATION_A8_CUTOVER_EVIDENCE_SHA256';

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
      A7_NOTIFICATION_CONTRACT_PROVIDER: 'a'.repeat(64),
    });
    expect(
      await areInvitationReadinessGatesReady(partialAdapter, [
        'A7_NOTIFICATION_CONTRACT_PROVIDER',
        'A8_COORDINATED_CUTOVER',
      ]),
    ).toBe(false);

    const fullAdapter = new ConfiguredOrganizationInvitationReadiness({
      A7_NOTIFICATION_CONTRACT_PROVIDER: 'a'.repeat(64),
      A8_COORDINATED_CUTOVER: 'b'.repeat(64),
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

  it.each([
    { name: 'blank', evidence: {}, expected: [false, false, false] },
    {
      name: 'partial',
      evidence: {
        [notificationKey]: 'a'.repeat(64),
        [cutoverKey]: 'c'.repeat(64),
      },
      expected: [true, false, true],
    },
    {
      name: 'full',
      evidence: {
        [notificationKey]: 'a'.repeat(64),
        [legacyRightsKey]: 'b'.repeat(64),
        [cutoverKey]: 'c'.repeat(64),
      },
      expected: [true, true, true],
    },
    {
      name: 'malformed',
      evidence: {
        [notificationKey]: 'true',
        [legacyRightsKey]: 'g'.repeat(64),
        [cutoverKey]: 'c'.repeat(63),
      },
      expected: [false, false, false],
    },
  ])(
    'wires IAM readiness for $name deployment evidence',
    async ({ evidence, expected }) => {
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
        providers: [
          readinessProvider!,
          ...evidenceProviders,
          {
            provide: ConfigService,
            useValue: new ConfigService({
              [notificationKey]: '',
              [legacyRightsKey]: '',
              [cutoverKey]: '',
              ...evidence,
            }),
          },
        ],
      }).compile();
      const runtimeReadiness = moduleRef.get<OrganizationInvitationReadiness>(
        ORGANIZATION_INVITATION_READINESS,
      );

      try {
        await expect(
          Promise.all(
            allReadinessGates.map((gate) => runtimeReadiness.isReady(gate)),
          ),
        ).resolves.toEqual(expected);
        await expect(
          areInvitationReadinessGatesReady(runtimeReadiness, allReadinessGates),
        ).resolves.toBe(expected.every(Boolean));
      } finally {
        await moduleRef.close();
      }
    },
  );
});
