import { ChatModule } from './chat.module';
import { bootstrapService } from '../service-bootstrap';
import { CHAT_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(ChatModule, CHAT_PERSISTENCE);
