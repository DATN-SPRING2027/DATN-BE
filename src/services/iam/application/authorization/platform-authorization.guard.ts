import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticationApplicationService } from '../authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type AuthorizationEvidenceProvider,
} from './authorization-evidence.provider';
import { PLATFORM_PERMISSION } from './platform-permission.decorator';
import type { PlatformPermission } from './authorization.policy';
import { AuthorizationPolicy } from './authorization.policy';

@Injectable()
export class PlatformAuthorizationGuard implements CanActivate {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    @Inject(AUTHORIZATION_EVIDENCE_PROVIDER)
    private readonly evidence: AuthorizationEvidenceProvider,
    private readonly policy: AuthorizationPolicy,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.getAllAndOverride<PlatformPermission>(
      PLATFORM_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) throw new ForbiddenException();

    const request = context.switchToHttp().getRequest<Request>();
    const identity = await this.authentication.getCurrentPlatformSubject(
      request.headers.authorization,
      request.headers.cookie,
    );
    let facts: Awaited<
      ReturnType<AuthorizationEvidenceProvider['loadPlatformPermission']>
    >;
    try {
      facts = await this.evidence.loadPlatformPermission(
        identity.id,
        permission,
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'AUTHORIZATION_EVIDENCE_UNAVAILABLE',
        message: 'Authorization evidence is temporarily unavailable.',
      });
    }

    if (
      facts &&
      this.policy.evaluatePlatformPermission({
        permission,
        subject: { userId: identity.id, status: 'ACTIVE' },
        assignments: facts.assignments,
        now: new Date(),
      }).allowed
    )
      return true;

    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'Insufficient authorization.',
    });
  }
}
