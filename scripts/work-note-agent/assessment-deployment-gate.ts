import { readFileSync } from 'node:fs';
import { evaluationArtifactHash } from './assessment-artifact';
import {
  evaluateValidatedConfig,
  loadValidatedConfigRegistry,
  type ActiveSurfaceConfig,
  type ValidatedConfigRegistry,
} from '../../src/services/capture/application/work-note-agent/validated-config.guard';

export type ReleaseReceipt = {
  runtimeArtifactHash: string;
  manifestHash: string;
  gateRunId: string;
  automatedGatePassed: boolean;
  provisional: boolean;
  semanticReview: {
    status: 'NOT_ESTABLISHED' | 'PASS';
    reviewer: string;
    evidenceRef: string;
    reviewedManifestHash: string;
  };
};

/** Verifies evidence linkage; does not manufacture or authenticate human approval. */
export function assertDeploymentReadiness(
  actualArtifactHash: string,
  active: ActiveSurfaceConfig,
  registry: ValidatedConfigRegistry,
  receipt: ReleaseReceipt,
): void {
  if (
    !/^[a-f0-9]{64}$/u.test(receipt.manifestHash) ||
    receipt.runtimeArtifactHash !== actualArtifactHash
  )
    throw Error('DEPLOY_ARTIFACT_MISMATCH');
  if (!receipt.automatedGatePassed || receipt.provisional)
    throw Error('DEPLOY_AUTOMATED_GATE_NOT_PASSED');
  if (
    receipt.semanticReview.status !== 'PASS' ||
    !receipt.semanticReview.reviewer.trim() ||
    !receipt.semanticReview.evidenceRef.trim() ||
    receipt.semanticReview.reviewedManifestHash !== receipt.manifestHash
  )
    throw Error('DEPLOY_HUMAN_REVIEW_NOT_ESTABLISHED');
  const decision = evaluateValidatedConfig(active, registry);
  if (!decision.allowed || !decision.validatedConfig)
    throw Error('DEPLOY_CONFIG_NOT_VALIDATED');
  const matchingEntry = registry.entries.find(
    (entry) =>
      entry.surface === active.surface &&
      entry.gateRunId === decision.matchedGateRunId,
  );
  if (
    !matchingEntry ||
    matchingEntry.manifestHash !== receipt.manifestHash ||
    matchingEntry.gateRunId !== receipt.gateRunId
  )
    throw Error('DEPLOY_RECEIPT_REGISTRY_MISMATCH');
}

if (require.main === module) {
  try {
    const [activePath, receiptPath, expectedSurface, ...extra] =
      process.argv.slice(2);
    if (
      !activePath ||
      !receiptPath ||
      !['assessment', 'assessment-editor', 'rewrite'].includes(
        expectedSurface,
      ) ||
      extra.length
    )
      throw Error('DEPLOY_GATE_USAGE_ACTIVE_JSON_RECEIPT_JSON');
    const active = JSON.parse(
      readFileSync(activePath, 'utf8'),
    ) as ActiveSurfaceConfig;
    if (active.surface !== expectedSurface)
      throw Error('DEPLOY_SURFACE_MISMATCH');
    const receipt = JSON.parse(
      readFileSync(receiptPath, 'utf8'),
    ) as ReleaseReceipt;
    assertDeploymentReadiness(
      evaluationArtifactHash(),
      active,
      loadValidatedConfigRegistry(),
      receipt,
    );
    process.stdout.write('DEPLOY_SURFACE_EVIDENCE_VERIFIED\n');
  } catch (error) {
    const message =
      error instanceof Error && /^DEPLOY_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'DEPLOY_RELEASE_EVIDENCE_INVALID';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  }
}
