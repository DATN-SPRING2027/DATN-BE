import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { JiraApplicationService } from '../application/jira.service';

@Controller()
export class JiraController {
  constructor(private readonly service: JiraApplicationService) {}

  @MessagePattern('jira.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
