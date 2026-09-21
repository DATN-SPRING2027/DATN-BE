import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { IngestionApplicationService } from '../application/ingestion.service';

@Controller()
export class IngestionController {
  constructor(private readonly service: IngestionApplicationService) {}

  @MessagePattern('ingestion.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
