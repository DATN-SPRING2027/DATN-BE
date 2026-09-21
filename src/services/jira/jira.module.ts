import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { JiraApplicationService } from './application/jira.service';
import { JiraController } from './controllers/jira.controller';
import { JiraInfrastructureModule } from './infrastructure/jira.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, JiraInfrastructureModule.register()],
  controllers: [JiraController],
  providers: [JiraApplicationService],
})
export class JiraModule {}
