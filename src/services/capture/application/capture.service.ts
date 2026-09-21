import { Injectable } from '@nestjs/common';
import { HealthResponse } from '../../../health/health.response';

@Injectable()
export class CaptureApplicationService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
