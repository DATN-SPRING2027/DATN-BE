import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MessagePattern } from '@nestjs/microservices';
import { BACKEND_PATTERNS } from '../contracts/internal/backend.contract';
import { HealthResponse } from './health.response';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get()
  @MessagePattern(BACKEND_PATTERNS.health)
  @ApiOperation({ summary: 'Check whether backend-core is running' })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
