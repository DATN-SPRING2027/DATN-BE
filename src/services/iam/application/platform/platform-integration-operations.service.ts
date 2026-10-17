import {
  HttpException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY,
  type PlatformIntegrationOperationsRepository,
  type PlatformIntegrationReconnectInput,
  type PlatformIntegrationReconnectResult,
  type PlatformIntegrationTestInput,
  type PlatformIntegrationTestResult,
} from './platform-integration-operations.repository';

const objectIdPattern = /^[a-f\d]{24}$/i;
const idempotencyPattern = /^[A-Za-z0-9._:-]{16,128}$/;

@Injectable()
export class PlatformIntegrationOperationsService {
  constructor(
    @Inject(PLATFORM_INTEGRATION_OPERATIONS_REPOSITORY)
    private readonly repository: PlatformIntegrationOperationsRepository,
  ) {}

  async testConnection(
    input: PlatformIntegrationTestInput,
  ): Promise<PlatformIntegrationTestResult> {
    this.validate(input);
    try {
      return await this.repository.testConnection(input);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
  }

  async reconnect(
    input: PlatformIntegrationReconnectInput,
  ): Promise<PlatformIntegrationReconnectResult> {
    this.validate(input);
    if (
      !(input.expectedUpdatedAt instanceof Date) ||
      !Number.isFinite(input.expectedUpdatedAt.getTime())
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    try {
      return await this.repository.reconnect(input);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw this.unavailable();
    }
  }

  private validate(input: PlatformIntegrationTestInput): void {
    if (
      !input ||
      !objectIdPattern.test(input.actorUserId) ||
      !objectIdPattern.test(input.integrationId) ||
      !idempotencyPattern.test(input.idempotencyKey) ||
      (input.correlationId !== undefined &&
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.correlationId))
    )
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'PLATFORM_INTEGRATION_OPERATION_UNAVAILABLE',
    });
  }
}
