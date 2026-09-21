import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { HandoverApplicationService } from '../application/handover.service';

@Controller()
export class HandoverController {
  constructor(private readonly service: HandoverApplicationService) {}

  @MessagePattern('handover.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
