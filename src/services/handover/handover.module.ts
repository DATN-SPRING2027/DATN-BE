import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { AiEngineModule } from '../../integrations/ai-engine/ai-engine.module';
import { CaptureModule } from '../capture/capture.module';
import { IamModule } from '../iam/iam.module';
import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { HandoverAiService } from './application/handover-ai.service';
import { HandoverRepository } from './application/handover.repository';
import { HandoverApplicationService } from './application/handover.service';
import { HandoverSourcesService } from './application/handover-sources.service';
import { HandoverTransferService } from './application/handover-transfer.service';
import { HandoverWorkflowService } from './application/handover-workflow.service';
import { HandoverWorkflowController } from './controllers/handover-workflow.controller';
import { HandoverController } from './controllers/handover.controller';
import { HandoverInfrastructureModule } from './infrastructure/handover.infrastructure.module';

@Module({
  imports: [
    RuntimeConfigModule,
    HandoverInfrastructureModule.register(),
    IamModule,
    CaptureModule,
    LifecycleModule,
    AiEngineModule,
  ],
  controllers: [HandoverController, HandoverWorkflowController],
  providers: [
    HandoverApplicationService,
    HandoverRepository,
    HandoverSourcesService,
    HandoverAiService,
    HandoverTransferService,
    HandoverWorkflowService,
  ],
  exports: [HandoverWorkflowService, HandoverAiService],
})
export class HandoverModule {}
