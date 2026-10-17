export const PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY = Symbol(
  'PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY',
);

export interface PlatformIntegrationTestInput {
  actorUserId: string;
  integrationId: string;
  idempotencyKey: string;
  correlationId?: string;
}

export interface PlatformIntegrationReconnectInput extends PlatformIntegrationTestInput {
  expectedUpdatedAt: Date;
}

export interface PlatformIntegrationTestResult {
  integrationId: string;
  status: 'CONNECTED' | 'FAILED';
  testedAt: string;
  failureSummary: string | null;
}

export interface PlatformIntegrationReconnectResult {
  integrationId: string;
  status: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  updatedAt: string;
}

export interface PlatformIntegrationOperationsRepository {
  testConnection(
    input: PlatformIntegrationTestInput,
  ): Promise<PlatformIntegrationTestResult>;
  reconnect(
    input: PlatformIntegrationReconnectInput,
  ): Promise<PlatformIntegrationReconnectResult>;
}
