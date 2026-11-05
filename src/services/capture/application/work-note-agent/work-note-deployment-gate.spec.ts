import {
  assertDeploymentReadiness,
  type ReleaseReceipt,
} from '../../../../../scripts/work-note-agent/assessment-deployment-gate';
import {
  hashProviderPolicy,
  type ActiveSurfaceConfig,
  type ValidatedConfigRegistry,
} from './validated-config.guard';

describe('Deployment evidence gate', () => {
  const active: ActiveSurfaceConfig = {
    surface: 'assessment',
    promptVersion: 'synthetic-version',
    model: 'test/model',
    architecture: 'combined',
    providerPolicy: {
      maxTokens: 8192,
      timeoutMs: 85000,
      jsonMode: true,
      temperature: 0.1,
      retries: 0,
    },
  };
  const receipt: ReleaseReceipt = {
    runtimeArtifactHash: 'artifact',
    manifestHash: 'a'.repeat(64),
    gateRunId: 'synthetic-gate',
    automatedGatePassed: true,
    provisional: false,
    semanticReview: {
      status: 'PASS',
      reviewer: 'synthetic-reviewer',
      evidenceRef: 'synthetic-review-record',
      reviewedManifestHash: 'a'.repeat(64),
    },
  };
  const registry: ValidatedConfigRegistry = {
    schemaVersion: 1,
    entries: [
      {
        ...active,
        manifestHash: receipt.manifestHash,
        gateRunId: receipt.gateRunId,
        providerPolicyHash: hashProviderPolicy(active.providerPolicy),
        passedAt: '2026-11-04T00:00:00Z',
      },
    ],
  };
  it('accepts only matched artifact, surface registry and reviewed gate receipt', () => {
    expect(() =>
      assertDeploymentReadiness('artifact', active, registry, receipt),
    ).not.toThrow();
  });
  it('blocks warn-only runtime configurations from deployment', () => {
    expect(() =>
      assertDeploymentReadiness(
        'artifact',
        active,
        { schemaVersion: 1, entries: [] },
        receipt,
      ),
    ).toThrow('CONFIG_NOT_VALIDATED');
  });
  it.each([
    { runtimeArtifactHash: 'changed' },
    { automatedGatePassed: false },
    { provisional: true },
    {
      semanticReview: {
        ...receipt.semanticReview,
        status: 'NOT_ESTABLISHED' as const,
      },
    },
    { gateRunId: 'unrelated-gate' },
  ])('blocks changed or missing release evidence: %j', (patch) => {
    expect(() =>
      assertDeploymentReadiness('artifact', active, registry, {
        ...receipt,
        ...patch,
      }),
    ).toThrow();
  });
});
