import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PlatformAuthorityChangeCommand } from './platform-authority-change.types';

export const PLATFORM_AUTHORITY_CHANGE_AUTHORIZATION = Symbol(
  'PLATFORM_AUTHORITY_CHANGE_AUTHORIZATION',
);

/**
 * Validates the trusted authorization context for a platform authority change.
 * Implementations must verify the issuer workflow and fresh MFA evidence from
 * trusted authentication context; command booleans are not evidence.
 */
export interface PlatformAuthorityChangeAuthorizationPolicy {
  assertAuthorized(command: PlatformAuthorityChangeCommand): Promise<void>;
}

/**
 * The issuer workflow and trusted MFA proof are not yet defined by DEC-ACCESS-09.
 * Keep the mutation path unavailable until an approved policy is implemented.
 */
@Injectable()
export class UnconfiguredPlatformAuthorityChangeAuthorizationPolicy implements PlatformAuthorityChangeAuthorizationPolicy {
  assertAuthorized(_command: PlatformAuthorityChangeCommand): Promise<void> {
    void _command;
    return Promise.reject(
      new ServiceUnavailableException({
        code: 'PLATFORM_AUTHORITY_WORKFLOW_UNAVAILABLE',
        message:
          'Platform authority changes are disabled until an approved issuer and MFA workflow is configured.',
      }),
    );
  }
}
