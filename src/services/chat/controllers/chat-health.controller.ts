import { Controller, Get } from '@nestjs/common';
import { MessagePattern } from '@nestjs/microservices';
import { HealthResponse } from '../../../health/health.response';
import { ChatApplicationService } from '../application/chat.service';

@Controller()
export class ChatHealthController {
  constructor(private readonly service: ChatApplicationService) {}

  @MessagePattern('chat.health')
  @Get('health')
  getHealth(): HealthResponse {
    return this.service.getHealth();
  }
}
