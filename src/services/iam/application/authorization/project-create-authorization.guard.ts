import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthenticationApplicationService } from '../authentication/authentication.application.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type AuthorizationEvidenceProvider,
} from './authorization-evidence.provider';
import { AuthorizationPolicy } from './authorization.policy';

type ScopedRequest = Request & {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
};

@Injectable()
export class ProjectCreateAuthorizationGuard implements CanActivate {
  constructor(
    private readonly authentication: AuthenticationApplicationService,
    @Inject(AUTHORIZATION_EVIDENCE_PROVIDER)
    private readonly evidence: AuthorizationEvidenceProvider,
    private readonly policy: AuthorizationPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    const identity = await this.authentication.getCurrentIdentity(
      request.headers.authorization,
      request.headers.cookie,
    );

    // The existing authentication service verifies the token, active User, and
    // ACTIVE membership for this trusted Organization Context on every call.
    const selectors: unknown[] = [
      request.params?.organizationId,
      request.query?.organizationId,
      typeof request.body === 'object' && request.body !== null
        ? (request.body as Record<string, unknown>).organizationId
        : undefined,
    ];
    if (
      selectors.some(
        (value) => value !== undefined && value !== identity.organizationId,
      )
    ) {
      return false;
    }

    try {
      const facts = await this.evidence.loadProjectCreate(
        identity.id,
        identity.organizationId,
      );
      if (!facts) return false;
      return this.policy.evaluate({
        permission: 'project.create',
        subject: {
          userId: identity.id,
          organizationId: identity.organizationId,
          status: 'ACTIVE',
        },
        requestedOrganizationId: identity.organizationId,
        ...facts,
        now: new Date(),
      }).allowed;
    } catch {
      // Missing or failed authorization evidence cannot grant access.
      return false;
    }
  }
}
