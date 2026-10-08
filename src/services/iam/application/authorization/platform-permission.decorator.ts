import { SetMetadata } from '@nestjs/common';
import type { PlatformPermission } from './authorization.policy';

export const PLATFORM_PERMISSION = Symbol('PLATFORM_PERMISSION');

export const RequirePlatformPermission = (permission: PlatformPermission) =>
  SetMetadata(PLATFORM_PERMISSION, permission);
