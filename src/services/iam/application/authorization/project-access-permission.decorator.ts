import { SetMetadata } from '@nestjs/common';
import type { ProjectAccessPermission } from './authorization.policy';

export const PROJECT_ACCESS_PERMISSION = 'iam.project.access.permission';

export const RequireProjectAccessPermission = (
  permission: ProjectAccessPermission,
) => SetMetadata(PROJECT_ACCESS_PERMISSION, permission);
