import { Module } from '@nestjs/common';
import { AiEngineModule } from '../integrations/ai-engine/ai-engine.module';
import { CaptureModule } from '../services/capture/capture.module';
import { ChatModule } from '../services/chat/chat.module';
import { HandoverModule } from '../services/handover/handover.module';
import { IamModule } from '../services/iam/iam.module';
import { McpToolsService } from './mcp-tools.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [
    IamModule,
    CaptureModule,
    HandoverModule,
    AiEngineModule,
    ChatModule,
  ],
  controllers: [McpController],
  providers: [McpToolsService, McpService],
  exports: [McpService, McpToolsService],
})
export class McpModule {}
