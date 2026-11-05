import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  prepareAgentRequest,
  type AgentInput,
  type AgentResult,
} from '../../application/work-note-agent/work-note-agent';
import { PROMPT_VERSION } from '../../application/work-note-agent/work-note-agent.prompt';
import { parseRewriteCompletion } from '../../application/work-note-agent/work-note-agent.completion';
import {
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  prepareAssessmentEditorRequest,
} from '../../application/work-note-agent/work-note-assessment-editor';
import { ASSESSMENT_PROMPT_VERSION } from '../../application/work-note-agent/work-note-assessment.protocol';
import { SPLIT_ASSESSMENT_PROMPT_VERSION } from '../../application/work-note-agent/work-note-assessment-split';
import {
  executeAssessmentModelCall,
  type AssessmentArchitecture,
} from '../../application/work-note-agent/work-note-assessment.pipeline';
import type { AssessmentModelInput } from '../../application/work-note-agent/work-note-assessment.types';
import {
  evaluateValidatedConfig,
  loadValidatedConfigRegistry,
  type ActiveSurfaceConfig,
  type ValidatedConfigRegistry,
} from '../../application/work-note-agent/validated-config.guard';
import {
  WorkNoteLlmSecurityGateway,
  rewriteTargetPlaceholders,
} from '../../application/work-note-agent/security/llm-security-gateway';
import { securityPolicyFromConfig } from '../../application/work-note-agent/security/sensitive-data.masker';
import type { SecurityReport } from '../../application/work-note-agent/security/security.types';
import { WorkNoteXkiroClient } from './work-note-xkiro.client';

export type RewriteProvenance = {
  provider: string;
  model: string;
  promptVersion: string;
  formattingRecovery: readonly string[];
  promptTokens: number | null;
  completionTokens: number | null;
  httpAttempts: number;
  durationMs: number;
  validatedConfig?: boolean;
  /** Safe summary only (no values). Optional so test doubles stay compatible. */
  security?: SecurityReport;
};

const WARN_RATE_LIMIT_MS = 5 * 60 * 1000;

@Injectable()
export class WorkNoteAgentModel implements OnModuleInit {
  private readonly logger = new Logger(WorkNoteAgentModel.name);
  private registryOverride: ValidatedConfigRegistry | null = null;
  private readonly lastWarnAtByKey = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  setValidatedConfigRegistryOverride(
    registry: ValidatedConfigRegistry | null,
  ): void {
    this.registryOverride = registry;
    this.lastWarnAtByKey.clear();
  }

  private getRegistry(): ValidatedConfigRegistry {
    return this.registryOverride ?? loadValidatedConfigRegistry();
  }

  private requiresValidatedBaseline(): boolean {
    const required = this.config.get<boolean | string>(
      'WORKNOTE_AGENT_REQUIRE_VALIDATED_CONFIG',
    );
    return (
      this.config.get<string>('NODE_ENV') === 'production' ||
      required === true ||
      required === 'true'
    );
  }

  onModuleInit(): void {
    const enabled = this.config.get<boolean | string>('WORKNOTE_AGENT_ENABLED');
    const model = this.config.get<string>('XKIRO_MODEL') ?? '';
    if ((enabled !== true && enabled !== 'true') || !model) return;

    const arch = this.getAssessmentArchitecture();
    const startupSurfaces: ActiveSurfaceConfig[] = [
      {
        surface: 'assessment',
        promptVersion:
          arch === 'split'
            ? SPLIT_ASSESSMENT_PROMPT_VERSION
            : ASSESSMENT_PROMPT_VERSION,
        model,
        architecture: arch,
        providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      },
      {
        surface: 'rewrite',
        promptVersion: PROMPT_VERSION,
        model,
        architecture: 'single',
        providerPolicy: { ...ASSESSMENT_EDITOR_PROVIDER_POLICY, retries: 1 },
      },
      {
        surface: 'assessment-editor',
        promptVersion: ASSESSMENT_EDITOR_INSTRUCTION_VERSION,
        model,
        architecture: 'single',
        providerPolicy: ASSESSMENT_EDITOR_PROVIDER_POLICY,
      },
    ];

    const registry = this.getRegistry();
    for (const active of startupSurfaces) {
      const decision = evaluateValidatedConfig(active, registry, {
        requireValidatedBaseline: this.requiresValidatedBaseline(),
      });
      if (decision.reason === 'NO_PASS_BASELINE_WARN_ONLY') {
        this.logger.warn(
          `[VALIDATED_CONFIG_WARN_STARTUP] surface=${active.surface} promptVersion=${active.promptVersion} model=${active.model} architecture=${active.architecture} has no PASS baseline in validated-configs.json; running with validatedConfig=false.`,
        );
      } else if (!decision.allowed) {
        this.logger.error(
          `[VALIDATED_CONFIG_MISMATCH_STARTUP] surface=${active.surface} mismatched=[${decision.mismatchedFields.join(',')}] promptVersion=${active.promptVersion} model=${active.model} architecture=${active.architecture}; surface will reject requests with WORKNOTE_AGENT_UNAVAILABLE.`,
        );
      }
    }
  }

