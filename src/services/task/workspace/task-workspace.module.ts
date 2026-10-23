import { Module } from '@nestjs/common';
import { IamModule } from '../../iam/iam.module';

@Module({
  imports: [IamModule],
  exports: [IamModule],
})
export class TaskWorkspaceModule {}
