import type { ClientSession } from 'mongoose';
import type {
  PlatformAuthorityChangeCommand,
  PlatformAuthorityChangeResult,
} from './platform-authority-change.types';

export const PLATFORM_AUTHORITY_CHANGE_REPOSITORY = Symbol(
  'PLATFORM_AUTHORITY_CHANGE_REPOSITORY',
);

export interface PlatformAuthorityChangeRepository {
  execute(
    command: PlatformAuthorityChangeCommand,
    session?: ClientSession,
  ): Promise<PlatformAuthorityChangeResult>;
}
