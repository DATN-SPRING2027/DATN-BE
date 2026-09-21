import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './env.validation';
import { MetricsModule } from '../common/observability/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: validateEnvironment,
    }),
    MetricsModule,
  ],
  exports: [ConfigModule, MetricsModule],
})
export class RuntimeConfigModule {}
