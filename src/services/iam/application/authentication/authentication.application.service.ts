import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AccessTokenError, AccessTokenService } from './access-token.service';
import type { AccessTokenClaims } from './access-token.types';
import {
  AUTH_SECURITY_STORE,
  type AuthSecurityStore,
} from './auth-security.store';
import {
  AUTHENTICATION_REPOSITORY,
  type AuthenticationAccount,
  type AuthenticationRepositoryPort,
  type NewRefreshSession,
  type RefreshSessionContext,
} from './authentication.repository';
import { LOGIN_ELIGIBILITY_POLICY } from './login-eligibility.policy';
import type { LoginEligibilityPolicy } from './login-eligibility.policy';
import { ORGANIZATION_CONTEXT_RESOLVER } from './organization-context.resolver';
import type { OrganizationContextResolver } from './organization-context.resolver';
import { PasswordCredentialService } from '../credentials/password-credential.service';
import { PasswordHashFormatError } from '../credentials/password-credential.service';
import {
  AUTHORIZATION_EVIDENCE_PROVIDER,
  type AuthorizationEvidenceProvider,
} from '../authorization/authorization-evidence.provider';
import {
  AuthorizationPolicy,
  PLATFORM_PERMISSIONS,
} from '../authorization/authorization.policy';

export interface LoginInput {
  email: string;
  password: string;
  organizationId?: string;
  sourceIp?: string;
}

export interface AuthenticatedIdentity {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  roles: string[];
}

export interface AuthenticatedPlatformSubject {
  id: string;
  email: string;
  name: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: AuthenticatedIdentity;
}

export interface PlatformLoginResult {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  user: AuthenticatedPlatformSubject;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export class RefreshCsrfError extends Error {
  constructor() {
    super('Refresh CSRF comparison failed');
    this.name = RefreshCsrfError.name;
  }
}

const REFRESH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function validCsrfPair(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (
    !cookieValue ||
    !headerValue ||
    cookieValue.length > 4096 ||
    headerValue.length > 4096
  )
    return false;
  const cookieBytes = Buffer.from(cookieValue);
  const headerBytes = Buffer.from(headerValue);
  return (
    cookieBytes.length === headerBytes.length &&
    timingSafeEqual(cookieBytes, headerBytes)
  );
}

function validRefreshCredential(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'AUTHENTICATION_FAILED',
    message: 'Authentication failed.',
  });
}

