export const PLATFORM_AI_OPERATIONS_REPOSITORY = Symbol(
  'PLATFORM_AI_OPERATIONS_REPOSITORY',
);

export type PlatformAiServiceState = 'READY' | 'DEGRADED' | 'UNAVAILABLE';
export type PlatformAiDependencyState = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type PlatformAiRuntimeState = 'READY' | 'UNAVAILABLE' | 'UNKNOWN';
export type PlatformAiModelProviderState =
  'CONFIGURED' | 'UNCONFIGURED' | 'UNKNOWN' | 'NOT_EXPOSED';
export type PlatformAiProcessingJobsState =
  'ACTIVE' | 'IDLE' | 'UNKNOWN' | 'NOT_EXPOSED';
export type PlatformAiFailedProcessingState =
  'NONE' | 'HAS_FAILURES' | 'UNKNOWN' | 'NOT_EXPOSED';

export interface PlatformAiRuntimeProfile {
  llmConfigured: boolean;
  llmProvider: string | null;
  llmModel: string | null;
  retrievalModel: string | null;
  vectorStore: string | null;
  parserProvider: string | null;
  workerConcurrency: number;
}

export interface PlatformAiJobSummary {
  queued: number;
  running: number;
  paused: number;
  succeeded: number;
  failed: number;
}

export interface PlatformAiCorpusSummary {
  ready: number;
  processing: number;
  paused: number;
  failed: number;
}

export interface PlatformAiOperationsSummary {
  id: 'sag';
  name: 'SAG';
  status: PlatformAiServiceState;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  liveness: 'ALIVE' | 'UNAVAILABLE';
  readiness: 'READY' | 'UNAVAILABLE';
  dependencies: {
    database: PlatformAiDependencyState;
    knowledgeRuntime: PlatformAiRuntimeState;
    retrieval: PlatformAiRuntimeState;
    modelProvider: PlatformAiModelProviderState;
    processingJobs: PlatformAiProcessingJobsState;
    failedProcessingSummary: PlatformAiFailedProcessingState;
  };
  runtimeProfile: PlatformAiRuntimeProfile | null;
  jobSummary: PlatformAiJobSummary | null;
  corpusSummary: PlatformAiCorpusSummary | null;
  lastCheckedAt: string;
  diagnosticsSummary: string;
}

export interface PlatformAiOperationsRepository {
  getStatus(): Promise<PlatformAiOperationsSummary>;
}
