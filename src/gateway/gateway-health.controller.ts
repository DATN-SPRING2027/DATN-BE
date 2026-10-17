import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthResponse } from '../health/health.response';

@ApiTags('Health')
@Controller('health')
export class GatewayHealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({ summary: 'Check whether the backend service is reachable' })
  @ApiOkResponse({ type: HealthResponse })
  async getHealth(): Promise<HealthResponse> {
    return this.requestServiceHealth();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check whether gateway dependencies are ready' })
  @ApiOkResponse({ type: HealthResponse })
  async getReadiness(): Promise<HealthResponse> {
    return this.requestServiceHealth();
  }

  private async requestServiceHealth(): Promise<HealthResponse> {
    const url = `${this.config
      .getOrThrow<string>('IAM_SERVICE_URL')
      .replace(/\/$/, '')}/internal/health`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(
        this.config.getOrThrow<number>('BACKEND_TIMEOUT_MS'),
      ),
    });

    if (!response.ok) {
      throw new Error(`IAM service returned HTTP ${response.status}`);
    }

    return (await response.json()) as HealthResponse;
  }
}
