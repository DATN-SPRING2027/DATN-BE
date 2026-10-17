import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  PLATFORM_SERVICE_IDS,
  PLATFORM_SERVICE_OPERATIONS_REPOSITORY,
  type PlatformServiceId,
  type PlatformServiceOperationsRepository,
} from './platform-service-operations.repository';

@Injectable()
export class PlatformServiceOperationsService {
  constructor(
    @Inject(PLATFORM_SERVICE_OPERATIONS_REPOSITORY)
    private readonly repository: PlatformServiceOperationsRepository,
  ) {}

  listServices() {
    return this.repository.listServices();
  }

  async findService(id: string) {
    if (!(PLATFORM_SERVICE_IDS as readonly string[]).includes(id)) {
      throw new NotFoundException({ code: 'PLATFORM_SERVICE_NOT_FOUND' });
    }
    const service = await this.repository.findService(id as PlatformServiceId);
    if (!service) {
      throw new NotFoundException({ code: 'PLATFORM_SERVICE_NOT_FOUND' });
    }
    return service;
  }
}
