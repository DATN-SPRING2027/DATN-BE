import {
  ConflictException,
  Inject,
  Injectable,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessTokenError, AccessTokenService } from './access-token.service';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from './auth-security.store';
import {
  AUTHENTICATION_REPOSITORY,
  type AuthenticationRepositoryPort,
} from './authentication.repository';
import { LOGIN_ELIGIBILITY_POLICY } from './login-eligibility.policy';
import type { LoginEligibilityPolicy } from './login-eligibility.policy';
import { ORGANIZATION_CONTEXT_RESOLVER } from './organization-context.resolver';
import type { OrganizationContextResolver } from './organization-context.resolver';
import { PasswordCredentialService } from '../credentials/password-credential.service';
import { PasswordHashFormatError } from '../credentials/password-credential.service';

export interface LoginInput {
  email: string;
  password: string;
  organizationId?: string;
}

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  roles: string[];
}

export interface LoginResult {
  accessToken: string;
  user: AuthenticatedIdentity;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'AUTHENTICATION_FAILED',
    message: 'Authentication failed.',
  });
}

function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;

  const values = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) return undefined;

  try {
    return decodeURIComponent(values[0]);
  } catch {
    return undefined;
  }
}

export function extractAccessToken(
  authorization: string | undefined,
  cookieHeader: string | undefined,
): string | undefined {
  if (authorization !== undefined) {
    if (authorization.length > 8200) return undefined;
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization);
    return match?.[1];
  }

  const token = readCookie(cookieHeader, 'continuum_access');
  return token && token.length <= 8192 ? token : undefined;
}

function extractRefreshToken(
  cookieHeader: string | undefined,
): string | undefined {
  const token = readCookie(cookieHeader, 'continuum_refresh');
  return token && token.length <= 4096 ? token : undefined;
}

@Injectable()
export class AuthenticationApplicationService {
  constructor(
    @Inject(AUTHENTICATION_REPOSITORY)
    private readonly repository: AuthenticationRepositoryPort,
    @Inject(LOGIN_ELIGIBILITY_POLICY)
    private readonly eligibilityPolicy: LoginEligibilityPolicy,
    @Inject(ORGANIZATION_CONTEXT_RESOLVER)
    private readonly organizationResolver: OrganizationContextResolver,
    private readonly credentials: PasswordCredentialService,
    private readonly accessTokens: AccessTokenService,
    @Inject(AUTH_SECURITY_STORE)
    private readonly securityStore: AuthSecurityStore,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const emailKey = createHash('sha256')
      .update(input.email.trim().toLowerCase())
      .digest('hex');
    if (
      !(await this.securityStore.consumeRateLimit(
        `auth:login:${emailKey}`,
        5,
        900,
      ))
    ) {
      throw new HttpException(
        { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts.' },
        429,
      );
    }
    const account = await this.repository.findAccountByEmail(input.email);
    if (!account) throw unauthorized();

    let verification: { verified: boolean; needsRehash: boolean };
    try {
      verification = await this.credentials.verifyPassword(
        account.passwordHash,
        input.password,
      );
    } catch (error) {
      if (error instanceof PasswordHashFormatError) throw unauthorized();
      throw error;
    }
    if (!verification.verified) throw unauthorized();
    await this.securityStore.clearRateLimit(`auth:login:${emailKey}`);

    const eligibility = this.eligibilityPolicy.evaluate({
      userStatus: account.status,
    });
    if (eligibility.outcome !== 'ELIGIBLE' || account.twoFactorEnabled) {
      // MFA is intentionally not implemented in this slice. Do not let a
      // password-only flow bypass an account's existing MFA flag.
      throw unauthorized();
    }

    const organization = await this.organizationResolver.resolveForUser(
      account.userId,
      input.organizationId,
    );
    if (organization.outcome === 'ORGANIZATION_SELECTION_REQUIRED') {
      throw new ConflictException({
        code: 'ORGANIZATION_SELECTION_REQUIRED',
        message: 'Select an organization to continue.',
      });
    }
    if (organization.outcome !== 'RESOLVED') throw unauthorized();

    if (verification.needsRehash) {
      const replacementHash = await this.credentials.hashPassword(
        input.password,
      );
      await this.repository.replacePasswordHashIfCurrent(
        account.userId,
        account.passwordHash,
        replacementHash,
      );
    }

    const identity: AuthenticatedIdentity = {
      id: account.userId,
      email: account.email,
      name: account.name,
      organizationId: organization.context.orgId,
      roles: organization.context.roles,
    };
    const accessToken = this.accessTokens.signAccessToken({
      sub: identity.id,
      email: identity.email,
      orgId: identity.organizationId,
      roles: identity.roles,
    });

    return { accessToken, user: identity };
  }

  async getCurrentIdentity(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedIdentity> {
    const token = extractAccessToken(authorization, cookieHeader);
    if (!token) throw unauthorized();

    let claims;
    try {
      claims = this.accessTokens.verifyAccessToken(token);
    } catch (error) {
      if (error instanceof AccessTokenError) throw unauthorized();
      throw error;
    }

    if (
      await this.securityStore.isTokenRevoked(
        createHash('sha256').update(token).digest('hex'),
      )
    ) {
      throw unauthorized();
    }

    const profile = await this.repository.findProfileById(claims.sub);
    if (!profile || profile.status !== 'ACTIVE') throw unauthorized();

    return {
      id: claims.sub,
      email: claims.email,
      name: profile.name,
      organizationId: claims.orgId,
      roles: claims.roles,
    };
  }

  async logout(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<void> {
    const accessToken = extractAccessToken(authorization, cookieHeader);
    if (accessToken) {
      try {
        const claims = this.accessTokens.verifyAccessToken(accessToken);
        const remainingSeconds = claims.exp - Math.floor(Date.now() / 1000);
        if (remainingSeconds > 0) {
          await this.securityStore.revokeToken(
            createHash('sha256').update(accessToken).digest('hex'),
            remainingSeconds,
          );
        }
      } catch (error) {
        if (!(error instanceof AccessTokenError)) throw error;
      }
    }
    const refreshToken = extractRefreshToken(cookieHeader);
    if (!refreshToken) return;

    const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
    await this.repository.revokeRefreshSessionByHash(tokenHash);
  }
}
