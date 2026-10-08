import { Injectable } from '@nestjs/common';
import { HealthResponse } from '../../../health/health.response';

@Injectable()
export class IamApplicationService {
  /** Reports IAM process liveness only; it does not probe dependency readiness. */
  getHealth(): HealthResponse {
    return { status: 'ok' };
  }
}
