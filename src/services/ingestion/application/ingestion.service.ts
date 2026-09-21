import { Injectable } from '@nestjs/common';
import { HealthResponse } from '../../../health/health.response';

@Injectable()
export class IngestionApplicationService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
