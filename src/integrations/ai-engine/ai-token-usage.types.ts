export const AI_TOKEN_USAGE_TASK_KINDS = [
  'ai_chat',
  'mind_map',
  'knowledge_sync',
  'note_assessment',
  'note_rewrite',
] as const;

export type AiTokenUsageTaskKind = (typeof AI_TOKEN_USAGE_TASK_KINDS)[number];

export const AI_TOKEN_USAGE_SCOPES = [
  'personal',
  'project',
  'organization',
] as const;

export type AiTokenUsageScope = (typeof AI_TOKEN_USAGE_SCOPES)[number];

export type AiTokenUsageOwnerKind = 'project' | 'member';

export interface AiTokenUsageOwnerDto {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
  readonly subtitle?: string;
  readonly avatarUrl?: string | null;
  readonly kind: AiTokenUsageOwnerKind;
}

export interface AiTokenUsageTaskMetaDto {
  readonly id: AiTokenUsageTaskKind;
  readonly index: number;
}

/**
 * Compact hourly usage tuple (matches DeepSeek Harness ledger format, strictly token-only):
 * [hourEpoch, ownerIndex, taskIndex, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, calls]
 */
export type AiTokenUsageBucketRow = readonly [
  hourEpoch: number,
  ownerIndex: number,
  taskIndex: number,
  inputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  outputTokens: number,
  calls: number,
];

export interface AiTokenUsageProjectOptionDto {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly isLeader: boolean;
}

export interface AiTokenUsageResponseDto {
  readonly effectiveScope: AiTokenUsageScope;
  readonly availableScopes: readonly AiTokenUsageScope[];
  readonly ownerGroupKind: AiTokenUsageOwnerKind;
  readonly selectedProjectId: string | null;
  readonly actor: {
    readonly id: string;
    readonly name: string;
    readonly role: 'ADMIN' | 'TEAM_LEADER' | 'MEMBER';
  };
  readonly projects: readonly AiTokenUsageProjectOptionDto[];
  readonly owners: readonly AiTokenUsageOwnerDto[];
  readonly tasks: readonly AiTokenUsageTaskMetaDto[];
  readonly rows: readonly AiTokenUsageBucketRow[];
  readonly generatedAt: string;
}

export interface RecordAiTokenUsageEventInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly taskKind: AiTokenUsageTaskKind;
  readonly inputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens: number;
  readonly calls?: number;
  readonly dedupeKey?: string;
  readonly occurredAt?: Date;
}
