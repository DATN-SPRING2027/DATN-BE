import { Module } from '@nestjs/common';
import { RuntimeConfigModule } from '../../config/runtime-config.module';
import { IamApplicationService } from './application/iam.service';
import { IamController } from './controllers/iam.controller';
import { IamInfrastructureModule } from './infrastructure/iam.infrastructure.module';

@Module({
  imports: [RuntimeConfigModule, IamInfrastructureModule.register()],
  controllers: [IamController],
  providers: [IamApplicationService],
})
export class IamModule {}
