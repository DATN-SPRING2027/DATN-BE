import { Inject, Injectable } from '@nestjs/common';
import {
  PLATFORM_AI_OPERATIONS_REPOSITORY,
  type PlatformAiOperationsRepository,
} from './platform-ai-operations.repository';

@Injectable()
export class PlatformAiOperationsService {
  constructor(
    @Inject(PLATFORM_AI_OPERATIONS_REPOSITORY)
    private readonly repository: PlatformAiOperationsRepository,
  ) {}

  getStatus() {
    return this.repository.getStatus();
  }
}
