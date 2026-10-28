import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  parseAgentResult,
  prepareAgentRequest,
  type AgentInput,
  type AgentResult,
} from '../../application/work-note-agent/work-note-agent';
import { recoverEmptyContainers } from '../../application/work-note-agent/work-note-agent.formatting';
import { WorkNoteXkiroClient } from './work-note-xkiro.client';
import {
  buildAssessmentMessages,
  parseAssessmentOutput,
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
      maxTokens: 8192,
      timeoutMs: 30000,
      jsonMode: true,
      temperature: 0.1,
      retries: 0,
    }).complete(messages, `assessment-${randomUUID()}`);
    return {
      result: parseAssessmentOutput(input, completion.content),
      provenance: {
        model,
        promptVersion: ASSESSMENT_PROMPT_VERSION,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
        httpAttempts: completion.attempts,
        durationMs: completion.elapsedMs,
      },
    };
  }
  async rewrite(input: AgentInput) {
    const enabled = this.config.get<string | boolean>('WORKNOTE_AGENT_ENABLED');
    const key = this.config.get<string>('XKIRO_API_KEY'),
      model = this.config.get<string>('XKIRO_MODEL');
    if ((enabled !== true && enabled !== 'true') || !key || !model)
      throw new ServiceUnavailableException({
        code: 'WORKNOTE_AGENT_UNAVAILABLE',
        message: 'Agent is unavailable. You can still save your note.',
      });
    const prepared = prepareAgentRequest(input);
    const completion = await new WorkNoteXkiroClient({
      apiKey: key,
      model,
      maxTokens: 4096,
      timeoutMs: 30000,
      jsonMode: true,
      temperature: 0.1,
      retries: 1,
    }).complete(prepared.messages, `worknote-${randomUUID()}`);
    let result: AgentResult;
    let formattingRecovery: readonly string[] = [];
    try {
      result = parseAgentResult(prepared, completion.content);
    } catch (error) {
      const recoveryEnabled = this.config.get<string | boolean>(
        'WORKNOTE_AGENT_FORMATTING_RECOVERY',
      );
      const recovery =
        recoveryEnabled === true || recoveryEnabled === 'true'
          ? recoverEmptyContainers(completion.content)
          : null;
      if (!recovery) throw error;
      result = parseAgentResult(prepared, recovery.json);
      formattingRecovery = recovery.addedFields;
    }
    return {
      result,
      provenance: {
        provider: 'xkiro',
        model,
        promptVersion: prepared.promptVersion,
        formattingRecovery,
        promptTokens: completion.promptTokens,
        completionTokens: completion.completionTokens,
      },
    };
  }
}
