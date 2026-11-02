import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  prepareAgentRequest,
  type AgentInput,
  type AgentResult,
} from '../../application/work-note-agent/work-note-agent';
import { parseRewriteCompletion } from '../../application/work-note-agent/work-note-agent.completion';
import {
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  prepareAssessmentEditorRequest,
} from '../../application/work-note-agent/work-note-assessment-editor';
import {
  executeAssessmentModelCall,
  type AssessmentArchitecture,
} from '../../application/work-note-agent/work-note-assessment.pipeline';
import type { AssessmentModelInput } from '../../application/work-note-agent/work-note-assessment.types';
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
  /** Safe summary only (no values). Optional so test doubles stay compatible. */
  security?: SecurityReport;
};

@Injectable()
export class WorkNoteAgentModel {
  constructor(private readonly config: ConfigService) {}

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
   * Cheap pre-flight (no network): rejects BLOCK-level data (and selections that cut
   * through a masked value) before quota or an inference lease is consumed.
   */
  precheck(input: AgentInput, mode: 'editor' | 'assessment' = 'editor'): void {
    const masked = this.securityGateway().maskAgentInput(input);
    if (mode === 'assessment') prepareAssessmentEditorRequest(masked.input);
    else prepareAgentRequest(masked.input);
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
      architecture: this.getAssessmentArchitecture(),
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
      security?: readonly SecurityReport[];
    } = { ...executed.provenance, security };
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
      retries: mode === 'assessment' ? 0 : 1,
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
        security: gateway.report(guarded, checked, unmasked),
      },
    };
  }
}
