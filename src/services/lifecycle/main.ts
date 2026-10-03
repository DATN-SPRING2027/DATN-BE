import { LifecycleModule } from './lifecycle.module';
import { bootstrapService } from '../service-bootstrap';
import { LIFECYCLE_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(LifecycleModule, LIFECYCLE_PERSISTENCE);
