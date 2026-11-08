import { Module } from '@nestjs/common';
import { IamModule } from '../../services/iam/iam.module';
import { CaptureModule } from '../../services/capture/capture.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiEngineController } from './ai-engine.controller';
import { AiEngineAuthController } from './ai-engine-auth.controller';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import { HttpAiEngineClient } from './http-ai-engine.client';
import { PlatformAiFeedbackController } from './platform-ai-feedback.controller';
import { AiTokenUsageController } from './ai-token-usage.controller';
import { AiTokenUsageService } from './ai-token-usage.service';

@Module({
  imports: [IamModule, CaptureModule],
  controllers: [
    AiEngineController,
    AiEngineAuthController,
    AiChatController,
    PlatformAiFeedbackController,
    AiTokenUsageController,
  ],
  providers: [
    { provide: AI_ENGINE_CLIENT, useClass: HttpAiEngineClient },
    AiChatService,
    AiTokenUsageService,
  ],
  exports: [AI_ENGINE_CLIENT, AiTokenUsageService],
})
export class AiEngineModule {}
