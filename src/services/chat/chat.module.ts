import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { ChatApplicationService } from './application/chat.service';
import { ChatController } from './controllers/chat.controller';
import { ChatInfrastructureModule } from './infrastructure/chat.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, ChatInfrastructureModule.register()],
  controllers: [ChatController],
  providers: [ChatApplicationService],
})
export class ChatModule {}
