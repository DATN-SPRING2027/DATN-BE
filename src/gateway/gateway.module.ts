import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '../config/env.validation';
import { MetricsModule } from '../common/observability/metrics.module';
import { GatewayHealthController } from './gateway-health.controller';
import { GatewayIamController } from './gateway-iam.controller';
import { GatewayChatController } from './gateway-chat.controller';
import { GatewayTaskWorkspaceController } from './gateway-task-workspace.controller';
import { GatewayCaptureController } from './gateway-capture.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    MetricsModule,
  ],
  controllers: [
    GatewayHealthController,
    GatewayIamController,
    GatewayChatController,
    GatewayTaskWorkspaceController,
    GatewayCaptureController,
  ],
})
export class GatewayModule {}
