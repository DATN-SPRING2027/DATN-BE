import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ValidatedPromptSurface =
  'assessment' | 'rewrite' | 'assessment-editor';

export type ValidatedSurfaceArchitecture = 'combined' | 'split' | 'single';

export type ProviderPolicySnapshot = Readonly<{
  maxTokens: number;
  timeoutMs: number;
  jsonMode: boolean;
  temperature: number;
  retries: number;
}>;

export type ValidatedConfigEntry = Readonly<{
  surface: ValidatedPromptSurface;
  promptVersion: string;
  manifestHash: string;
  model: string;
  architecture: ValidatedSurfaceArchitecture;
  providerPolicy: ProviderPolicySnapshot;
  providerPolicyHash: string;
  gateRunId: string;
  passedAt: string;
}>;

export type ValidatedConfigRegistry = Readonly<{
  schemaVersion: 1;
  entries: readonly ValidatedConfigEntry[];
}>;

export type ActiveSurfaceConfig = Readonly<{
  surface: ValidatedPromptSurface;
  promptVersion: string;
  model: string;
  architecture: ValidatedSurfaceArchitecture;
  providerPolicy: ProviderPolicySnapshot;
}>;

export type ValidatedConfigDecision =
  | Readonly<{
      allowed: true;
      validatedConfig: true;
      reason: 'MATCHED_VALIDATED_CONFIG';
      providerPolicyHash: string;
      matchedGateRunId: string;
    }>
  | Readonly<{
      allowed: true;
      validatedConfig: false;
      reason: 'NO_PASS_BASELINE_WARN_ONLY';
      providerPolicyHash: string;
    }>
  | Readonly<{
      allowed: false;
      validatedConfig: false;
      reason: 'UNVALIDATED_CONFIG_BLOCKED';
      providerPolicyHash: string;
      mismatchedFields: readonly (
        | 'promptVersion'
        | 'model'
        | 'architecture'
        | 'providerPolicyHash'
        | 'baseline'
      )[];
    }>;

export function hashProviderPolicy(policy: ProviderPolicySnapshot): string {
  const canonical = JSON.stringify({
    maxTokens: policy.maxTokens,
    timeoutMs: policy.timeoutMs,
    jsonMode: policy.jsonMode,
    temperature: policy.temperature,
    retries: policy.retries,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function resolveValidatedConfigsPath(): string {
  const localCandidate = resolve(__dirname, 'validated-configs.json');
  if (existsSync(localCandidate)) return localCandidate;
  return resolve(
    process.cwd(),
    'src/services/capture/application/work-note-agent/validated-configs.json',
  );
}

export function loadValidatedConfigRegistry(
  customPath?: string,
): ValidatedConfigRegistry {
  const target = customPath ?? resolveValidatedConfigsPath();
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as {
    schemaVersion?: unknown;
    entries?: unknown;
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('VALIDATED_CONFIG_REGISTRY_INVALID_SCHEMA');
  }
  return parsed as unknown as ValidatedConfigRegistry;
}

export function evaluateValidatedConfig(
  active: ActiveSurfaceConfig,
  registry: ValidatedConfigRegistry,
  options?: { requireValidatedBaseline?: boolean },
): ValidatedConfigDecision {
  const providerPolicyHash = hashProviderPolicy(active.providerPolicy);
  const surfaceEntries = registry.entries.filter(
    (entry) => entry.surface === active.surface,
  );

  if (surfaceEntries.length === 0) {
    if (options?.requireValidatedBaseline) {
      return {
        allowed: false,
        validatedConfig: false,
        reason: 'UNVALIDATED_CONFIG_BLOCKED',
        providerPolicyHash,
        mismatchedFields: ['baseline'],
      };
    }
    return {
      allowed: true,
      validatedConfig: false,
      reason: 'NO_PASS_BASELINE_WARN_ONLY',
      providerPolicyHash,
    };
  }

  for (const entry of surfaceEntries) {
    const entryPolicyHash =
      entry.providerPolicyHash || hashProviderPolicy(entry.providerPolicy);
    if (
      entry.promptVersion === active.promptVersion &&
      entry.model === active.model &&
      entry.architecture === active.architecture &&
      entryPolicyHash === providerPolicyHash
    ) {
      return {
        allowed: true,
        validatedConfig: true,
        reason: 'MATCHED_VALIDATED_CONFIG',
        providerPolicyHash,
        matchedGateRunId: entry.gateRunId,
      };
    }
  }

  // Compute mismatched fields relative to the latest PASS entry on this surface for clear operator diagnostics
  const latest = surfaceEntries[surfaceEntries.length - 1];
  const latestPolicyHash =
    latest.providerPolicyHash || hashProviderPolicy(latest.providerPolicy);
  const mismatchedFields: (
    'promptVersion' | 'model' | 'architecture' | 'providerPolicyHash'
  )[] = [];
  if (latest.promptVersion !== active.promptVersion) {
    mismatchedFields.push('promptVersion');
  }
  if (latest.model !== active.model) {
    mismatchedFields.push('model');
  }
  if (latest.architecture !== active.architecture) {
    mismatchedFields.push('architecture');
  }
  if (latestPolicyHash !== providerPolicyHash) {
    mismatchedFields.push('providerPolicyHash');
  }

  return {
    allowed: false,
    validatedConfig: false,
    reason: 'UNVALIDATED_CONFIG_BLOCKED',
    providerPolicyHash,
    mismatchedFields,
  };
}
