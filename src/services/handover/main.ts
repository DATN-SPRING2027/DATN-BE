import { HandoverModule } from './handover.module';
import { bootstrapService } from '../service-bootstrap';
import { HANDOVER_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(HandoverModule, HANDOVER_PERSISTENCE);
