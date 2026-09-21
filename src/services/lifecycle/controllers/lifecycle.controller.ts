import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { LifecycleApplicationService } from '../application/lifecycle.service';

@Controller()
export class LifecycleController {
  constructor(private readonly service: LifecycleApplicationService) {}

  @MessagePattern('lifecycle.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
