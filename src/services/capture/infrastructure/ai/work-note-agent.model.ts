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
import {
  executeAssessmentModelCall,
  type AssessmentArchitecture,
} from '../../application/work-note-agent/work-note-assessment.pipeline';
import type { AssessmentModelInput } from '../../application/work-note-agent/work-note-assessment.types';
import { WorkNoteXkiroClient } from './work-note-xkiro.client';

@Injectable()
export class WorkNoteAgentModel {
  constructor(private readonly config: ConfigService) {}

  getAssessmentArchitecture(): AssessmentArchitecture {
    return this.config.get<string>('WORKNOTE_ASSESSMENT_ARCHITECTURE') ===
      'split'
      ? 'split'
      : 'combined';
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
    const executed = await executeAssessmentModelCall({
      input,
      architecture: this.getAssessmentArchitecture(),
      formattingRecovery: recovery === true || recovery === 'true',
      modelName: model,
      complete: (messages) =>
        client.complete(messages, `assessment-${randomUUID()}`),
    });
    return {
      result: executed.result,
      provenance: executed.provenance,
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