export function readCookie(
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

function extractRefreshTokens(cookieHeader: string | undefined): string[] {
  const tokens = [
    readCookie(cookieHeader, '__Secure-refresh'),
    readCookie(cookieHeader, 'continuum_refresh'),
  ];
  return [...new Set(tokens.filter(validRefreshCredential))];
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
    @Inject(AUTHORIZATION_EVIDENCE_PROVIDER)
    private readonly authorizationEvidence: AuthorizationEvidenceProvider,
    private readonly authorizationPolicy: AuthorizationPolicy,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const { account, needsRehash } = await this.authenticateCredentials(input);
    const organization = await this.organizationResolver.resolveForUser(
      account.userId,
      input.organizationId,
    );
    if (organization.outcome === 'ORGANIZATION_SELECTION_REQUIRED') {
      throw new ConflictException({
        code: 'ORGANIZATION_SELECTION_REQUIRED',
        message: 'Select an organization to continue.',
        details: { organizations: organization.organizations },
      });
    }
    if (organization.outcome !== 'RESOLVED') throw unauthorized();

    await this.rehashPasswordIfNeeded(account, input.password, needsRehash);
    const identity: AuthenticatedIdentity = {
      id: account.userId,
      email: account.email,
      name: account.name,
      organizationId: organization.context.orgId,
      roles: organization.context.roles,
    };
    const credentials = await this.issueSession(
      account.userId,
      'ORGANIZATION',
      {
        sub: identity.id,
        email: identity.email,
        orgId: identity.organizationId,
        roles: identity.roles,
      },
    );
    return { ...credentials, user: identity };
  }

  async loginPlatform(input: LoginInput): Promise<PlatformLoginResult> {
    const { account, needsRehash } = await this.authenticateCredentials(input);
    if (
      !(await this.hasActivePlatformAssignment(account.userId, account.status))
    )
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Insufficient authorization.',
      });

    await this.rehashPasswordIfNeeded(account, input.password, needsRehash);
    const identity: AuthenticatedPlatformSubject = {
      id: account.userId,
      email: account.email,
      name: account.name,
    };
    const credentials = await this.issueSession(account.userId, 'PLATFORM', {
      sub: identity.id,
      email: identity.email,
      context: 'PLATFORM',
    });
    return { ...credentials, user: identity };
  }

  private async authenticateCredentials(
    input: LoginInput,
  ): Promise<{ account: AuthenticationAccount; needsRehash: boolean }> {
    const emailKey = createHash('sha256')
      .update(input.email.trim().toLowerCase())
      .digest('hex');
    const sourceKey = createHash('sha256')
      .update(input.sourceIp ?? 'unknown')
      .digest('hex');
    if (
      !(await this.securityStore.consumeRateLimit(
        `auth:login:source:${sourceKey}`,
        300,
        900,
      ))
    ) {
      throw new HttpException(
        { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts.' },
        429,
      );
    }
    const account = await this.repository.findAccountByEmail(input.email);
    if (!account) return this.rejectInvalidPassword(emailKey);

    let verification: { verified: boolean; needsRehash: boolean };
    try {
      verification = await this.credentials.verifyPassword(
        account.passwordHash,
        input.password,
      );
    } catch (error) {
      if (error instanceof PasswordHashFormatError)
        return this.rejectInvalidPassword(emailKey);
      throw error;
    }
    if (!verification.verified) return this.rejectInvalidPassword(emailKey);
    await this.securityStore.clearRateLimit(`auth:login:account:${emailKey}`);

    const eligibility = this.eligibilityPolicy.evaluate({
      userStatus: account.status,
    });
    if (eligibility.outcome !== 'ELIGIBLE' || account.twoFactorEnabled) {
      // MFA is intentionally not implemented in this slice. Do not let a
      // password-only flow bypass an account's existing MFA flag.
      throw unauthorized();
    }

    return { account, needsRehash: verification.needsRehash };
  }

  private async rehashPasswordIfNeeded(
    account: AuthenticationAccount,
    password: string,
    needsRehash: boolean,
  ): Promise<void> {
    if (!needsRehash) return;
    const replacementHash = await this.credentials.hashPassword(password);
    await this.repository.replacePasswordHashIfCurrent(
      account.userId,
      account.passwordHash,
      replacementHash,
    );
  }

  private async issueSession(
    userId: string,
    context: RefreshSessionContext,
    claims:
      | { sub: string; email: string; orgId: string; roles: string[] }
      | { sub: string; email: string; context: 'PLATFORM' },
  ): Promise<{ accessToken: string; refreshToken: string; csrfToken: string }> {
    const refreshToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionTokenHash = createHash('sha256')
      .update(refreshToken)
      .digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
    let session: NewRefreshSession;
    if (context === 'ORGANIZATION') {
      if (!('orgId' in claims))
        throw new Error('Organization login has no Organization claims');
      session = {
        userId,
        context,
        organizationId: claims.orgId,
        tokenHash: sessionTokenHash,
        expiresAt,
      };
    } else {
      if (!('context' in claims) || claims.context !== 'PLATFORM')
        throw new Error('Platform login has no Platform token context');
      session = {
        userId,
        context,
        tokenHash: sessionTokenHash,
        expiresAt,
      };
    }
    await this.repository.createRefreshSession(session);
    const accessToken = this.accessTokens.signAccessToken(claims);
    return { accessToken, refreshToken, csrfToken };
  }

  private async hasActivePlatformAssignment(
    userId: string,
    status: string,
  ): Promise<boolean> {
    const now = new Date();
    for (const permission of PLATFORM_PERMISSIONS) {
      const evidence = await this.authorizationEvidence.loadPlatformPermission(
        userId,
        permission,
      );
      if (
        evidence &&
        this.authorizationPolicy.evaluatePlatformPermission({
          permission,
          subject: { userId, status },
          assignments: evidence.assignments,
          now,
        }).allowed
      )
        return true;
    }
    return false;
  }

  private async rejectInvalidPassword(emailKey: string): Promise<never> {
    const allowed = await this.securityStore.consumeRateLimit(
      `auth:login:account:${emailKey}`,
      5,
      900,
    );
    if (!allowed) {
      throw new HttpException(
        { code: 'LOGIN_RATE_LIMITED', message: 'Too many login attempts.' },
        429,
      );
    }
    throw unauthorized();
  }

  async getCurrentIdentity(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedIdentity> {
    const { claims, profile } = await this.getVerifiedActiveSubject(
      authorization,
      cookieHeader,
    );
    if (claims.context === 'PLATFORM') throw unauthorized();

    const activeMembershipIds =
      await this.repository.findActiveOrganizationMembershipIds(claims.sub);
    if (!activeMembershipIds.includes(claims.orgId)) throw unauthorized();

    return {
      id: claims.sub,
      email: claims.email,
      name: profile.name,
      organizationId: claims.orgId,
      roles: claims.roles,
    };
  }

  /**
   * Authenticates the Human User for PLATFORM-scoped APIs without treating an
   * Organization membership or role claim as part of platform authority.
   * Permission and lifecycle evidence is evaluated separately by the platform
   * authorization guard on every request.
   */
  async getCurrentPlatformSubject(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<AuthenticatedPlatformSubject> {
    const { claims, profile } = await this.getVerifiedActiveSubject(
      authorization,
      cookieHeader,
    );
    return { id: claims.sub, email: claims.email, name: profile.name };
  }

  private async getVerifiedActiveSubject(
    authorization: string | undefined,
    cookieHeader: string | undefined,
  ): Promise<{
    claims: AccessTokenClaims;
    profile: NonNullable<
      Awaited<ReturnType<AuthenticationRepositoryPort['findProfileById']>>
    >;
  }> {
    const token = extractAccessToken(authorization, cookieHeader);
    if (!token) throw unauthorized();

    let claims: AccessTokenClaims;
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
    return { claims, profile };
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
    for (const refreshToken of extractRefreshTokens(cookieHeader)) {
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await this.repository.revokeRefreshSessionByHash(tokenHash);
    }
  }

  async refresh(
    refreshToken: string | undefined,
    csrfCookie: string | undefined,
    csrfHeader: string | undefined,
  ): Promise<RefreshResult> {
    // The HTTP response for a CSRF failure remains an A-01 TBD.
    if (!validCsrfPair(csrfCookie, csrfHeader)) throw new RefreshCsrfError();
    if (!validRefreshCredential(refreshToken)) {
      throw unauthorized();
    }
    const currentHash = createHash('sha256').update(refreshToken).digest('hex');
    const current =
      await this.repository.findRefreshSessionForRotation(currentHash);
    if (current.outcome === 'INVALID') throw unauthorized();

    const now = new Date();
    const replacement = randomBytes(32).toString('base64url');
    if (current.outcome === 'REVOKED') {
      // Preserve the approved replay response: the repository atomically
      // invalidates the user's remaining sessions and returns REPLAYED.
      await this.repository.rotateRefreshSession(
        currentHash,
        createHash('sha256').update(replacement).digest('hex'),
        new Date(now.getTime() + REFRESH_LIFETIME_MS),
        now,
      );
      throw unauthorized();
    }
    if (current.expiresAt.getTime() <= now.getTime()) throw unauthorized();

    const account = await this.repository.findAccountById(current.userId);
    if (!account || account.status !== 'ACTIVE' || account.twoFactorEnabled) {
      throw unauthorized();
    }
    let accessToken: string;
    if (current.context === 'PLATFORM') {
      if (
        !(await this.hasActivePlatformAssignment(
          current.userId,
          account.status,
        ))
      )
        throw unauthorized();
      accessToken = this.accessTokens.signAccessToken({
        sub: current.userId,
        email: account.email,
        context: 'PLATFORM',
      });
    } else {
      const organization = await this.organizationResolver.resolveForUser(
        current.userId,
        current.organizationId,
      );
      if (organization.outcome !== 'RESOLVED') throw unauthorized();
      // Finish all fallible eligibility/context work and signing before token
      // state changes. A later failure therefore cannot strand an unissued hash.
      accessToken = this.accessTokens.signAccessToken({
        sub: current.userId,
        email: account.email,
        orgId: current.organizationId,
        roles: organization.context.roles,
      });
    }
    const rotation = await this.repository.rotateRefreshSession(
      currentHash,
      createHash('sha256').update(replacement).digest('hex'),
      new Date(now.getTime() + REFRESH_LIFETIME_MS),
      now,
    );
    if (rotation.outcome !== 'ROTATED') throw unauthorized();
    return { accessToken, refreshToken: replacement };
  }
}
