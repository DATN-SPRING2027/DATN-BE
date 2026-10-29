import {
  parseAgentResult,
  type AgentResult,
  type prepareAgentRequest,
} from './work-note-agent';
import { recoverEmptyContainers } from './work-note-agent.formatting';

/** Shared compatibility handling; never changes text, status or factual content. */
export function parseRewriteCompletion(
  prepared: ReturnType<typeof prepareAgentRequest>,
  raw: string,
  recoveryEnabled: boolean,
): { result: AgentResult; formattingRecovery: readonly string[] } {
  try {
    return { result: parseAgentResult(prepared, raw), formattingRecovery: [] };
  } catch (error) {
    const recovery = recoveryEnabled ? recoverEmptyContainers(raw) : null;
    if (!recovery) throw error;
    return {
      result: parseAgentResult(prepared, recovery.json),
      formattingRecovery: recovery.addedFields,
    };
  }
}
