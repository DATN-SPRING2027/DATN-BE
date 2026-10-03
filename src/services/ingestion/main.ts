import { IngestionModule } from './ingestion.module';
import { bootstrapService } from '../service-bootstrap';
import { INGESTION_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(IngestionModule, INGESTION_PERSISTENCE);
