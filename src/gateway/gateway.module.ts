import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '../config/env.validation';
import { MetricsModule } from '../common/observability/metrics.module';
import { GatewayHealthController } from './gateway-health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    MetricsModule,
  ],
  controllers: [GatewayHealthController],
})
export class GatewayModule {}
