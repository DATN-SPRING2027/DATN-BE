import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER,
  type JiraIntegrationReconnectInput,
  type JiraIntegrationReconnectResult,
  type JiraIntegrationTestInput,
  type JiraIntegrationTestResult,
  type JiraPlatformIntegrationOperationsProvider,
} from './platform-integration-operations.repository';

const objectIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;
const correlationPattern = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class PlatformIntegrationOperationsService {
  constructor(
    @Inject(JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER)
    private readonly provider: JiraPlatformIntegrationOperationsProvider,
  ) {}

  async testConnection(
    input: JiraIntegrationTestInput,
  ): Promise<JiraIntegrationTestResult> {
    this.validateInput(input);
    try {
      return await this.provider.testConnection(input);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
  }

  async reconnect(
    input: JiraIntegrationReconnectInput,
  ): Promise<JiraIntegrationReconnectResult> {
    this.validateInput(input);
    const timestamp = new Date(input.expectedUpdatedAt);
    if (
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.toISOString() !== input.expectedUpdatedAt
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.provider.reconnect(input);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
  }

  private validateInput(input: JiraIntegrationTestInput): void {
    if (
      !input ||
      !objectIdPattern.test(input.integrationId) ||
      !objectIdPattern.test(input.actorUserId) ||
      !idempotencyPattern.test(input.idempotencyKey) ||
      (input.correlationId !== undefined &&
        !correlationPattern.test(input.correlationId))
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'JIRA_INTEGRATION_PROVIDER_UNAVAILABLE',
    });
  }
}
