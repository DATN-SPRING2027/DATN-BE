export const JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER = Symbol(
  'JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER',
);

export interface JiraIntegrationTestInput {
  integrationId: string;
  actorUserId: string;
  idempotencyKey: string;
  correlationId?: string;
}

export interface JiraIntegrationReconnectInput extends JiraIntegrationTestInput {
  expectedUpdatedAt: string;
}

export interface JiraIntegrationTestResult {
  integrationId: string;
  status: 'CONNECTED' | 'FAILED';
  testedAt: string;
  failureSummary: string | null;
}

export interface JiraIntegrationReconnectResult {
  integrationId: string;
  status: 'CONNECTED' | 'EXPIRED' | 'REVOKED';
  updatedAt: string;
}

export interface JiraPlatformIntegrationOperationsProvider {
  testConnection(
    input: JiraIntegrationTestInput,
  ): Promise<JiraIntegrationTestResult>;
  reconnect(
    input: JiraIntegrationReconnectInput,
  ): Promise<JiraIntegrationReconnectResult>;
}
