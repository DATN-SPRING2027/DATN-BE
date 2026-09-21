import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { IngestionApplicationService } from './application/ingestion.service';
import { IngestionController } from './controllers/ingestion.controller';
import { IngestionInfrastructureModule } from './infrastructure/ingestion.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, IngestionInfrastructureModule.register()],
  controllers: [IngestionController],
  providers: [IngestionApplicationService],
})
export class IngestionModule {}
