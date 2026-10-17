import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PLATFORM_INTEGRATION_READ_REPOSITORY,
  type JiraConnectionStatus,
  type PlatformIntegrationListInput,
  type PlatformIntegrationReadRepository,
} from './platform-integration-read.repository';

const idPattern = /^[a-f\d]{24}$/i;
const statuses: readonly JiraConnectionStatus[] = [
  'CONNECTED',
  'EXPIRED',
  'REVOKED',
];

@Injectable()
export class PlatformIntegrationReadService {
  constructor(
    @Inject(PLATFORM_INTEGRATION_READ_REPOSITORY)
    private readonly repository: PlatformIntegrationReadRepository,
  ) {}

  list(input: PlatformIntegrationListInput) {
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100 ||
      (input.organizationId !== undefined &&
        !idPattern.test(input.organizationId)) ||
      (input.projectId !== undefined && !idPattern.test(input.projectId)) ||
      (input.status !== undefined && !statuses.includes(input.status))
    ) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    }
    return this.repository.list(input);
  }

  async findById(id: string) {
    if (!idPattern.test(id)) {
      throw new UnprocessableEntityException({ code: 'VALIDATION_FAILED' });
    }
    const integration = await this.repository.findById(id);
    if (!integration) {
      throw new NotFoundException({ code: 'INTEGRATION_NOT_FOUND' });
    }
    return integration;
  }
}