  private enforceValidatedConfig(active: ActiveSurfaceConfig): boolean {
    const decision = evaluateValidatedConfig(active, this.getRegistry(), {
      requireValidatedBaseline: this.requiresValidatedBaseline(),
    });
    if (!decision.allowed) {
      this.logger.error(
        `[VALIDATED_CONFIG_BLOCKED] surface=${active.surface} mismatched=[${decision.mismatchedFields.join(',')}] promptVersion=${active.promptVersion} model=${active.model} architecture=${active.architecture} policyHash=${decision.providerPolicyHash}`,
      );
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    }
    if (!decision.validatedConfig) {
      const rateKey = `${active.surface}|${active.promptVersion}|${active.model}|${active.architecture}`;
      const now = Date.now();
      const prev = this.lastWarnAtByKey.get(rateKey) ?? 0;
      if (now - prev >= WARN_RATE_LIMIT_MS) {
        this.lastWarnAtByKey.set(rateKey, now);
        this.logger.warn(
          `[VALIDATED_CONFIG_WARN] surface=${active.surface} promptVersion=${active.promptVersion} model=${active.model} architecture=${active.architecture} running without PASS baseline (validatedConfig=false).`,
        );
      }
    }
    return decision.validatedConfig;
  }

  getAssessmentArchitecture(): AssessmentArchitecture {
    return this.config.get<string>('WORKNOTE_ASSESSMENT_ARCHITECTURE') ===
      'split'
      ? 'split'
      : 'combined';
  }

  /** Every LLM-bound request must pass through this gateway. */
  securityGateway(): WorkNoteLlmSecurityGateway {
    return new WorkNoteLlmSecurityGateway(
      securityPolicyFromConfig(this.config),
    );
  }

