import { Module } from '@nestjs/common';
import { IamModule } from '../../services/iam/iam.module';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiEngineController } from './ai-engine.controller';
import { AiEngineAuthController } from './ai-engine-auth.controller';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import { HttpAiEngineClient } from './http-ai-engine.client';
import { PlatformAiFeedbackController } from './platform-ai-feedback.controller';

@Module({
  imports: [IamModule],
  controllers: [
    AiEngineController,
    AiEngineAuthController,
    AiChatController,
    PlatformAiFeedbackController,
  ],
  providers: [
    { provide: AI_ENGINE_CLIENT, useClass: HttpAiEngineClient },
    AiChatService,
  ],
  exports: [AI_ENGINE_CLIENT],
})
export class AiEngineModule {}
