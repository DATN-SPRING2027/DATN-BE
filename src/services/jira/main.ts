import { JiraModule } from './jira.module';
import { bootstrapService } from '../service-bootstrap';
import { JIRA_PERSISTENCE } from './infrastructure/persistence';

void bootstrapService(JiraModule, JIRA_PERSISTENCE);
