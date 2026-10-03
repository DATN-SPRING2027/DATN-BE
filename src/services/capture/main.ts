import { CaptureModule } from './capture.module';
import { bootstrapService } from '../service-bootstrap';
import { CAPTURE_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(CaptureModule, CAPTURE_PERSISTENCE);
