import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { JiraApplicationService } from './application/jira.service';
import { JiraController } from './controllers/jira.controller';
import { JiraInfrastructureModule } from './infrastructure/jira.infrastructure.module';
import { PlatformIntegrationReadService } from './application/platform-integration-read.service';
import { PLATFORM_INTEGRATION_READ_REPOSITORY } from './application/platform-integration-read.repository';
import { MongoPlatformIntegrationReadRepository } from './infrastructure/platform-integration-read.repository';
import { PlatformServiceOperationsGuard } from './controllers/platform-service-operations.guard';
import { JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER } from './application/platform-integration-operations.repository';
import { PlatformIntegrationOperationsService } from './application/platform-integration-operations.service';
import { UnavailableJiraPlatformIntegrationOperationsProvider } from './infrastructure/unavailable-platform-integration-operations.provider';

@Module({
  imports: [RuntimeConfigModule, JiraInfrastructureModule.register()],
  controllers: [JiraController],
  providers: [
    JiraApplicationService,
    PlatformIntegrationReadService,
    PlatformIntegrationOperationsService,
    PlatformServiceOperationsGuard,
    UnavailableJiraPlatformIntegrationOperationsProvider,
    {
      provide: JIRA_PLATFORM_INTEGRATION_OPERATIONS_PROVIDER,
      useExisting: UnavailableJiraPlatformIntegrationOperationsProvider,
    },
    MongoPlatformIntegrationReadRepository,
    {
      provide: PLATFORM_INTEGRATION_READ_REPOSITORY,
      useExisting: MongoPlatformIntegrationReadRepository,
    },
  ],
})
export class JiraModule {}
