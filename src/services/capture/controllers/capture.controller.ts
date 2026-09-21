import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { CaptureApplicationService } from '../application/capture.service';

@Controller()
export class CaptureController {
  constructor(private readonly service: CaptureApplicationService) {}

  @MessagePattern('capture.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
