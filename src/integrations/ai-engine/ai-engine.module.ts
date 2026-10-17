import { Module } from '@nestjs/common';
import { IamModule } from '../../services/iam/iam.module';
import { AiEngineController } from './ai-engine.controller';
import { AiEngineAuthController } from './ai-engine-auth.controller';
import { AI_ENGINE_CLIENT } from './ai-engine.port';
import { HttpAiEngineClient } from './http-ai-engine.client';

/** Provider-neutral boundary for the external FastAPI/SAG service. */
@Module({
  imports: [IamModule],
  controllers: [AiEngineController, AiEngineAuthController],
  providers: [{ provide: AI_ENGINE_CLIENT, useClass: HttpAiEngineClient }],
})
export class AiEngineModule {}
