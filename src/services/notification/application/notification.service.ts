import { Injectable } from '@nestjs/common';
import { HealthResponse } from '../../../health/health.response';

@Injectable()
export class NotificationApplicationService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
