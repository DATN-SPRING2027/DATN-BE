import { IamModule } from './iam.module';
import { bootstrapService } from '../service-bootstrap';

if (
  !process.env.IAM_GATEWAY_SECRET ||
  process.env.IAM_GATEWAY_SECRET.length < 32
) {
  throw new Error('IAM_GATEWAY_SECRET is required for standalone IAM');
}

void bootstrapService(IamModule);