  /**
   * Cheap pre-flight (no network): rejects BLOCK-level data, selections that cut
   * through a masked value, and unvalidated configs (once a PASS baseline exists)
   * before quota or an inference lease is consumed.
   */
  precheck(input: AgentInput, mode: 'editor' | 'assessment' = 'editor'): void {
    const masked = this.securityGateway().maskAgentInput(input);
    const prepared =
      mode === 'assessment'
        ? prepareAssessmentEditorRequest(masked.input)
        : prepareAgentRequest(masked.input);
    const enabled = this.config.get<string | boolean>('WORKNOTE_AGENT_ENABLED');
    const model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled === true || enabled === 'true') && model) {
      this.enforceValidatedConfig({
        surface: mode === 'assessment' ? 'assessment-editor' : 'rewrite',
        promptVersion: prepared.promptVersion,
        model,
        architecture: 'single',
        providerPolicy: {
          ...ASSESSMENT_EDITOR_PROVIDER_POLICY,
          retries: mode === 'assessment' ? 0 : 1,
        },
      });
    }
  }

  precheckAssessment(): void {
    const enabled = this.config.get<boolean | string>('WORKNOTE_AGENT_ENABLED');
    const model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled === true || enabled === 'true') && model) {
      const arch = this.getAssessmentArchitecture();
      this.enforceValidatedConfig({
        surface: 'assessment',
        promptVersion:
          arch === 'split'
            ? SPLIT_ASSESSMENT_PROMPT_VERSION
            : ASSESSMENT_PROMPT_VERSION,
        model,
        architecture: arch,
        providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
      });
    }
  }

  async assess(input: AssessmentModelInput) {
    const enabled = this.config.get<boolean | string>('WORKNOTE_AGENT_ENABLED');
    const apiKey = this.config.get<string>('XKIRO_API_KEY'),
      model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled !== true && enabled !== 'true') || !apiKey || !model)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    const architecture = this.getAssessmentArchitecture();
    const validatedConfig = this.enforceValidatedConfig({
      surface: 'assessment',
      promptVersion:
        architecture === 'split'
          ? SPLIT_ASSESSMENT_PROMPT_VERSION
          : ASSESSMENT_PROMPT_VERSION,
      model,
      architecture,
      providerPolicy: ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
    });
    const client = new WorkNoteXkiroClient({
      apiKey,
      model,
      ...ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
    });
    const recovery = this.config.get<boolean | string>(
      'WORKNOTE_AGENT_FORMATTING_RECOVERY',
    );
    const gateway = this.securityGateway();
    const security: SecurityReport[] = [];
    const executed = await executeAssessmentModelCall({
      input,
      architecture,
      formattingRecovery: recovery === true || recovery === 'true',
      modelName: model,
      complete: async (messages) => {
        const guarded = gateway.protectRequest(messages);
        const completion = await client.complete(
          guarded.messages,
          `assessment-${randomUUID()}`,
        );
        // Assessment text is never unmasked; it only references masked sources.
        const checked = gateway.validateOutput(
          completion.content,
          guarded,
          'analysis',
        );
        security.push(gateway.report(guarded, checked));
        return { ...completion, content: checked.content };
      },
    });
    const provenance: typeof executed.provenance & {
      validatedConfig: boolean;
      security?: readonly SecurityReport[];
    } = { ...executed.provenance, validatedConfig, security };
    return { result: executed.result, provenance };
  }

  async rewrite(
    input: AgentInput,
    mode: 'editor' | 'assessment' = 'editor',
  ): Promise<{ result: AgentResult; provenance: RewriteProvenance }> {
    const enabled = this.config.get<string | boolean>('WORKNOTE_AGENT_ENABLED');
    const key = this.config.get<string>('XKIRO_API_KEY'),
      model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled !== true && enabled !== 'true') || !key || !model)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    const gateway = this.securityGateway();
    // 1) Mask BEFORE prompt construction (literal protection cannot split secrets).
    const masked = gateway.maskAgentInput(input);
    const prepared =
      mode === 'assessment'
        ? prepareAssessmentEditorRequest(masked.input)
        : prepareAgentRequest(masked.input);
    const retries = mode === 'assessment' ? 0 : 1;
    const validatedConfig = this.enforceValidatedConfig({
      surface: mode === 'assessment' ? 'assessment-editor' : 'rewrite',
      promptVersion: prepared.promptVersion,
      model,
      architecture: 'single',
      providerPolicy: { ...ASSESSMENT_EDITOR_PROVIDER_POLICY, retries },
    });
    // 2) Residual scan of the final messages + trust context for output checks.
    const guarded = gateway.protectRequest(prepared.messages, {
      vault: masked.vault,
      rawCorpus: masked.rawCorpus,
      priorFindings: masked.findings,
    });
    const completion = await new WorkNoteXkiroClient({
      apiKey: key,
      model,
      ...ASSESSMENT_EDITOR_PROVIDER_POLICY,
      retries,
    }).complete(guarded.messages, `worknote-${randomUUID()}`);
    // 3) Output Security Validation before parsing.
    const checked = gateway.validateOutput(
      completion.content,
      guarded,
      'rewrite',
      rewriteTargetPlaceholders(guarded.messages),
    );
    const recoveryEnabled = this.config.get<string | boolean>(
      'WORKNOTE_AGENT_FORMATTING_RECOVERY',
    );
    const parsed = parseRewriteCompletion(
      prepared,
      checked.content,
      recoveryEnabled === true || recoveryEnabled === 'true',
    );
    // 4) Only after validation PASS/SANITIZED: reveal values server-side in applied
    //    text and bind the suggestion to the raw draft.
    const { result, unmasked } = gateway.finalizeRewrite(
      parsed.result,
      input,
      guarded,
    );
    return {
      result,
      provenance: {
        provider: 'xkiro',
        model,
        promptVersion: prepared.promptVersion,
        formattingRecovery: parsed.formattingRecovery,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        httpAttempts: completion.attempts,
        durationMs: completion.elapsedMs,
        validatedConfig,
        security: gateway.report(guarded, checked, unmasked),
      },
    };
  }
}
