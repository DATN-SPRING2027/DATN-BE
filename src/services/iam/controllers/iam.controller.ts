import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { IamApplicationService } from '../application/iam.service';

@Controller()
export class IamController {
  constructor(private readonly service: IamApplicationService) {}

  @MessagePattern('iam.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
