import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  JiraIntegrationReconnectInput,
  JiraIntegrationReconnectResult,
  JiraIntegrationTestInput,
  JiraIntegrationTestResult,
  JiraPlatformIntegrationOperationsProvider,
} from '../application/platform-integration-operations.repository';

@Injectable()
export class UnavailableJiraPlatformIntegrationOperationsProvider implements JiraPlatformIntegrationOperationsProvider {
  testConnection(
    input: JiraIntegrationTestInput,
  ): Promise<JiraIntegrationTestResult> {
    void input;
    return Promise.reject(this.unavailable());
  }

  reconnect(
    input: JiraIntegrationReconnectInput,
  ): Promise<JiraIntegrationReconnectResult> {
    void input;
    return Promise.reject(this.unavailable());
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE',
    });
  }
}
