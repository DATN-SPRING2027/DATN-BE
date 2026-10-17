export const PLATFORM_SERVICE_OPERATIONS_REPOSITORY = Symbol(
  'PLATFORM_SERVICE_OPERATIONS_REPOSITORY',
);

export const PLATFORM_SERVICE_IDS = [
  'iam',
  'capture',
  'jira',
  'lifecycle',
  'chat',
  'handover',
  'ingestion',
  'notification',
] as const;

export type PlatformServiceId = (typeof PLATFORM_SERVICE_IDS)[number];
export type PlatformServiceState = 'READY' | 'DEGRADED' | 'UNAVAILABLE';
export type PlatformDependencyState = 'AVAILABLE' | 'UNAVAILABLE';

export interface PlatformServiceOperationsSummary {
  id: PlatformServiceId;
  name: string;
  status: PlatformServiceState;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  liveness: 'ALIVE' | 'UNAVAILABLE';
  readiness: PlatformServiceState;
  dependencies: {
    mongodb: PlatformDependencyState;
    redis: PlatformDependencyState;
  };
  lastCheckedAt: string;
  diagnosticsSummary: string;
}

export interface PlatformServiceOperationsRepository {
  listServices(): Promise<{ data: PlatformServiceOperationsSummary[] }>;
  findService(
    id: PlatformServiceId,
  ): Promise<PlatformServiceOperationsSummary | null>;
}
