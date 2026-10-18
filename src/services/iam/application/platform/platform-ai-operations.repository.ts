export const PLATFORM_AI_OPERATIONS_REPOSITORY = Symbol(
  'PLATFORM_AI_OPERATIONS_REPOSITORY',
);

export type PlatformAiServiceState = 'READY' | 'DEGRADED' | 'UNAVAILABLE';
export type PlatformAiDependencyState = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
export type PlatformAiRuntimeState = 'READY' | 'UNAVAILABLE' | 'UNKNOWN';

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
    modelProvider: 'NOT_EXPOSED';
    processingJobs: 'NOT_EXPOSED';
    failedProcessingSummary: 'NOT_EXPOSED';
  };
  lastCheckedAt: string;
  diagnosticsSummary: string;
}

export interface PlatformAiOperationsRepository {
  getStatus(): Promise<PlatformAiOperationsSummary>;
}
