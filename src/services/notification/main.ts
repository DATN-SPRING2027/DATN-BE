import { NotificationModule } from './notification.module';
import { bootstrapService } from '../service-bootstrap';
import { NOTIFICATION_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(NotificationModule, NOTIFICATION_PERSISTENCE);
