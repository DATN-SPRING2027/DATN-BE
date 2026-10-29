import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  prepareAgentRequest,
  type AgentInput,
} from '../../application/work-note-agent/work-note-agent';
import { parseRewriteCompletion } from '../../application/work-note-agent/work-note-agent.completion';
import {
  ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
  ASSESSMENT_EDITOR_PROVIDER_POLICY,
  prepareAssessmentEditorRequest,
} from '../../application/work-note-agent/work-note-assessment-editor';
import { WorkNoteXkiroClient } from './work-note-xkiro.client';
import {
  buildAssessmentMessages,
  parseAssessmentCompletion,
  ASSESSMENT_PROMPT_VERSION,
} from '../../application/work-note-agent/work-note-assessment.protocol';
import type { AssessmentModelInput } from '../../application/work-note-agent/work-note-assessment.types';

@Injectable()
export class WorkNoteAgentModel {
  constructor(private readonly config: ConfigService) {}
  async assess(input: AssessmentModelInput) {
    const enabled = this.config.get<boolean | string>('WORKNOTE_AGENT_ENABLED');
    const apiKey = this.config.get<string>('XKIRO_API_KEY'),
      model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled !== true && enabled !== 'true') || !apiKey || !model)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    const messages = buildAssessmentMessages(input);
    const completion = await new WorkNoteXkiroClient({
      apiKey,
      model,
      ...ASSESSMENT_ANALYSIS_PROVIDER_POLICY,
    }).complete(messages, `assessment-${randomUUID()}`);
    const recovery = this.config.get<boolean | string>(
      'WORKNOTE_AGENT_FORMATTING_RECOVERY',
    );
    const parsed = parseAssessmentCompletion(
      input,
      completion.content,
      recovery === true || recovery === 'true',
    );
    return {
      result: parsed.result,
      provenance: {
        model,
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        formattingRecovery: parsed.formattingRecovery,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        httpAttempts: completion.attempts,
        durationMs: completion.elapsedMs,
      },
    };
  }
  async rewrite(input: AgentInput, mode: 'editor' | 'assessment' = 'editor') {
    const enabled = this.config.get<string | boolean>('WORKNOTE_AGENT_ENABLED');
    const key = this.config.get<string>('XKIRO_API_KEY'),
      model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled !== true && enabled !== 'true') || !key || !model)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    const prepared =
      mode === 'assessment'
        ? prepareAssessmentEditorRequest(input)
        : prepareAgentRequest(input);
    const completion = await new WorkNoteXkiroClient({
      apiKey: key,
      model,
      ...ASSESSMENT_EDITOR_PROVIDER_POLICY,
      retries: mode === 'assessment' ? 0 : 1,
    }).complete(prepared.messages, `worknote-${randomUUID()}`);
    const recoveryEnabled = this.config.get<string | boolean>(
      'WORKNOTE_AGENT_FORMATTING_RECOVERY',
    );
    const { result, formattingRecovery } = parseRewriteCompletion(
      prepared,
      completion.content,
      recoveryEnabled === true || recoveryEnabled === 'true',
    );
    return {
      result,
      provenance: {
        provider: 'xkiro',
        model,
        promptVersion: prepared.promptVersion,
        formattingRecovery,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        httpAttempts: completion.attempts,
        durationMs: completion.elapsedMs,
      },
    };
  }
}
