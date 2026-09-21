import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { NotificationApplicationService } from '../application/notification.service';

@Controller()
export class NotificationController {
  constructor(private readonly service: NotificationApplicationService) {}

  @MessagePattern('notification.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
