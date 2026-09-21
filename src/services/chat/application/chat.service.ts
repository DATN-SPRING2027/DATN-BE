import { Injectable } from '@nestjs/common';
import { HealthResponse } from '../../../health/health.response';

@Injectable()
export class ChatApplicationService {
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
